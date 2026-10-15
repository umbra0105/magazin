import { z } from "zod";
import type { Prisma, PrismaClient } from "@ecom/db";
import { UnauthenticatedError, type getLogger } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { assertCan, type PermissionSubject } from "../rbac/can";
import type { AttributeRecord, AttributeStore } from "./attribute-service";
import { CATALOG_TAG, CatalogError, productCacheTags } from "./catalog-support";
import { parseDecimalInput } from "./decimal";
import { parseInput } from "./product-schemas";
import { ProductUpdateGuard } from "./product-write";

/**
 * Valorile atributelor unui produs (tabul Atribute). Reguli:
 *
 * - cere `products.write` (cheia `attributes` e „restricționată” în `ProductUpdateGuard`);
 * - **validare pe tip:** text (cel mult 500 de caractere), număr (virgulă sau punct, cel mult 4
 *   zecimale, stocat EXACT ca `NUMERIC`, fără `float`), da/nu, listă (opțiunea trebuie să aparțină
 *   atributului);
 * - **cerere parțială:** doar atributele trimise se schimbă; `null` (sau text gol) șterge valoarea;
 * - audit cu valorile înainte/după pe codul atributului (nu sunt date sensibile), nicio scriere când
 *   nu s-a schimbat nimic.
 */

export const MAX_TEXT_ATTRIBUTE_LENGTH = 500;
export const MAX_ATTRIBUTE_VALUES_PER_REQUEST = 200;

/** Valoarea unui atribut, în forma de schimb: text, număr (șir canonic), da/nu sau id de opțiune. */
export type AttributeValue = string | boolean;

export interface ProductAttributeEntry {
  attribute: AttributeRecord;
  /** `null` = necompletat. La număr: șirul canonic („12.5”); la listă: id-ul opțiunii. */
  value: AttributeValue | null;
}

interface StoredValue {
  attributeId: string;
  text: string | null;
  number: string | null;
  bool: boolean | null;
  optionId: string | null;
}

export interface ValueWrite {
  attributeId: string;
  /** `null` = se șterge valoarea. */
  value: { text?: string; number?: string; bool?: boolean; optionId?: string } | null;
}

export interface ProductAttributeStore {
  getProduct(id: string): Promise<{ id: string; slug: string; deletedAt: Date | null } | null>;
  listValues(productId: string): Promise<StoredValue[]>;
  /** ATOMIC: aplică toate scrierile. */
  writeValues(productId: string, writes: readonly ValueWrite[]): Promise<void>;
}

export interface ProductAttributesDeps {
  store: ProductAttributeStore;
  attributes: AttributeStore;
  audit: AuditService;
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
  logger: Pick<ReturnType<typeof getLogger>, "warn">;
}

const valuesSchema = z.strictObject({
  values: z
    .array(
      z.strictObject({
        attributeId: z.string().min(1).max(40),
        value: z.union([z.string().max(2000), z.boolean(), z.null()]),
      }),
    )
    .min(1, "Nu a fost trimisă nicio valoare")
    .max(MAX_ATTRIBUTE_VALUES_PER_REQUEST),
});

function toEntryValue(
  stored: StoredValue | undefined,
  attr: AttributeRecord,
): AttributeValue | null {
  if (!stored) return null;
  switch (attr.type) {
    case "text":
      return stored.text;
    case "number":
      return stored.number;
    case "bool":
      return stored.bool;
    case "select":
      return stored.optionId;
  }
}

export class ProductAttributesService {
  private readonly guard: ProductUpdateGuard;

  constructor(private readonly deps: ProductAttributesDeps) {
    this.guard = new ProductUpdateGuard({ audit: deps.audit });
  }

  private async invalidate(tags: readonly string[]): Promise<void> {
    try {
      await this.deps.invalidate?.(tags);
    } catch (error) {
      this.deps.logger.warn(
        { tags, reason: error instanceof Error ? error.message : "necunoscut" },
        "catalog: invalidarea cache-ului a eșuat",
      );
    }
  }

  /** Toate atributele definite, cu valoarea produsului (sau `null`). Cere `products.read`. */
  async get(
    subject: PermissionSubject | null,
    productId: string,
  ): Promise<ProductAttributeEntry[]> {
    assertCan(subject, "products.read");
    const [definitions, stored] = await Promise.all([
      this.deps.attributes.list(),
      this.deps.store.listValues(productId),
    ]);
    const byAttribute = new Map(stored.map((s) => [s.attributeId, s]));
    return definitions.map((attribute) => ({
      attribute,
      value: toEntryValue(byAttribute.get(attribute.id), attribute),
    }));
  }

  /**
   * Completează/șterge valori. `input`: `{ values: [{ attributeId, value }] }`. Toată cererea se
   * validează înainte de orice scriere; o valoare greșită respinge cererea întreagă.
   */
  async set(
    subject: PermissionSubject | null,
    productId: string,
    input: unknown,
  ): Promise<ProductAttributeEntry[]> {
    if (!subject) throw new UnauthenticatedError();
    const data = parseInput(valuesSchema, input);
    const attributeIds = data.values.map((v) => v.attributeId);
    if (new Set(attributeIds).size !== attributeIds.length) {
      throw new CatalogError(
        "ATTRIBUTE_VALUE_DUPLICATE",
        "Același atribut apare de două ori în cerere",
      );
    }

    return this.guard.run(subject, { productId }, { attributes: attributeIds }, async () => {
      const product = await this.deps.store.getProduct(productId);
      if (!product) throw new CatalogError("CATALOG_PRODUCT_NOT_FOUND", "Produsul nu există");
      if (product.deletedAt) {
        throw new CatalogError(
          "CATALOG_PRODUCT_DELETED",
          "Produsul e șters; restaurează-l înainte să-l modifici",
        );
      }

      const definitions = new Map((await this.deps.attributes.list()).map((a) => [a.id, a]));
      const writes: ValueWrite[] = [];
      for (const item of data.values) {
        const attr = definitions.get(item.attributeId);
        if (!attr) throw new CatalogError("ATTRIBUTE_NOT_FOUND", "Un atribut nu mai există");
        writes.push({ attributeId: attr.id, value: this.normalize(attr, item.value) });
      }

      const current = new Map(
        (await this.deps.store.listValues(productId)).map((s) => [s.attributeId, s]),
      );
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const changed: ValueWrite[] = [];
      for (const write of writes) {
        const attr = definitions.get(write.attributeId) as AttributeRecord;
        const previous = toEntryValue(current.get(write.attributeId), attr);
        const next = write.value ? (Object.values(write.value)[0] as AttributeValue) : null;
        if (previous === next) continue;
        changed.push(write);
        before[attr.code] = previous;
        after[attr.code] = next;
      }
      if (changed.length === 0) return this.get(subject, productId);

      await this.deps.store.writeValues(productId, changed);
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "product.attributes.update",
        entity: "product",
        entityId: productId,
        before,
        after,
      });
      await this.invalidate([...productCacheTags(product), CATALOG_TAG]);
      return this.get(subject, productId);
    });
  }

  /** Validează și normalizează o valoare după tipul atributului; `null` = se șterge. */
  private normalize(attr: AttributeRecord, raw: string | boolean | null): ValueWrite["value"] {
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) return null;
    const bad = (message: string): never => {
      throw new CatalogError("ATTRIBUTE_VALUE_INVALID", `${attr.name}: ${message}`, {
        attributeId: attr.id,
      });
    };
    switch (attr.type) {
      case "text": {
        if (typeof raw !== "string") return bad("introdu un text");
        const text = raw.trim();
        if (text.length > MAX_TEXT_ATTRIBUTE_LENGTH) {
          return bad(`textul are cel mult ${MAX_TEXT_ATTRIBUTE_LENGTH} de caractere`);
        }
        return { text };
      }
      case "number": {
        if (typeof raw !== "string") return bad("introdu un număr");
        const number = parseDecimalInput(raw);
        if (number === null) {
          return bad("introdu un număr valid, cu cel mult 4 zecimale (ex. 12,5)");
        }
        return { number };
      }
      case "bool": {
        if (typeof raw !== "boolean") return bad("alege Da sau Nu");
        return { bool: raw };
      }
      case "select": {
        if (typeof raw !== "string" || !attr.options.some((o) => o.id === raw)) {
          return bad("alege o opțiune din listă");
        }
        return { optionId: raw };
      }
    }
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

async function inTransaction<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ("$transaction" in db) return db.$transaction(fn);
  return fn(db);
}

export function createPrismaProductAttributeStore(db: Db): ProductAttributeStore {
  return {
    getProduct: (id) =>
      db.product.findUnique({ where: { id }, select: { id: true, slug: true, deletedAt: true } }),

    async listValues(productId) {
      const rows = await db.attributeValue.findMany({
        where: { productId },
        select: {
          attributeId: true,
          textValue: true,
          numberValue: true,
          boolValue: true,
          optionId: true,
        },
      });
      return rows.map((r) => ({
        attributeId: r.attributeId,
        text: r.textValue,
        number: r.numberValue === null ? null : r.numberValue.toString(),
        bool: r.boolValue,
        optionId: r.optionId,
      }));
    },

    async writeValues(productId, writes) {
      await inTransaction(db, async (tx) => {
        for (const write of writes) {
          if (write.value === null) {
            await tx.attributeValue.deleteMany({
              where: { productId, attributeId: write.attributeId },
            });
            continue;
          }
          // exact o coloană setată (CHECK + trigger în bază); celelalte se golesc la modificare
          const columns = {
            textValue: write.value.text ?? null,
            numberValue: write.value.number ?? null,
            boolValue: write.value.bool ?? null,
            optionId: write.value.optionId ?? null,
          };
          await tx.attributeValue.upsert({
            where: { productId_attributeId: { productId, attributeId: write.attributeId } },
            create: { productId, attributeId: write.attributeId, ...columns },
            update: columns,
          });
        }
      });
    },
  };
}
