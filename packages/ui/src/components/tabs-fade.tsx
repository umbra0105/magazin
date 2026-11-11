import { cn } from "../lib/cn";

/** Dimensiunile unei liste derulabile pe orizontală (cele din DOM: `scrollLeft`, `clientWidth`, `scrollWidth`). */
export interface ScrollMetrics {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

/** Toleranță de 1 px: zecimalele de la derulare și de la lățime nu fac dintr-un capăt atins un capăt «departe». */
const EDGE_TOLERANCE = 1;

/**
 * Pe care margini ale unei liste derulabile mai există conținut ascuns: `start` = în stânga (s-a derulat deja), `end` = în dreapta.
 * Funcție pură: o folosește `Tabs scrollable` ca să arate (sau nu) estomparea de pe margini.
 */
export function scrollEdges({ scrollLeft, clientWidth, scrollWidth }: ScrollMetrics): {
  start: boolean;
  end: boolean;
} {
  return {
    start: scrollLeft > EDGE_TOLERANCE,
    end: scrollLeft + clientWidth < scrollWidth - EDGE_TOLERANCE,
  };
}

/**
 * Estompare discretă pe marginea unei liste derulabile de taburi (docs/17 §3): gradient din `--surface-page` spre transparent,
 * deasupra taburilor, doar vizual (ascuns pentru cititoare de ecran, fără captarea mouse-ului, fără săgeți). Se desenează doar
 * pe marginea unde există conținut ascuns și dispare când derularea ajunge la capăt. Nu acoperă linia de jos a listei.
 */
export function TabsFade({ edge }: { edge: "start" | "end" }) {
  return (
    <span
      aria-hidden="true"
      data-tabs-fade={edge}
      className={cn(
        "pointer-events-none absolute top-0 bottom-px w-8 from-surface-page to-transparent",
        edge === "start" ? "left-0 bg-linear-to-r" : "right-0 bg-linear-to-l",
      )}
    />
  );
}
