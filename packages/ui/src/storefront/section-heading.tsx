import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** Titlul unei secțiuni: titlu mare din preset, o frază sub el, o acțiune opțională în dreapta. Nivelul (`h2`/`h3`) îl alege pagina. */
export function SectionHeading({
  title,
  lede,
  action,
  as: Title = "h2",
  className,
}: {
  title: string;
  lede?: string;
  action?: ReactNode;
  as?: "h2" | "h3";
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="max-w-2xl">
        <Title className="heading-display text-headline text-balance">{title}</Title>
        {lede ? <p className="mt-3 text-lede text-ink-secondary">{lede}</p> : null}
      </div>
      {action}
    </div>
  );
}
