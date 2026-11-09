import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Mărimile de text din scara tipografică a design-ului (docs/17 §2.8, definite în globals.css cu `--text-*`). Fără ele,
 * `tailwind-merge` ia `text-label` drept culoare și o elimină când îi urmează `text-ink-secondary` (conflict de «culoare»).
 */
export const TEXT_SIZE_TOKENS = ["title", "section", "body", "compact", "label", "kpi"] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...TEXT_SIZE_TOKENS] }],
    },
  },
});

/** Îmbină clase Tailwind fără conflicte (ultima câștigă). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
