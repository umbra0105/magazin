import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";
import type { StorePillTone } from "./store-pill";

/**
 * Cardul mare al vitrinei: fundal înclinat (`--sf-card`), rază mare din preset, fără bordură și fără umbră (umbra e doar a
 * straturilor plutitoare: meniu, panou, dialog). Conținutul își pune singur umplutura.
 */
export function StoreCard({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("overflow-hidden rounded-card bg-card text-ink", className)} {...props} />
  );
}

/** Punctul stării (discret, lângă text): culoarea vine din tonul semantic al vitrinei. */
const DOT: Record<StorePillTone, string> = {
  neutral: "bg-tone-neutral-fg",
  success: "bg-tone-success-fg",
  warning: "bg-tone-warning-fg",
  problem: "bg-tone-problem-fg",
  info: "bg-tone-info-fg",
};

export interface ProductCardProps {
  /** Adresa produsului (`/produs/<slug>`): legătură reală, în HTML-ul de pe server. */
  href: string;
  name: string;
  brand?: string | undefined;
  /** Imaginea produsului (elementul `<img>`/`next/image`, cu `alt` și dimensiuni): componenta nu alege sursa. */
  media: ReactNode;
  /** Prețul gata formatat de apelant: cardul nu calculează și nu formatează bani (motorul de prețuri e în Faza 8). */
  price: string;
  oldPrice?: string | undefined;
  status?: { label: string; detail?: string | undefined; tone: StorePillTone } | undefined;
  /** Marcajul din colțul imaginii (eticheta energetică), desenat de apelant. */
  badge?: ReactNode;
  /** Acțiune în colțul din dreapta sus al imaginii (de exemplu «Favorite»): deasupra legăturii care acoperă cardul, deci se poate apăsa separat. */
  action?: ReactNode;
  /** Nivelul titlului în pagină (h2 sub un h1 de listă, h3 sub un h2 de secțiune). */
  headingLevel?: 2 | 3;
  /** `vertical`: imaginea sus (grilă); `horizontal`: imaginea în stânga, textul în dreapta (listă). Vine din setarea de aspect. */
  layout?: "vertical" | "horizontal";
  className?: string;
}

/**
 * Cardul de produs (structură, Faza 6; conținutul și datele vin în Faza 7). Imaginea e prima și ocupă partea de sus, textul al
 * doilea: nume proeminent, brand ca linie separată, prețul și starea mereu vizibile. Un singur link (titlul) acoperă tot cardul,
 * deci tabulatorul oprește o dată pe produs, iar focusul se vede pe card.
 */
export function ProductCard({
  href,
  name,
  brand,
  media,
  price,
  oldPrice,
  status,
  badge,
  action,
  headingLevel = 3,
  layout = "vertical",
  className,
}: ProductCardProps) {
  const horizontal = layout === "horizontal";
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article
      data-layout={layout}
      className={cn(
        "group relative flex overflow-hidden rounded-card bg-card text-ink transition-colors duration-(--motion) " +
          "hover:bg-card-hover has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-brand",
        horizontal ? "flex-row" : "flex-col",
        className,
      )}
    >
      <div
        className={cn(
          // masa foto (`--sf-media-surface`): aceeași suprafață, același raport și aceeași umplutură la toate cardurile;
          // fotografia se vede întreagă (object-contain), nu tăiată
          // `multiply`: albul fotografiei devine culoarea mesei foto, deci fundalul alb al fotografiei nu se mai vede ca un dreptunghi
          "relative isolate aspect-square overflow-hidden bg-media p-2 [&_img]:size-full [&_img]:object-contain [&_img]:mix-blend-multiply",
          horizontal && "w-2/5 shrink-0 sm:w-1/3",
        )}
      >
        {media}
        {badge ? <span className="absolute left-3 top-3 z-10">{badge}</span> : null}
        {action ? <span className="absolute right-2 top-2 z-20">{action}</span> : null}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4 sm:p-5">
        {brand ? <p className="text-xs font-medium text-ink-secondary">{brand}</p> : null}
        <Heading className="break-words text-lg font-semibold leading-snug">
          <a
            href={href}
            className="rounded-sm outline-none after:absolute after:inset-0 after:content-['']"
          >
            {name}
          </a>
        </Heading>
        <div className="mt-auto flex flex-wrap items-baseline gap-x-3 gap-y-1 pt-3">
          <span className="whitespace-nowrap text-xl font-semibold tracking-tight sm:text-2xl">
            {price}
          </span>
          {oldPrice ? <s className="text-sm text-ink-secondary">{oldPrice}</s> : null}
        </div>
        {status ? (
          // înălțime rezervată (4 rânduri de text pe telefon, 2 de la sm; plus umplutura de sus): prețul de deasupra rămâne pe aceeași linie la toate cardurile
          // dintr-un rând, oricât de lungă e starea («La comandă · livrare în aproximativ 21 de zile»)
          <p
            className="flex min-h-21 items-start gap-2 pt-1 text-sm text-ink-secondary sm:min-h-11"
            data-status={status.tone}
          >
            <span
              aria-hidden="true"
              className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[status.tone])}
            />
            <span>
              <span className="font-medium text-ink">{status.label}</span>
              {status.detail ? <span> {status.detail}</span> : null}
            </span>
          </p>
        ) : null}
      </div>
    </article>
  );
}
