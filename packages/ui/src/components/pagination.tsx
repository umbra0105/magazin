import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Numerele de pagină care se arată (cel mult 7 poziții): toate până la 7 pagini; altfel prima, ultima, pagina curentă cu vecinii
 * ei și «gap» (se desenează «…») între ele. Pagina se aduce în interval, iar niciun număr nu apare de două ori.
 */
export function pageWindow(page: number, pageCount: number): Array<number | "gap"> {
  const count = Math.max(1, Math.trunc(pageCount) || 1);
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), count);
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, "gap", count];
  if (current >= count - 3) return [1, "gap", count - 4, count - 3, count - 2, count - 1, count];
  return [1, "gap", current - 1, current, current + 1, "gap", count];
}

export interface PaginationLinkProps {
  href: string;
  className: string;
  children: ReactNode;
  "aria-label": string;
  "aria-current"?: "page";
  rel?: "prev" | "next";
}

export interface PaginationProps {
  /** Numele navigării pentru cititoarele de ecran («Paginare»). */
  label: string;
  page: number;
  pageCount: number;
  hrefFor: (page: number) => string;
  previousLabel: string;
  nextLabel: string;
  /** Numele accesibil al unei pagini («Pagina 3»). */
  pageLabel: (page: number) => string;
  /** Rezumatul text («Pagina 2 din 5»), singurul vizibil pe telefon. */
  summary: (page: number, pageCount: number) => string;
  /** Stânga: selectorul «rânduri pe pagină» (o componentă a aplicației, care știe să schimbe adresa). */
  start?: ReactNode;
  /** Cum se desenează o legătură; implicit un `<a>`. Aplicația dă `Link` din Next, pentru navigare fără reîncărcare. */
  renderLink?: (props: PaginationLinkProps) => ReactNode;
  className?: string;
}

const ITEM =
  "inline-flex size-11 items-center justify-center rounded-sm border text-body tabular-nums md:size-8 md:text-compact";
const ITEM_LINK =
  "border-transparent text-ink transition-colors duration-(--motion) hover:bg-surface-hover " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";
const ITEM_CURRENT = "border-ink text-ink";
const ITEM_DISABLED = "border-transparent text-ink-disabled";

const defaultLink = ({ children, ...props }: PaginationLinkProps): ReactNode => (
  <a {...props}>{children}</a>
);

/**
 * Paginarea (docs/17 §3): în stânga selectorul de rânduri pe pagină (`start`), în dreapta butoane de 32 px cu rază 6 px, pagina
 * curentă cu bordură `--text-primary`. Pe telefon: butoane de 44 px și doar «Pagina 2 din 5» între ele. Fără `start`, la o singură
 * pagină nu se desenează nimic; cu `start`, bara rămâne (altfel, după ce alegi 100 de rânduri, nu te mai poți întoarce la 25).
 */
export function Pagination({
  label,
  page,
  pageCount,
  hrefFor,
  previousLabel,
  nextLabel,
  pageLabel,
  summary,
  start,
  renderLink = defaultLink,
  className,
}: PaginationProps) {
  const count = Math.max(1, Math.trunc(pageCount) || 1);
  if (count <= 1 && !start) return null;
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), count);
  const hasPages = count > 1;
  return (
    <nav
      aria-label={label}
      className={cn("flex flex-wrap items-center justify-between gap-3", className)}
    >
      <div className="flex items-center gap-2 text-body text-ink-secondary">{start}</div>
      {hasPages ? (
        <div className="flex items-center gap-1">
          {current > 1 ? (
            renderLink({
              href: hrefFor(current - 1),
              className: cn(ITEM, ITEM_LINK),
              rel: "prev",
              "aria-label": previousLabel,
              children: <Chevron direction="left" />,
            })
          ) : (
            <span
              aria-disabled="true"
              aria-label={previousLabel}
              className={cn(ITEM, ITEM_DISABLED)}
            >
              <Chevron direction="left" />
            </span>
          )}
          <span className="px-2 text-body text-ink-secondary md:hidden">
            {summary(current, count)}
          </span>
          <ol className="hidden items-center gap-1 md:flex">
            {pageWindow(current, count).map((item, index) =>
              item === "gap" ? (
                <li key={`gap-${index}`} aria-hidden="true" className="px-1 text-ink-secondary">
                  …
                </li>
              ) : (
                <li key={item}>
                  {item === current ? (
                    <span aria-current="page" className={cn(ITEM, ITEM_CURRENT)}>
                      {item}
                    </span>
                  ) : (
                    renderLink({
                      href: hrefFor(item),
                      className: cn(ITEM, ITEM_LINK),
                      "aria-label": pageLabel(item),
                      children: item,
                    })
                  )}
                </li>
              ),
            )}
          </ol>
          {current < count ? (
            renderLink({
              href: hrefFor(current + 1),
              className: cn(ITEM, ITEM_LINK),
              rel: "next",
              "aria-label": nextLabel,
              children: <Chevron direction="right" />,
            })
          ) : (
            <span aria-disabled="true" aria-label={nextLabel} className={cn(ITEM, ITEM_DISABLED)}>
              <Chevron direction="right" />
            </span>
          )}
        </div>
      ) : null}
    </nav>
  );
}

/** Săgeată liniară (1,5 px, 16 px), moștenește culoarea textului; nu se amestecă seturi de pictograme. */
function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <path d={direction === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}
