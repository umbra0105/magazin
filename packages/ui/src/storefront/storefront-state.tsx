import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { Container } from "./container";

export interface StorefrontStateProps {
  title: string;
  description?: string | undefined;
  /** Acțiunile (de obicei un link-buton principal și unul secundar). */
  actions?: ReactNode;
  /** Conținut în plus sub acțiuni (de exemplu o listă de categorii, codul de referință). */
  children?: ReactNode;
  /** `alert` la erori (anunțat de cititoarele de ecran). */
  role?: "alert" | "status";
  className?: string;
}

/**
 * Starea unei pagini întregi a vitrinei (404, eroare, mentenanță): titlul e `h1` (pagina nu are alt titlu), apoi o frază de
 * explicație și cel mult două acțiuni, centrate, cu aerisire generoasă. Fără text propriu: totul vine de la cel care o folosește.
 */
export function StorefrontState({
  title,
  description,
  actions,
  children,
  role,
  className,
}: StorefrontStateProps) {
  return (
    <section {...(role ? { role } : {})} className={cn("py-section", className)}>
      <Container className="flex max-w-3xl flex-col items-center gap-6 text-center">
        <h1 className="heading-display text-headline text-balance">{title}</h1>
        {description ? (
          <p className="max-w-xl text-lede text-ink-secondary">{description}</p>
        ) : null}
        {actions ? <div className="flex flex-wrap justify-center gap-3">{actions}</div> : null}
        {children}
      </Container>
    </section>
  );
}
