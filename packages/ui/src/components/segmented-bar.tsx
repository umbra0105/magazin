import { cn } from "../lib/cn";

export type SegmentTone = "ok" | "low" | "out" | "neutral";

export interface Segment {
  key: string;
  /** Eticheta din legendă (ex. «În stoc»). */
  label: string;
  /** Numărul de elemente din segment (≥ 0). */
  value: number;
  tone: SegmentTone;
}

/** Culorile segmentelor (docs/17 §2.3): în stoc, stoc mic, epuizat, neutru. */
const TONE: Record<SegmentTone, string> = {
  ok: "bg-chart-1",
  low: "bg-chart-2",
  out: "bg-chart-3",
  neutral: "bg-chart-5",
};

export interface SegmentedBarProps {
  segments: readonly Segment[];
  /** Eticheta barei pentru cititoarele de ecran (legenda dedesubt are cifrele). */
  label: string;
  /** Formatarea numerelor din legendă (implicit cu separatorul românesc de mii). */
  formatValue?: (value: number) => string;
  className?: string;
}

const defaultFormat = (value: number): string => value.toLocaleString("ro-RO");

/** Segmentele cu valoare pozitivă, în ordinea dată; partea fiecăruia din bară (0–1). */
export function segmentShares(
  segments: readonly Segment[],
): Array<{ segment: Segment; share: number }> {
  const visible = segments.filter((segment) => Number.isFinite(segment.value) && segment.value > 0);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);
  return visible.map((segment) => ({ segment, share: total === 0 ? 0 : segment.value / total }));
}

/**
 * Bara de stoc segmentată (docs/17 §3): bară de 6 px cu rază pill, segmente în culorile din §2.3, legendă dedesubt cu punct și
 * număr (starea nu se transmite doar prin culoare). Bara e o imagine pentru cititoarele de ecran (`role="img"` cu rezumatul
 * în `aria-label`); legenda e text real.
 */
export function SegmentedBar({
  segments,
  label,
  formatValue = defaultFormat,
  className,
}: SegmentedBarProps) {
  const shares = segmentShares(segments);
  const summary = `${label}: ${segments.map((s) => `${s.label} ${formatValue(s.value)}`).join(", ")}`;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div
        role="img"
        aria-label={summary}
        className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-surface-hover"
      >
        {shares.map(({ segment, share }) => (
          <div
            key={segment.key}
            data-segment={segment.key}
            className={cn("h-full", TONE[segment.tone])}
            style={{ flexGrow: share }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-label text-ink-secondary">
        {segments.map((segment) => (
          <li key={segment.key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn("size-1.5 shrink-0 rounded-full", TONE[segment.tone])}
            />
            <span>{segment.label}</span>
            <span className="tabular-nums text-ink">{formatValue(segment.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
