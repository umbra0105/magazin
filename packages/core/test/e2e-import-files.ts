import { unzipSync, zipSync } from "fflate";
import writeExcelFile from "write-excel-file/node";

/**
 * Fișiere de import pentru testele E2E (XLSX valid, cu macro-uri, arhivă-bombă). Stau în pachetul
 * `core`, unde sunt instalate bibliotecile; testele din `e2e/` nu le pot importa direct.
 */

/** Un XLSX cu o foaie; toate celulele sunt text (zerourile de la început rămân). */
export async function e2eXlsx(rows: string[][]): Promise<Buffer> {
  const buffer = await writeExcelFile(
    rows.map((row) => row.map((value) => ({ value, type: String }))),
  ).toBuffer();
  return Buffer.from(buffer);
}

/** Același XLSX, cu o componentă de macro-uri (`vbaProject.bin`) adăugată. */
export function e2eXlsxWithMacros(xlsx: Buffer): Buffer {
  const parts = unzipSync(new Uint8Array(xlsx));
  return Buffer.from(zipSync({ ...parts, "xl/vbaProject.bin": new Uint8Array([1, 2, 3]) }));
}

/** Un XLSX a cărui foaie are `sheetMb` MB decomprimat (câțiva KB comprimat): arhivă-bombă. */
export function e2eXlsxBomb(xlsx: Buffer, sheetMb: number): Buffer {
  const parts = unzipSync(new Uint8Array(xlsx));
  return Buffer.from(
    zipSync(
      { ...parts, "xl/worksheets/sheet1.xml": new Uint8Array(sheetMb * 1024 * 1024) },
      { level: 9 },
    ),
  );
}

/** Numele intrărilor dintr-o arhivă ZIP/XLSX. */
export function e2eZipNames(bytes: Uint8Array): string[] {
  return Object.keys(unzipSync(bytes));
}

/** Conținutul text al fiecărei intrări dintr-o arhivă XLSX (după cale), pentru verificări în E2E. */
export function e2eUnzipText(bytes: Uint8Array): Record<string, string> {
  const decoder = new TextDecoder();
  return Object.fromEntries(
    Object.entries(unzipSync(bytes)).map(([name, entry]) => [name, decoder.decode(entry)]),
  );
}
