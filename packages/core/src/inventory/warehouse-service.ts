import { z } from "zod";
import { DomainError } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { parseInput } from "../catalog/product-schemas";
import { assertCan, type PermissionSubject } from "../rbac/can";

/**
 * Depozitele (Faza 5, punctul 13): locațiile stocului, în spatele steagului `multiWarehouse`. Cu steagul OPRIT serviciul
 * refuză ORICE operație (`FEATURE_DISABLED`), înaintea oricărei citiri, scrieri sau verificări de drepturi: magazinul
 * rămâne cu singurul «Depozit principal», iar rezervările, importul SmartBill și disponibilitatea nu depind de acest cod.
 * Cere `inventory.read` pentru citire și `inventory.write` pentru scriere.
 *
 * Reguli:
 * - **Codul** se derivă din nume la creare și nu se mai schimbă (importurile și rapoartele îl pot referi).
 * - **Numele** e unic fără deosebire de litere și de spații. Garantat de serviciu, nu de bază (nu avem index pe expresie).
 * - **Depozitul implicit** (cel din care citesc rezervările, importul și disponibilitatea) se poate redenumi, dar nu se
 *   dezactivează și nu se schimbă: schimbarea lui ar muta nevăzut vânzarea online pe un depozit gol.
 * - **Un depozit cu stoc** (cantitate fizică, angajată sau rezervată nenulă) nu se dezactivează.
 * - Cel mult `MAX_WAREHOUSES` depozite.
 */

export const MAX_WAREHOUSES = 50;
export const WAREHOUSE_NAME_MAX_LENGTH = 100;
export const WAREHOUSE_CODE_MAX_LENGTH = 40;
/** Câte coduri încearcă la creare, dacă o cerere concurentă ocupă codul ales între citire și scriere */
const CREATE_ATTEMPTS = 5;

export class MultiWarehouseDisabledError extends DomainError {
  constructor() {
    super("FEATURE_DISABLED", "Funcționalitatea „Multi-depozit” este oprită");
  }
}

/**
 * Erorile depozitelor, cu cod stabil: `WAREHOUSE_NOT_FOUND`, `WAREHOUSE_NAME_CONFLICT`, `WAREHOUSE_CODE_CONFLICT`,
 * `WAREHOUSE_LIMIT`, `WAREHOUSE_DEFAULT_PROTECTED`, `WAREHOUSE_HAS_STOCK` (`details.stockedItems`).
 */
export class WarehouseError extends DomainError {}

/** Aruncată de depozit când indexul unic al codului respinge scrierea (o cerere concurentă a luat codul) */
export class WarehouseCodeTakenError extends Error {
  constructor(readonly code: string) {
    super(`Codul de depozit «${code}» e deja folosit`);
    this.name = "WarehouseCodeTakenError";
  }
}

export interface WarehouseRecord {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
}

export interface WarehouseWithUsage extends WarehouseRecord {
  /** Rânduri de stoc cu cantitate fizică, angajată sau rezervată nenulă */
  stockedItems: number;
}

export interface WarehouseStore {
  listAll(): Promise<WarehouseWithUsage[]>;
  get(id: string): Promise<WarehouseWithUsage | null>;
  /** Aruncă `WarehouseCodeTakenError` dacă indexul unic al codului respinge scrierea */
  create(data: { code: string; name: string }): Promise<WarehouseRecord>;
  update(id: string, data: { name?: string; isActive?: boolean }): Promise<WarehouseRecord>;
}

export interface WarehouseServiceDeps {
  store: WarehouseStore;
  audit: AuditService;
  /** Steagul `multiWarehouse`, citit la FIECARE apel (nicio copie păstrată aici) */
  isEnabled: () => Promise<boolean>;
}

const name = z
  .string()
  .trim()
  .min(1, "Numele e obligatoriu")
  .max(WAREHOUSE_NAME_MAX_LENGTH, `Numele are cel mult ${WAREHOUSE_NAME_MAX_LENGTH} de caractere`);

export const warehouseCreateSchema = z.strictObject({ name });
export const warehouseRenameSchema = z.strictObject({ name });

/** Compararea numelor: fără deosebire de litere și de spații laterale (diacriticele contează) */
const nameKey = (value: string): string => value.trim().toLocaleLowerCase("ro-RO");

/**
 * Codul stabil al unui depozit, derivat din nume: litere latine mici, cifre și «_», începe cu o literă (CHECK-ul bazei),
 * cel mult `WAREHOUSE_CODE_MAX_LENGTH` caractere. Diacriticele românești se transformă în litera de bază.
 */
export function warehouseCodeFromName(value: string): string {
  const base = value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const prefixed = base === "" ? "depozit" : /^[0-9]/.test(base) ? `depozit_${base}` : base;
  return prefixed.slice(0, WAREHOUSE_CODE_MAX_LENGTH).replace(/_+$/, "");
}

/** Primul cod liber: baza, apoi `baza_2`, `baza_3` …, fiecare în limita lungimii */
function freeCode(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = `${base.slice(0, WAREHOUSE_CODE_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const NOT_FOUND = () => new WarehouseError("WAREHOUSE_NOT_FOUND", "Depozitul nu există");

const nameConflict = (value: string, owner: string) =>
  new WarehouseError(
    "WAREHOUSE_NAME_CONFLICT",
    `Există deja un depozit numit «${owner}». Alege alt nume.`,
    { name: value },
  );

const toRecord = (row: WarehouseRecord): WarehouseRecord => ({
  id: row.id,
  code: row.code,
  name: row.name,
  isDefault: row.isDefault,
  isActive: row.isActive,
});

export class WarehouseService {
  constructor(private readonly deps: WarehouseServiceDeps) {}

  /** Steagul întâi (un anonim nu află dacă funcția există), apoi dreptul cerut */
  private async authorize(
    subject: PermissionSubject | null,
    permission: "inventory.read" | "inventory.write",
  ): Promise<PermissionSubject> {
    if (!(await this.deps.isEnabled())) throw new MultiWarehouseDisabledError();
    assertCan(subject, permission);
    return subject;
  }

  private async record(
    subject: PermissionSubject,
    action: string,
    entityId: string,
    before: Record<string, unknown> | undefined,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action,
      entity: "warehouse",
      entityId,
      ...(before && { before }),
      after,
    });
  }

  /** Toate depozitele (implicitul primul, apoi după nume), cu numărul de rânduri de stoc. Cere `inventory.read`. */
  async list(subject: PermissionSubject | null): Promise<WarehouseWithUsage[]> {
    await this.authorize(subject, "inventory.read");
    const rows = await this.deps.store.listAll();
    return [...rows].sort((a, b) =>
      a.isDefault === b.isDefault ? a.name.localeCompare(b.name, "ro-RO") : a.isDefault ? -1 : 1,
    );
  }

  /** Depozitele active, pentru selectoare. Cere `inventory.read`. */
  async listActive(subject: PermissionSubject | null): Promise<WarehouseRecord[]> {
    const rows = await this.list(subject);
    return rows.filter((row) => row.isActive).map(toRecord);
  }

  async create(subject: PermissionSubject | null, input: unknown): Promise<WarehouseRecord> {
    const actor = await this.authorize(subject, "inventory.write");
    const data = parseInput(warehouseCreateSchema, input);
    const base = warehouseCodeFromName(data.name);
    for (let attempt = 1; attempt <= CREATE_ATTEMPTS; attempt++) {
      // citit din nou la fiecare încercare: o cerere concurentă poate fi creat între timp numele sau codul
      const existing = await this.deps.store.listAll();
      const duplicate = existing.find((row) => nameKey(row.name) === nameKey(data.name));
      if (duplicate) throw nameConflict(data.name, duplicate.name);
      if (existing.length >= MAX_WAREHOUSES) {
        throw new WarehouseError(
          "WAREHOUSE_LIMIT",
          `Poți avea cel mult ${MAX_WAREHOUSES} de depozite`,
          { max: MAX_WAREHOUSES },
        );
      }
      const code = freeCode(base, new Set(existing.map((row) => row.code)));
      try {
        const created = await this.deps.store.create({ code, name: data.name });
        await this.record(actor, "warehouse.create", created.id, undefined, {
          code: created.code,
          name: created.name,
        });
        return toRecord(created);
      } catch (error) {
        if (error instanceof WarehouseCodeTakenError && attempt < CREATE_ATTEMPTS) continue;
        if (error instanceof WarehouseCodeTakenError) {
          throw new WarehouseError(
            "WAREHOUSE_CODE_CONFLICT",
            "Nu am putut alege un cod liber pentru depozit; încearcă din nou",
            { code },
          );
        }
        throw error;
      }
    }
    throw new WarehouseError("WAREHOUSE_CODE_CONFLICT", "Nu am putut crea depozitul");
  }

  async rename(
    subject: PermissionSubject | null,
    id: string,
    input: unknown,
  ): Promise<WarehouseRecord> {
    const actor = await this.authorize(subject, "inventory.write");
    const data = parseInput(warehouseRenameSchema, input);
    const warehouse = await this.deps.store.get(id);
    if (!warehouse) throw NOT_FOUND();
    if (warehouse.name === data.name) return toRecord(warehouse);
    const duplicate = (await this.deps.store.listAll()).find(
      (row) => row.id !== id && nameKey(row.name) === nameKey(data.name),
    );
    if (duplicate) throw nameConflict(data.name, duplicate.name);
    const updated = await this.deps.store.update(id, { name: data.name });
    await this.record(actor, "warehouse.rename", id, { name: warehouse.name }, { name: data.name });
    return toRecord(updated);
  }

  /** Dezactivează un depozit gol care nu e cel implicit; un depozit dezactivat nu se mai alege în selectoare. */
  async deactivate(subject: PermissionSubject | null, id: string): Promise<WarehouseRecord> {
    const actor = await this.authorize(subject, "inventory.write");
    const warehouse = await this.deps.store.get(id);
    if (!warehouse) throw NOT_FOUND();
    if (!warehouse.isActive) return toRecord(warehouse);
    if (warehouse.isDefault) {
      throw new WarehouseError(
        "WAREHOUSE_DEFAULT_PROTECTED",
        `«${warehouse.name}» este depozitul implicit (de aici citesc rezervările, importul SmartBill și disponibilitatea) și nu poate fi dezactivat.`,
      );
    }
    if (warehouse.stockedItems > 0) {
      throw new WarehouseError(
        "WAREHOUSE_HAS_STOCK",
        `«${warehouse.name}» are stoc (${warehouse.stockedItems} ${warehouse.stockedItems === 1 ? "rând" : "rânduri"} cu cantitate fizică, angajată sau rezervată). Mută sau scoate stocul înainte să-l dezactivezi.`,
        { stockedItems: warehouse.stockedItems },
      );
    }
    const updated = await this.deps.store.update(id, { isActive: false });
    await this.record(actor, "warehouse.deactivate", id, { isActive: true }, { isActive: false });
    return toRecord(updated);
  }

  async activate(subject: PermissionSubject | null, id: string): Promise<WarehouseRecord> {
    const actor = await this.authorize(subject, "inventory.write");
    const warehouse = await this.deps.store.get(id);
    if (!warehouse) throw NOT_FOUND();
    if (warehouse.isActive) return toRecord(warehouse);
    const updated = await this.deps.store.update(id, { isActive: true });
    await this.record(actor, "warehouse.activate", id, { isActive: false }, { isActive: true });
    return toRecord(updated);
  }
}
