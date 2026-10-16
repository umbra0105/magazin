/**
 * Texte pentru fișierul ales într-un câmp de încărcare (limba română, fără dependențe): mărimea ca
 * «812 B», «1,2 KB», «4,2 MB» și rezumatul alegerii («raport.csv (1,2 KB)», «3 fișiere alese (4,2 MB)»).
 */

const ONE_DECIMAL = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 1 });

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${ONE_DECIMAL.format(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${ONE_DECIMAL.format(bytes / (1024 * 1024))} MB`;
  return `${ONE_DECIMAL.format(bytes / (1024 * 1024 * 1024))} GB`;
}

export interface FileLike {
  name: string;
  size: number;
}

/** Ce spune câmpul despre alegere: nimic ales, un fișier cu mărimea lui, sau numărul și mărimea totală. */
export function describeFiles(
  files: readonly FileLike[],
  texts: { empty: string; many: (count: number, total: string) => string },
): string {
  if (files.length === 0) return texts.empty;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length === 1) {
    const file = files[0] as FileLike;
    return `${file.name} (${formatFileSize(file.size)})`;
  }
  return texts.many(files.length, formatFileSize(total));
}
