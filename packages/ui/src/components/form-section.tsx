import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface SectionProps {
  /** Prefix pentru `id`-ul titlului (`<id>-title`), legat prin `aria-labelledby`. */
  id: string;
  title?: string;
  /** O frază sub titlu, în text secundar. */
  description?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Secțiune a unei pagini de editare (docs/17 §4.2): separată de cea de deasupra printr-o LINIE (`border-t`) și spațiu, nu printr-o
 * casetă; prima secțiune a paginii nu are linie și nici spațiu deasupra. Titlul (h2, 16 px / 600) o leagă de conținut pentru
 * cititoarele de ecran. Pe pagină stă într-o coloană de cel mult 880 px (o dă formularul, nu secțiunea).
 */
export function Section({ id, title, description, className, children }: SectionProps) {
  const titleId = title ? `${id}-title` : undefined;
  return (
    <section
      data-editor-section
      aria-labelledby={titleId}
      className={cn(
        "flex flex-col gap-4 border-t border-line-subtle pt-6 first:border-t-0 first:pt-0",
        className,
      )}
    >
      {title && (
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="text-section">
            {title}
          </h2>
          {description && <p className="text-body text-ink-secondary">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}
