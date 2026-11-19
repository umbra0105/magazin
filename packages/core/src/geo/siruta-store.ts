import { ValidationError } from "@ecom/shared";
import { inTx, type Db } from "../db-tx";
import { fromDerivedFile, validateSirutaRows, type SirutaRow } from "./siruta-data";
import { countyDisplayName, displayName } from "./siruta-names";

/**
 * Nomenclatorul SIRUTA în baza de date: încărcarea (idempotentă, într-o singură tranzacție) din fișierul derivat și citirea
 * pentru checkout. Importul validează TOT înainte de orice scriere (`validateSirutaRows`: ierarhie, cifra de control cu
 * excepțiile documentate) și respinge tot la prima problemă. Rândurile dispărute dintr-o versiune nouă se marchează inactive
 * (adresele păstrează codul), nu se șterg.
 */

export interface SirutaImportResult {
  version: string;
  inserted: number;
  updated: number;
  deactivated: number;
  reactivated: number;
  unchanged: number;
}

const BATCH = 4000;

export async function importSirutaDerived(db: Db, input: unknown): Promise<SirutaImportResult> {
  const file = fromDerivedFile(input);
  validateSirutaRows(file.rows, file.exceptions); // aruncă SirutaImportError înainte de orice scriere
  const version = file.meta.version;

  return inTx(db, async (tx) => {
    const existing = new Map(
      (
        await tx.sirutaUnit.findMany({
          select: {
            code: true,
            countyCode: true,
            name: true,
            parentCode: true,
            tip: true,
            level: true,
            isActive: true,
          },
        })
      ).map((r) => [r.code, r]),
    );

    const fresh: SirutaRow[] = [];
    const changed: SirutaRow[] = [];
    const reactivate: number[] = [];
    let unchanged = 0;
    for (const row of file.rows) {
      const old = existing.get(row.code);
      if (!old) fresh.push(row);
      else if (
        old.countyCode !== row.countyCode ||
        old.name !== row.name ||
        old.parentCode !== row.parentCode ||
        old.tip !== row.tip ||
        old.level !== row.level
      ) {
        changed.push(row);
      } else if (!old.isActive) reactivate.push(row.code);
      else unchanged++;
    }

    // părinții înaintea copiilor (cheia străină): nivelul 1, apoi 2, apoi 3
    for (const level of [1, 2, 3] as const) {
      const batch = fresh.filter((r) => r.level === level);
      for (let i = 0; i < batch.length; i += BATCH) {
        await tx.sirutaUnit.createMany({
          data: batch.slice(i, i + BATCH).map((r) => ({
            code: r.code,
            countyCode: r.countyCode,
            name: r.name,
            parentCode: r.parentCode,
            tip: r.tip,
            level: r.level,
            sourceVersion: version,
          })),
        });
      }
    }
    for (const row of changed) {
      await tx.sirutaUnit.update({
        where: { code: row.code },
        data: {
          countyCode: row.countyCode,
          name: row.name,
          parentCode: row.parentCode,
          tip: row.tip,
          level: row.level,
          isActive: true,
          sourceVersion: version,
        },
      });
    }
    if (reactivate.length > 0) {
      await tx.sirutaUnit.updateMany({
        where: { code: { in: reactivate } },
        data: { isActive: true, sourceVersion: version },
      });
    }
    const present = new Set(file.rows.map((r) => r.code));
    const gone = [...existing.values()].filter((r) => r.isActive && !present.has(r.code));
    if (gone.length > 0) {
      await tx.sirutaUnit.updateMany({
        where: { code: { in: gone.map((r) => r.code) } },
        data: { isActive: false },
      });
    }
    return {
      version,
      inserted: fresh.length,
      updated: changed.length,
      deactivated: gone.length,
      reactivated: reactivate.length,
      unchanged,
    };
  });
}

export interface CountyOption {
  /** `JUD` din registru (codul județului; București = 40). */
  code: number;
  name: string;
}

export interface LocalityOption {
  /** Codul SIRUTA al localității (nivelul 3). */
  code: number;
  /** Numele de afișare (litere mici cu inițiale mari). */
  name: string;
  /** Unitatea administrativă părinte (comuna, orașul, municipiul), când numele localității nu o identifică de unul singur. */
  context: string | null;
  /** `name` sau `name (context)`, pentru liste. */
  label: string;
}

/** Citirea pentru checkout: județele, localitățile unui județ și validarea unei perechi județ–localitate. */
export class GeoService {
  constructor(private readonly db: Db) {}

  async counties(): Promise<CountyOption[]> {
    const rows = await this.db.sirutaUnit.findMany({
      where: { level: 1, isActive: true },
      select: { countyCode: true, name: true },
    });
    return rows
      .map((r) => ({ code: r.countyCode, name: countyDisplayName(r.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, "ro"));
  }

  async localities(countyCode: number): Promise<LocalityOption[]> {
    const rows = await this.db.sirutaUnit.findMany({
      where: { level: 3, isActive: true, countyCode },
      select: { code: true, name: true, parent: { select: { name: true } } },
    });
    const named = rows.map((r) => ({
      code: r.code,
      name: displayName(r.name),
      context: r.parent ? displayName(r.parent.name) : null,
    }));
    const counts = new Map<string, number>();
    for (const r of named) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
    return named
      .map((r) => {
        const ambiguous =
          (counts.get(r.name) ?? 0) > 1 && r.context !== null && r.context !== r.name;
        const context = ambiguous ? r.context : null;
        return {
          code: r.code,
          name: r.name,
          context,
          label: context ? `${r.name} (${context})` : r.name,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label, "ro"));
  }

  /**
   * Verifică pe server că localitatea există, e activă, e de nivelul 3 și aparține județului; întoarce numele de afișare.
   * Orice nepotrivire e o eroare de validare (adresa nu se acceptă).
   */
  async resolveLocation(
    countyCode: number,
    localityCode: number,
  ): Promise<{
    countyName: string;
    localityName: string;
    countySirutaCode: number;
    localitySirutaCode: number;
  }> {
    const locality = await this.db.sirutaUnit.findUnique({
      where: { code: localityCode },
      select: { level: true, isActive: true, countyCode: true, name: true },
    });
    const county = await this.db.sirutaUnit.findFirst({
      where: { level: 1, isActive: true, countyCode },
      select: { code: true, name: true },
    });
    if (
      !locality ||
      !county ||
      locality.level !== 3 ||
      !locality.isActive ||
      locality.countyCode !== countyCode
    ) {
      throw new ValidationError("Județul și localitatea nu se potrivesc", {
        field: "locality",
      });
    }
    return {
      countyName: countyDisplayName(county.name),
      localityName: displayName(locality.name),
      countySirutaCode: county.code,
      localitySirutaCode: localityCode,
    };
  }
}
