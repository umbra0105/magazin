import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

/**
 * Schelet de încărcare (docs/17 §3): bloc în `--surface-hover`, fără rotițe care ocupă tot ecranul. Dimensiunile se dau prin
 * clase (`h-4 w-40`); animația de puls dispare la `prefers-reduced-motion`. Ascuns cititoarelor de ecran: regiunea care se
 * încarcă primește `aria-busy` de la cel care îl folosește.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("rounded-md bg-surface-hover motion-safe:animate-pulse", className)}
      {...props}
    />
  );
}
