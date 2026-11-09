import { cn } from "../lib/cn";

/**
 * Aspectul tab-urilor (docs/17 §3), într-un singur loc: le folosesc `Tabs` (butoane care schimbă un panou) și vederile unei pagini
 * desenate ca legături (`<nav>` cu `Link`, fiecare vedere cu adresa ei). Cel activ: text principal și linie de 2 px dedesubt; celelalte:
 * text secundar. Înălțimea minimă e a controlului (44 px pe telefon, 36 px de la `md`).
 */
export const TAB_LIST_CLASS = "flex flex-wrap gap-1 border-b border-line-subtle";

export function tabClass(selected: boolean): string {
  return cn(
    "-mb-px inline-flex min-h-(--control-h) items-center gap-1.5 border-b-2 px-4 text-body transition-colors duration-(--motion)",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset",
    selected
      ? "border-ink font-medium text-ink"
      : "border-transparent text-ink-secondary hover:text-ink",
  );
}
