import { z } from "zod";
import type { AuditService } from "../audit/audit-service";
import { CatalogError, changedFields } from "../catalog/catalog-support";
import { parseInput } from "../catalog/product-schemas";
import { assertCan, type PermissionSubject } from "../rbac/can";
import { DEFAULT_MEASURE_UNIT_CODE } from "./constants";

/**
 * Unitățile de măsură (D11): ce măsoară prețul și stocul (buc, ml, mp, kg, l …), câte zecimale are voie cantitatea
 * (0–4) și cum se numește unitatea în SmartBill. Cere `products.read` pentru citire și `products.write` pentru scriere
 * (aceeași structură de catalog ca brandurile și categoriile).
 *
 * Reguli:
 * - **Codul nu se schimbă niciodată** după creare (produsele și importurile îl referă).
 * - **«buc» este unitatea implicită** (o unitate nulă pe produs sau variantă înseamnă «buc»): nu poate fi dezactivată,
 *   nu i se schimbă codul și rămâne FĂRĂ zecimale. Numele, simbolul și numele din SmartBill se pot edita. Baza de date
 *   nu o lasă ștearsă (unitate de sistem).
 * - **Zecimalele nu pot scădea** sub ce folosesc deja pașii de vânzare și cantitățile de stoc ale produselor care
 *   o folosesc; mărirea e mereu permisă.
 * - Unitatea dezactivată rămâne pe produsele care o au, dar nu se mai poate alege pe altele.
 */

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;
export const MEASURE_UNIT_CODE_MAX_LENGTH = 30;

const code = z
  .string()
  .max(
    MEASURE_UNIT_CODE_MAX_LENGTH,
    `Codul are cel mult ${MEASURE_UNIT_CODE_MAX_LENGTH} de caractere`,
  )
  .regex(CODE_PATTERN, "Codul poate conține doar litere mici, cifre și «_», și începe cu o literă");
const name = z.string().trim().min(1, "Numele e obligatoriu").max(100);
const symbol = z.string().trim().min(1, "Simbolul e obligatoriu").max(20);
const smartbillName = z
  .string()
  .trim()
  .max(100)
  .nullable()
  .optional()
  .transform((value) => (value === "" ? null : value));
const decimals = z
  .number()
  .int()
  .min(0, "Zecimalele sunt între 0 și 4")
  .max(4, "Zecimalele sunt între 0 și 4");

export const measureUnitCreateSchema = z.strictObject({
  code,
  name,
  symbol,
  smartbillName,
  decimals: decimals.default(0),
});

export const measureUnitUpdateSchema = z
  .strictObject({
    code,
    name,
    symbol,
    smartbillName,
    decimals,
    isActive: z.boolean(),
    sortOrder: z.number().int().min(0).max(100_000),
  })
  .partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Nu a fost trimis niciun câmp de modificat",
  });

export interface MeasureUnitRecord {
  id: string;
  code: string;
  name: string;
  symbol: string;
  smartbillName: string | null;
  decimals: number;
  isActive: boolean;
  isSystem: boolean;
  sortOrder: number;
}

export interface MeasureUnitWithUsage extends MeasureUnitRecord {
  /** Produse care au ales explicit unitatea. */
  productCount: number;
  /** Variante care au ales explicit unitatea. */
  variantCount: number;
}

/** Ce s-ar strica dacă unitatea ar avea mai puține zecimale. */
export interface DecimalConflicts {
  /** Variante (cu unitatea efectivă aceasta) al căror pas de vânzare are mai multe zecimale. */
  steps: number;
  /** Rânduri de stoc (cantitate fizică, angajată, rezervată sau tampon) cu mai multe zecimale. */
  stock: number;
}

export interface MeasureUnitStore {
  listAll(): Promise<MeasureUnitWithUsage[]>;
  get(id: string): Promise<MeasureUnitRecord | null>;
  findByCode(code: string): Promise<MeasureUnitRecord | null>;
  create(data: Omit<MeasureUnitRecord, "id" | "isSystem">): Promise<MeasureUnitRecord>;
  update(
    id: string,
    data: Partial<Omit<MeasureUnitRecord, "id" | "isSystem">>,
  ): Promise<MeasureUnitRecord>;
  findDecimalConflicts(id: string, decimals: number): Promise<DecimalConflicts>;
}

export interface MeasureUnitServiceDeps {
  store: MeasureUnitStore;
  audit: AuditService;
}

const NOT_FOUND = () => new CatalogError("MEASURE_UNIT_NOT_FOUND", "Unitatea de măsură nu există");

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export class MeasureUnitService {
  constructor(private readonly deps: MeasureUnitServiceDeps) {}

  /** Toate unitățile, cu numărul de produse și variante care le-au ales. Cere `products.read`. */
  async list(subject: PermissionSubject | null): Promise<MeasureUnitWithUsage[]> {
    assertCan(subject, "products.read");
    return this.deps.store.listAll();
  }

  /** Unitățile active, pentru selectoare. Cere `products.read`. */
  async listActive(subject: PermissionSubject | null): Promise<MeasureUnitRecord[]> {
    assertCan(subject, "products.read");
    const rows = await this.deps.store.listAll();
    return rows
      .filter((row) => row.isActive)
      .map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        symbol: row.symbol,
        smartbillName: row.smartbillName,
        decimals: row.decimals,
        isActive: row.isActive,
        isSystem: row.isSystem,
        sortOrder: row.sortOrder,
      }));
  }

  async create(subject: PermissionSubject | null, input: unknown): Promise<MeasureUnitRecord> {
    assertCan(subject, "products.write");
    const data = parseInput(measureUnitCreateSchema, input);
    const owner = await this.deps.store.findByCode(data.code);
    if (owner) {
      throw new CatalogError(
        "MEASURE_UNIT_CODE_CONFLICT",
        `Codul «${data.code}» e deja folosit de unitatea «${owner.name}». Alege alt cod.`,
        { code: data.code },
      );
    }
    const existing = await this.deps.store.listAll();
    const sortOrder = existing.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1;
    const created = await this.deps.store.create({
      code: data.code,
      name: data.name,
      symbol: data.symbol,
      smartbillName: data.smartbillName ?? null,
      decimals: data.decimals,
      isActive: true,
      sortOrder,
    });
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "measureUnit.create",
      entity: "measure_unit",
      entityId: created.id,
      after: { code: created.code, name: created.name, decimals: created.decimals },
    });
    return created;
  }

  async update(
    subject: PermissionSubject | null,
    id: string,
    input: unknown,
  ): Promise<MeasureUnitRecord> {
    assertCan(subject, "products.write");
    const parsed = parseInput(measureUnitUpdateSchema, input);
    const unit = await this.deps.store.get(id);
    if (!unit) throw NOT_FOUND();
    const isDefault = unit.code === DEFAULT_MEASURE_UNIT_CODE;

    const patch: Record<string, unknown> = { ...parsed };
    if (parsed.code !== undefined) {
      if (parsed.code !== unit.code) {
        throw isDefault
          ? new CatalogError(
              "MEASURE_UNIT_DEFAULT_PROTECTED",
              `«${unit.code}» este unitatea implicită (o unitate nulă înseamnă «${unit.code}»): codul ei nu se poate schimba.`,
            )
          : new CatalogError(
              "MEASURE_UNIT_CODE_IMMUTABLE",
              "Codul unei unități nu se schimbă după creare; produsele și importurile îl folosesc.",
            );
      }
      delete patch["code"];
    }
    if (isDefault) {
      if (parsed.isActive === false) {
        throw new CatalogError(
          "MEASURE_UNIT_DEFAULT_PROTECTED",
          `«${unit.code}» este unitatea implicită și nu poate fi dezactivată.`,
        );
      }
      if (parsed.decimals !== undefined && parsed.decimals !== 0) {
        throw new CatalogError(
          "MEASURE_UNIT_DEFAULT_PROTECTED",
          `«${unit.code}» este unitatea implicită și rămâne fără zecimale. Pentru cantități cu zecimale folosește ml, mp, kg sau l.`,
        );
      }
    }

    if (parsed.decimals !== undefined && parsed.decimals < unit.decimals) {
      const conflicts = await this.deps.store.findDecimalConflicts(id, parsed.decimals);
      if (conflicts.steps + conflicts.stock > 0) {
        const parts: string[] = [];
        if (conflicts.steps > 0)
          parts.push(plural(conflicts.steps, "pas de vânzare", "pași de vânzare"));
        if (conflicts.stock > 0)
          parts.push(plural(conflicts.stock, "rând de stoc", "rânduri de stoc"));
        throw new CatalogError(
          "MEASURE_UNIT_DECIMALS_IN_USE",
          `Unitatea «${unit.name}» nu poate avea doar ${parsed.decimals} ${parsed.decimals === 1 ? "zecimală" : "zecimale"}: ${parts.join(" și ")} au mai multe zecimale. Corectează-le întâi.`,
          { ...conflicts, decimals: parsed.decimals },
        );
      }
    }

    const diff = changedFields(unit as unknown as Record<string, unknown>, patch);
    if (Object.keys(diff.after).length === 0) return unit;
    const after = await this.deps.store.update(id, patch as Partial<MeasureUnitRecord>);
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "measureUnit.update",
      entity: "measure_unit",
      entityId: id,
      before: diff.before,
      after: diff.after,
    });
    return after;
  }
}
