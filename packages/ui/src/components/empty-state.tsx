import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface EmptyStateProps {
  title: string;
  /** O frază care spune ce urmează sau cum se ajunge aici. */
  description?: string;
  /** O singură acțiune (de obicei un buton principal). */
  action?: ReactNode;
  /** Pictogramă liniară opțională (moștenește culoarea textului). */
  icon?: ReactNode;
  /** Nivelul titlului în pagină. */
  as?: "h2" | "h3";
  className?: string;
}

/** Stare goală (docs/17 §3): titlu, o frază și o singură acțiune; fără ilustrații decorative. */
export function EmptyState({
  title,
  description,
  action,
  icon,
  as: Tag = "h2",
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn("flex flex-col items-center gap-2 px-4 py-12 text-center text-ink", className)}
    >
      {icon ? (
        <div aria-hidden="true" className="text-ink-secondary">
          {icon}
        </div>
      ) : null}
      <Tag className="text-section">{title}</Tag>
      {description ? (
        <p className="max-w-prose text-body text-ink-secondary">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
