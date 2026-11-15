import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";
import { StorePill, type StorePillTone } from "./store-pill";

/**
 * Cardul mare al vitrinei: fundal înclinat (`--sf-card`), rază mare din preset, fără bordură și fără umbră (umbra e doar a
 * straturilor plutitoare: meniu, panou, dialog). Conținutul își pune singur umplutura.
 */
export function StoreCard({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("overflow-hidden rounded-card bg-card text-ink", className)} {...props} />
  );
}

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
  status?: { label: string; tone: StorePillTone } | undefined;
  /** Nivelul titlului în pagină (h2 sub un h1 de listă, h3 sub un h2 de secțiune). */
  headingLevel?: 2 | 3;
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
  headingLevel = 3,
  className,
}: ProductCardProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-card bg-card text-ink transition-colors duration-(--motion) " +
          "hover:bg-card-hover has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-brand",
        className,
      )}
    >
      <div className="relative aspect-square overflow-hidden bg-surface-page [&_img]:size-full [&_img]:object-contain">
        {media}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-5">
        {brand ? <p className="text-sm text-ink-secondary">{brand}</p> : null}
        <Heading className="text-lg font-semibold leading-snug">
          <a
            href={href}
            className="rounded-sm outline-none after:absolute after:inset-0 after:content-['']"
          >
            {name}
          </a>
        </Heading>
        <div className="mt-auto flex flex-wrap items-baseline gap-x-3 gap-y-1 pt-3">
          <span className="text-xl font-semibold">{price}</span>
          {oldPrice ? <s className="text-sm text-ink-secondary">{oldPrice}</s> : null}
        </div>
        {status ? (
          <div className="pt-1">
            <StorePill tone={status.tone}>{status.label}</StorePill>
          </div>
        ) : null}
      </div>
    </article>
  );
}
