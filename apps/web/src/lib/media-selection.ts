/**
 * Logica de selecție a selectorului media (pură, testabilă): ordinea alegerii se păstrează, cu un
 * număr maxim. La selecție unică (`max = 1`) o nouă alegere o înlocuiește pe cea veche.
 */
export interface ToggleResult {
  ids: string[];
  /** `true` dacă s-a încercat adăugarea peste maxim (nimic nu s-a schimbat). */
  rejected: boolean;
}

export function toggleSelection(ids: readonly string[], id: string, max: number): ToggleResult {
  if (ids.includes(id)) return { ids: ids.filter((x) => x !== id), rejected: false };
  if (max <= 1) return { ids: [id], rejected: false };
  if (ids.length >= max) return { ids: [...ids], rejected: true };
  return { ids: [...ids, id], rejected: false };
}

/** Maximul efectiv: 1 la selecție unică; altfel `max` (implicit 10), între 1 și 50. */
export function effectiveMax(mode: "single" | "multiple", max: number | undefined): number {
  if (mode === "single") return 1;
  const value = Math.trunc(max ?? 10);
  return Math.min(Math.max(Number.isFinite(value) ? value : 10, 1), 50);
}

/** Id-urile păstrate dintr-o selecție inițială: fără dubluri, în ordine, cel mult `max`. */
export function normalizeInitial(ids: readonly string[] | undefined, max: number): string[] {
  return [...new Set(ids ?? [])].slice(0, max);
}
