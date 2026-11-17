import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { Container } from "./container";

export interface HeroSplitProps {
  title: string;
  lede?: string | undefined;
  /** Acțiunile (legături reale, nu butoane moarte); de obicei una principală. */
  actions?: ReactNode;
  /** Coloana din dreapta: de obicei un produs pe masa foto (`HeroProduct`). Pe telefon trece sub text. */
  aside?: ReactNode;
  className?: string;
}

/**
 * Hero-ul fără fotografie de magazin (docs/21 §2.3, direcția «echilibrat»): pe fundalul paginii, în două coloane. Textul, aliniat la
 * stânga, are titlul mare din preset, o singură frază și acțiunea; în dreapta, un produs real pe masa foto din token. Nu are strat
 * întunecat și nicio animație de intrare. Fără `aside` textul ocupă toată lățimea. `data-hero` rămâne, ca header-ul «sticlă» să
 * știe că pagina începe cu un hero (acolo se așază sub el).
 */
export function HeroSplit({ title, lede, actions, aside, className }: HeroSplitProps) {
  return (
    <section data-hero className={cn("py-section", className)}>
      <Container className="grid items-center gap-10 lg:grid-cols-12 lg:gap-14">
        <div className={cn("flex flex-col", aside ? "lg:col-span-6" : "lg:col-span-12")}>
          <h1 className="heading-display text-hero text-balance">{title}</h1>
          {lede ? <p className="mt-6 max-w-xl text-lede text-ink-secondary">{lede}</p> : null}
          {actions ? <div className="mt-8 flex flex-wrap gap-3">{actions}</div> : null}
        </div>
        {aside ? <div className="lg:col-span-6">{aside}</div> : null}
      </Container>
    </section>
  );
}
