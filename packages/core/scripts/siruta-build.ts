/**
 * Construiește fișierul DERIVAT SIRUTA din fișierul brut al INS (`siruta_s1_2026.csv`, din `local-data/`, necomis).
 *
 *   node --import tsx packages/core/scripts/siruta-build.ts --csv <cale> --out <cale> --version "S1 2026" \
 *        [--previous <fișier derivat anterior>] [--accept-check-digit-failures <N>]
 *
 * - Fără `--previous`: prima construire. Codurile cu cifra de control greșită devin lista de excepții DOAR dacă numărul lor e
 *   exact `--accept-check-digit-failures` (decizia utilizatorului, `docs/SIRUTA-SURSA.md`); altfel scriptul se oprește.
 * - Cu `--previous`: se acceptă doar excepțiile din fișierul anterior; orice cod nou cu cifra greșită, sau o excepție cu nume,
 *   părinte sau tip schimbat, oprește scriptul (nu se scrie nimic). Raportul de diferențe, cu excepțiile, se tipărește mereu.
 * Nu tipărește nume sau coduri individuale; doar numărătoare.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CHECK_DIGIT_EXCEPTION_REASON,
  SirutaImportError,
  diffSiruta,
  findCheckDigitFailures,
  fromDerivedFile,
  parseSirutaCsv,
  toDerivedFile,
  validateSirutaRows,
  type CheckDigitException,
} from "../src/geo/siruta-data";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const csvPath = arg("csv");
const outPath = arg("out");
const version = arg("version");
if (!csvPath || !outPath || !version) fail("Lipsesc --csv, --out sau --version.");

try {
  const rows = parseSirutaCsv(readFileSync(resolve(csvPath), "utf8"));
  const failures = findCheckDigitFailures(rows);

  let accepted: CheckDigitException[];
  let previous: ReturnType<typeof fromDerivedFile> | null = null;
  const previousPath = arg("previous");
  if (previousPath) {
    previous = fromDerivedFile(JSON.parse(readFileSync(resolve(previousPath), "utf8")));
    accepted = previous.exceptions;
  } else {
    const expected = Number(arg("accept-check-digit-failures"));
    if (!Number.isInteger(expected) || expected !== failures.length) {
      fail(
        `Prima construire: ${failures.length} coduri cu cifra de control greșită; ` +
          `--accept-check-digit-failures trebuie să fie exact acest număr (a primit ${String(arg("accept-check-digit-failures"))}).`,
      );
    }
    accepted = failures.map((r) => ({
      code: r.code,
      name: r.name,
      parentCode: r.parentCode,
      tip: r.tip,
      reason: CHECK_DIGIT_EXCEPTION_REASON,
    }));
  }

  if (previous) {
    const diff = diffSiruta(previous.rows, previous.exceptions, rows);
    console.log(
      `Diferențe față de ${previous.meta.version}: ${diff.added.length} noi, ${diff.removed.length} dispărute, ${diff.changed.length} schimbate.`,
    );
    console.log(
      `Excepții: ${diff.exceptions.added.length} noi, ${diff.exceptions.removed.length} dispărute, ${diff.exceptions.changed.length} schimbate.`,
    );
  }

  validateSirutaRows(rows, accepted); // respinge tot la orice nepotrivire

  const file = toDerivedFile(rows, accepted, {
    source: "Institutul Național de Statistică (INS), registrul SIRUTA",
    version,
    licence: "CC BY 4.0",
    licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
    attribution: `Institutul Național de Statistică (INS), registrul SIRUTA, semestrul 1 din 2026`,
    modifications:
      "Date modificate: coloane selectate, diacritice normalizate (ș/ț); la afișare, majusculele sunt convertite în litere mici cu inițiale mari. Nu există nicio susținere din partea INS.",
  });
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(
    resolve(outPath),
    `{\n"meta": ${JSON.stringify(file.meta)},\n"checkDigitExceptions": ${JSON.stringify(file.checkDigitExceptions)},\n"rows": [\n${file.rows
      .map((r) => JSON.stringify(r))
      .join(",\n")}\n]\n}\n`,
  );
  console.log(
    `Scris ${file.rows.length} rânduri și ${file.checkDigitExceptions.length} excepții în fișierul derivat.`,
  );
} catch (error) {
  if (error instanceof SirutaImportError) {
    console.error(error.message);
    for (const p of error.problems.slice(0, 10)) console.error(`  - ${p}`);
    process.exit(1);
  }
  throw error;
}
