import { z } from "zod";
import type { Prisma, PrismaClient } from "@ecom/db";
import type { getLogger } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { assertCan, type PermissionSubject } from "../rbac/can";
import { CATALOG_TAG, CatalogError } from "./catalog-support";
import { ATTRIBUTE_TYPES, type AttributeType } from "./constants";
import { parseInput } from "./product-schemas";

/**
 * Definițiile atributelor (specificații tehnice): „Diametru” (număr, mm), „Debit” (număr, m³/h),
 * „Material” (listă). Valorile pe produse stau în `product-attributes.ts`.
 *
 * Reguli:
 * - `code` e stabil (litere mici, cifre, `_`) și NU se schimbă după creare: filtrele, importurile și
 *   feed-urile se leagă de el;
 * - **tipul nu se mai schimbă după ce atributul are valori** (ar face valorile existente fără sens):
 *   refuz cu numărul de produse; fără valori, tipul se poate schimba (unitatea și opțiunile care nu mai
 *   corespund se curăță);
 * - **unitatea** doar la numerice; **filtrabil** nu are sens la text liber;
 * - **ștergerea** unui atribut sau a unei opțiuni folosite e refuzată cu numărul de produse;
 * - scrierile cer `products.write`; citirea `products.read`. Audit pe fiecare scriere.
 */

export const ATTRIBUTE_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;
export const MAX_ATTRIBUTE_OPTIONS = 200;

export interface AttributeOptionRecord {
  id: string;
  attributeId: string;
  value: string;
  position: number;
  /** Câte produse folosesc opțiunea. */
  productCount: number;
}

export interface AttributeRecord {
  id: string;
  code: string;
  name: string;
  type: AttributeType;
  unit: string | null;
  isFilterable: boolean;
  sortOrder: number;
  options: AttributeOptionRecord[];
  /** Câte produse au o valoare pentru acest atribut. */
  productCount: number;
}

export interface NewAttributeData {
  code: string;
  name: string;
  type: AttributeType;
  unit: string | null;
  isFilterable: boolean;
  sortOrder: number;
}

export interface AttributeStore {
  list(): Promise<AttributeRecord[]>;
  get(id: string): Promise<AttributeRecord | null>;
  codeExists(code: string): Promise<boolean>;
  create(data: NewAttributeData, options: readonly string[]): Promise<AttributeRecord>;
  /** `clearOptions`: șterge toate opțiunile (la schimbarea tipului dintr-o listă). */
  update(
    id: string,
    data: Partial<Omit<NewAttributeData, "code">>,
    clearOptions: boolean,
  ): Promise<AttributeRecord>;
  delete(id: string): Promise<void>;
  getOption(optionId: string): Promise<AttributeOptionRecord | null>;
  /** Există deja o opțiune cu această valoare (fără diferență de majuscule) la atribut? */
  optionValueExists(attributeId: string, value: string, excludeOptionId?: string): Promise<boolean>;
  addOption(attributeId: string, value: string): Promise<AttributeOptionRecord>;
  renameOption(optionId: string, value: string): Promise<void>;
  deleteOption(optionId: string): Promise<void>;
  /** Pozițiile opțiunilor devin 0..n-1 în ordinea dată. */
  reorderOptions(attributeId: string, orderedIds: readonly string[]): Promise<void>;
}

const name = z.string().trim().min(1, "Numele e obligatoriu").max(100);
const unit = z.string().trim().min(1).max(20);
const optionValue = z.string().trim().min(1, "Valoarea opțiunii e obligatorie").max(100);

export const attributeCreateSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .min(1, "Codul e obligatoriu")
    .max(50)
    .regex(
      ATTRIBUTE_CODE_PATTERN,
      "Codul începe cu o literă mică și conține litere mici, cifre și _",
    ),
  name,
  type: z.enum(ATTRIBUTE_TYPES),
  unit: unit.nullable().optional(),
  isFilterable: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  options: z.array(optionValue).max(MAX_ATTRIBUTE_OPTIONS).optional(),
});

export const attributeUpdateSchema = z
  .strictObject({
    name: name.optional(),
    type: z.enum(ATTRIBUTE_TYPES).optional(),
    unit: unit.nullable().optional(),
    isFilterable: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nu a fost trimis niciun câmp de modificat",
  });

const id = z.string().min(1).max(40);

export interface AttributeServiceDeps {
  store: AttributeStore;
  audit: AuditService;
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
  logger: Pick<ReturnType<typeof getLogger>, "warn">;
}

const NOT_FOUND = () => new CatalogError("ATTRIBUTE_NOT_FOUND", "Atributul nu mai există");

const produse = (n: number): string => (n === 1 ? "1 produs" : `${n} produse`);

export class AttributeService {
  constructor(private readonly deps: AttributeServiceDeps) {}

  private async invalidate(): Promise<void> {
    try {
      await this.deps.invalidate?.([CATALOG_TAG]);
    } catch (error) {
      this.deps.logger.warn(
        { reason: error instanceof Error ? error.message : "necunoscut" },
        "catalog: invalidarea cache-ului a eșuat",
      );
    }
  }

  private async audit(
    subject: PermissionSubject,
    action: string,
    entityId: string | null,
    before?: Record<string, unknown>,
    after?: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action,
      entity: "attribute",
      entityId,
      ...(before && { before }),
      ...(after && { after }),
    });
  }

  private async mustGet(attributeId: string): Promise<AttributeRecord> {
    const found = await this.deps.store.get(attributeId);
    if (!found) throw NOT_FOUND();
    return found;
  }

  /** Toate atributele, în ordinea afișării, cu utilizarea (cere `products.read`). */
  async list(subject: PermissionSubject | null): Promise<AttributeRecord[]> {
    assertCan(subject, "products.read");
    return this.deps.store.list();
  }

  async create(subject: PermissionSubject | null, input: unknown): Promise<AttributeRecord> {
    assertCan(subject, "products.write");
    const data = parseInput(attributeCreateSchema, input);
    if (data.unit && data.type !== "number") {
      throw new CatalogError(
        "ATTRIBUTE_UNIT_INVALID",
        "Unitatea de măsură se poate pune doar la atributele numerice",
      );
    }
    if (data.isFilterable && data.type === "text") {
      throw new CatalogError(
        "ATTRIBUTE_FILTERABLE_INVALID",
        "Un atribut text liber nu poate fi filtrabil",
      );
    }
    if (data.options && data.options.length > 0 && data.type !== "select") {
      throw new CatalogError(
        "ATTRIBUTE_OPTIONS_INVALID",
        "Opțiunile se pot defini doar la atributele de tip listă",
      );
    }
    const options = dedupe(data.options ?? []);
    if (await this.deps.store.codeExists(data.code)) {
      throw new CatalogError(
        "ATTRIBUTE_CODE_CONFLICT",
        `Codul «${data.code}» e deja folosit de alt atribut. Alege alt cod`,
      );
    }
    const created = await this.deps.store.create(
      {
        code: data.code,
        name: data.name,
        type: data.type,
        unit: data.unit ?? null,
        isFilterable: data.isFilterable ?? false,
        sortOrder: data.sortOrder ?? 0,
      },
      options,
    );
    await this.audit(subject, "attribute.create", created.id, undefined, {
      code: created.code,
      name: created.name,
      type: created.type,
      options: options.length,
    });
    await this.invalidate();
    return created;
  }

  async update(
    subject: PermissionSubject | null,
    attributeId: string,
    input: unknown,
  ): Promise<AttributeRecord> {
    assertCan(subject, "products.write");
    const patch = parseInput(attributeUpdateSchema, input);
    const before = await this.mustGet(attributeId);

    const nextType = patch.type ?? before.type;
    const typeChanged = nextType !== before.type;
    if (typeChanged && before.productCount > 0) {
      throw new CatalogError(
        "ATTRIBUTE_TYPE_LOCKED",
        `Tipul nu se mai poate schimba: atributul are valori la ${produse(before.productCount)}. ` +
          `Șterge întâi valorile de pe produse sau creează un atribut nou cu tipul dorit`,
        { productCount: before.productCount },
      );
    }
    const nextUnit =
      patch.unit !== undefined ? patch.unit : nextType === "number" ? before.unit : null;
    if (nextUnit && nextType !== "number") {
      throw new CatalogError(
        "ATTRIBUTE_UNIT_INVALID",
        "Unitatea de măsură se poate pune doar la atributele numerice",
      );
    }
    const nextFilterable = patch.isFilterable ?? before.isFilterable;
    if (nextFilterable && nextType === "text") {
      throw new CatalogError(
        "ATTRIBUTE_FILTERABLE_INVALID",
        "Un atribut text liber nu poate fi filtrabil",
      );
    }

    const data: Partial<Omit<NewAttributeData, "code">> = {};
    if (patch.name !== undefined && patch.name !== before.name) data.name = patch.name;
    if (typeChanged) data.type = nextType;
    if (nextUnit !== before.unit) data.unit = nextUnit;
    if (nextFilterable !== before.isFilterable) data.isFilterable = nextFilterable;
    if (patch.sortOrder !== undefined && patch.sortOrder !== before.sortOrder) {
      data.sortOrder = patch.sortOrder;
    }
    if (Object.keys(data).length === 0) return before;

    const clearOptions = typeChanged && before.type === "select";
    const after = await this.deps.store.update(attributeId, data, clearOptions);
    await this.audit(
      subject,
      "attribute.update",
      attributeId,
      pick(before, Object.keys(data)),
      pick(after, Object.keys(data)),
    );
    await this.invalidate();
    return after;
  }

  /** Șterge atributul; refuzat cât timp are valori pe produse (cu numărul). */
  async delete(subject: PermissionSubject | null, attributeId: string): Promise<void> {
    assertCan(subject, "products.write");
    const found = await this.mustGet(attributeId);
    if (found.productCount > 0) {
      throw new CatalogError(
        "ATTRIBUTE_IN_USE",
        `Atributul «${found.name}» nu poate fi șters: e completat la ${produse(found.productCount)}. ` +
          `Șterge întâi valorile de pe produse`,
        { productCount: found.productCount },
      );
    }
    await this.deps.store.delete(attributeId);
    await this.audit(subject, "attribute.delete", attributeId, {
      code: found.code,
      name: found.name,
    });
    await this.invalidate();
  }

  async addOption(
    subject: PermissionSubject | null,
    attributeId: string,
    input: unknown,
  ): Promise<AttributeOptionRecord> {
    assertCan(subject, "products.write");
    const { value } = parseInput(z.strictObject({ value: optionValue }), input);
    const attribute = await this.mustGet(attributeId);
    if (attribute.type !== "select") {
      throw new CatalogError(
        "ATTRIBUTE_OPTIONS_INVALID",
        "Opțiunile se pot defini doar la atributele de tip listă",
      );
    }
    if (attribute.options.length >= MAX_ATTRIBUTE_OPTIONS) {
      throw new CatalogError(
        "ATTRIBUTE_OPTIONS_LIMIT",
        `Un atribut poate avea cel mult ${MAX_ATTRIBUTE_OPTIONS} opțiuni`,
      );
    }
    await this.assertOptionFree(attributeId, value);
    const created = await this.deps.store.addOption(attributeId, value);
    await this.audit(subject, "attribute.option.add", attributeId, undefined, {
      optionId: created.id,
      value,
    });
    await this.invalidate();
    return created;
  }

  async renameOption(
    subject: PermissionSubject | null,
    optionId: string,
    input: unknown,
  ): Promise<void> {
    assertCan(subject, "products.write");
    const { value } = parseInput(z.strictObject({ value: optionValue }), input);
    const option = await this.mustGetOption(optionId);
    if (option.value === value) return;
    await this.assertOptionFree(option.attributeId, value, optionId);
    await this.deps.store.renameOption(optionId, value);
    await this.audit(
      subject,
      "attribute.option.rename",
      option.attributeId,
      { optionId, value: option.value },
      { optionId, value },
    );
    await this.invalidate();
  }

  /** Șterge o opțiune; refuzată cât timp e aleasă pe produse (cu numărul). */
  async deleteOption(subject: PermissionSubject | null, optionId: string): Promise<void> {
    assertCan(subject, "products.write");
    const option = await this.mustGetOption(optionId);
    if (option.productCount > 0) {
      throw new CatalogError(
        "ATTRIBUTE_OPTION_IN_USE",
        `Opțiunea «${option.value}» nu poate fi ștearsă: e aleasă la ${produse(option.productCount)}. ` +
          `Schimbă întâi valoarea pe produsele respective`,
        { productCount: option.productCount },
      );
    }
    await this.deps.store.deleteOption(optionId);
    await this.audit(subject, "attribute.option.delete", option.attributeId, {
      optionId,
      value: option.value,
    });
    await this.invalidate();
  }

  /** Ordinea opțiunilor: lista trebuie să conțină exact opțiunile atributului. */
  async reorderOptions(
    subject: PermissionSubject | null,
    attributeId: string,
    input: unknown,
  ): Promise<void> {
    assertCan(subject, "products.write");
    const { orderedIds } = parseInput(
      z.strictObject({ orderedIds: z.array(id).max(MAX_ATTRIBUTE_OPTIONS) }),
      input,
    );
    const attribute = await this.mustGet(attributeId);
    const have = attribute.options.map((o) => o.id).sort();
    const want = [...orderedIds].sort();
    if (have.length !== want.length || have.some((v, i) => v !== want[i])) {
      throw new CatalogError(
        "ATTRIBUTE_OPTIONS_MISMATCH",
        "Lista de opțiuni s-a schimbat între timp. Reîncarcă pagina și reia",
      );
    }
    await this.deps.store.reorderOptions(attributeId, orderedIds);
    await this.audit(subject, "attribute.option.reorder", attributeId, undefined, {
      count: orderedIds.length,
    });
    await this.invalidate();
  }

  private async mustGetOption(optionId: string): Promise<AttributeOptionRecord> {
    const option = await this.deps.store.getOption(optionId);
    if (!option) {
      throw new CatalogError("ATTRIBUTE_OPTION_NOT_FOUND", "Opțiunea nu mai există");
    }
    return option;
  }

  private async assertOptionFree(
    attributeId: string,
    value: string,
    excludeOptionId?: string,
  ): Promise<void> {
    if (await this.deps.store.optionValueExists(attributeId, value, excludeOptionId)) {
      throw new CatalogError(
        "ATTRIBUTE_OPTION_DUPLICATE",
        `Opțiunea «${value}» există deja la acest atribut (nu contează majusculele)`,
      );
    }
  }
}

/** Valorile fără dubluri (fără diferență de majuscule), în ordinea primei apariții. */
function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLocaleLowerCase("ro");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function pick(record: object, keys: readonly string[]): Record<string, unknown> {
  const source = record as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = source[key];
  return out;
}

type Db = PrismaClient | Prisma.TransactionClient;

async function inTransaction<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ("$transaction" in db) return db.$transaction(fn);
  return fn(db);
}

const attributeInclude = {
  options: {
    orderBy: [{ position: "asc" }, { value: "asc" }],
    select: {
      id: true,
      attributeId: true,
      value: true,
      position: true,
      _count: { select: { values: true } },
    },
  },
  _count: { select: { values: true } },
} satisfies Prisma.AttributeInclude;

type RawAttribute = Prisma.AttributeGetPayload<{ include: typeof attributeInclude }>;

function toRecord(row: RawAttribute): AttributeRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type as AttributeType,
    unit: row.unit,
    isFilterable: row.isFilterable,
    sortOrder: row.sortOrder,
    productCount: row._count.values,
    options: row.options.map((o) => ({
      id: o.id,
      attributeId: o.attributeId,
      value: o.value,
      position: o.position,
      productCount: o._count.values,
    })),
  };
}

export function createPrismaAttributeStore(db: Db): AttributeStore {
  return {
    async list() {
      const rows = await db.attribute.findMany({
        include: attributeInclude,
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      });
      return rows.map(toRecord);
    },

    async get(id) {
      const row = await db.attribute.findUnique({ where: { id }, include: attributeInclude });
      return row ? toRecord(row) : null;
    },

    async codeExists(code) {
      return (await db.attribute.count({ where: { code } })) > 0;
    },

    async create(data, options) {
      return inTransaction(db, async (tx) => {
        const created = await tx.attribute.create({ data });
        for (const [position, value] of options.entries()) {
          await tx.attributeOption.create({
            data: { attributeId: created.id, value, position },
          });
        }
        const row = await tx.attribute.findUniqueOrThrow({
          where: { id: created.id },
          include: attributeInclude,
        });
        return toRecord(row);
      });
    },

    async update(id, data, clearOptions) {
      return inTransaction(db, async (tx) => {
        if (clearOptions) await tx.attributeOption.deleteMany({ where: { attributeId: id } });
        const row = await tx.attribute.update({
          where: { id },
          data,
          include: attributeInclude,
        });
        return toRecord(row);
      });
    },

    async delete(id) {
      await db.attribute.delete({ where: { id } });
    },

    async getOption(optionId) {
      const row = await db.attributeOption.findUnique({
        where: { id: optionId },
        select: {
          id: true,
          attributeId: true,
          value: true,
          position: true,
          _count: { select: { values: true } },
        },
      });
      return row
        ? {
            id: row.id,
            attributeId: row.attributeId,
            value: row.value,
            position: row.position,
            productCount: row._count.values,
          }
        : null;
    },

    async optionValueExists(attributeId, value, excludeOptionId) {
      const count = await db.attributeOption.count({
        where: {
          attributeId,
          value: { equals: value, mode: "insensitive" },
          ...(excludeOptionId && { id: { not: excludeOptionId } }),
        },
      });
      return count > 0;
    },

    async addOption(attributeId, value) {
      const last = await db.attributeOption.findFirst({
        where: { attributeId },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      const row = await db.attributeOption.create({
        data: { attributeId, value, position: (last?.position ?? -1) + 1 },
      });
      return {
        id: row.id,
        attributeId: row.attributeId,
        value: row.value,
        position: row.position,
        productCount: 0,
      };
    },

    async renameOption(optionId, value) {
      await db.attributeOption.update({ where: { id: optionId }, data: { value } });
    },

    async deleteOption(optionId) {
      await db.attributeOption.delete({ where: { id: optionId } });
    },

    async reorderOptions(attributeId, orderedIds) {
      await inTransaction(db, async (tx) => {
        for (const [position, optionId] of orderedIds.entries()) {
          await tx.attributeOption.update({
            where: { id: optionId, attributeId },
            data: { position },
          });
        }
      });
    },
  };
}
