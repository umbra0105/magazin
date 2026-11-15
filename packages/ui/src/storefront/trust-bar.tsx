import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface TrustItem {
  icon: ReactNode;
  title: string;
  text?: string | undefined;
}

/**
 * Banda de încredere (docs/21 §3.2–3.3): patru repere într-un singur rând, pe un card larg. E o listă (`ul`), deci cititoarele
 * de ecran o anunță cu numărul de elemente; `label` o numește. Pictogramele sunt decorative (`aria-hidden` la apelant).
 */
export function TrustBar({
  items,
  label,
  className,
}: {
  items: readonly TrustItem[];
  label: string;
  className?: string;
}) {
  return (
    <ul
      aria-label={label}
      className={cn(
        "grid gap-x-8 gap-y-6 rounded-card bg-card p-6 sm:grid-cols-2 sm:p-8 lg:grid-cols-4",
        className,
      )}
    >
      {items.map((item) => (
        <li key={item.title} className="flex items-start gap-4">
          <span className="mt-0.5 shrink-0 text-brand">{item.icon}</span>
          <span className="min-w-0">
            <span className="block font-semibold">{item.title}</span>
            {item.text ? (
              <span className="mt-0.5 block text-sm text-ink-secondary">{item.text}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
