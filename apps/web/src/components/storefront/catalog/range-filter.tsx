"use client";

import { useEffect, useId, useState } from "react";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog.filters;

/**
 * Filtrul pe interval numeric (debit, putere, volum piscină). Fără JavaScript sunt două câmpuri numerice, `min_<cod>` și
 * `max_<cod>` (formularul GET le trimite și pagina le aduce la forma canonică). După hidratare apar și două glisoare legate de
 * câmpuri, între limitele reale ale valorilor din listă. Câmpurile goale înseamnă fără limită.
 */
export function RangeFilter({
  code,
  name,
  unit,
  min,
  max,
  selectedMin,
  selectedMax,
  count,
}: {
  code: string;
  name: string;
  unit: string | null;
  min: number;
  max: number;
  selectedMin: number | null;
  selectedMax: number | null;
  count: number;
}) {
  const id = useId();
  const [lo, setLo] = useState<string>(selectedMin === null ? "" : String(selectedMin));
  const [hi, setHi] = useState<string>(selectedMax === null ? "" : String(selectedMax));
  const [enhanced, setEnhanced] = useState(false);
  useEffect(() => setEnhanced(true), []);

  const numLo = lo === "" ? min : Number(lo);
  const numHi = hi === "" ? max : Number(hi);
  const step = max - min > 50 ? 1 : max - min > 5 ? 0.5 : 0.1;
  const label = m.rangeLabel(name, unit);

  const slider = (side: "lo" | "hi") => {
    const value = side === "lo" ? Math.min(numLo, numHi) : Math.max(numLo, numHi);
    return (
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : min}
        aria-label={side === "lo" ? m.sliderMin(name) : m.sliderMax(name)}
        onChange={(event) => {
          const next = event.target.value;
          if (side === "lo") setLo(Number(next) <= min ? "" : next);
          else setHi(Number(next) >= max ? "" : next);
        }}
        className="h-6 w-full accent-brand"
        data-range-slider={side}
      />
    );
  };

  return (
    <fieldset className="flex flex-col gap-3" data-range-filter={code}>
      <legend className="flex w-full items-baseline justify-between gap-2 text-sm font-semibold">
        <span>{label}</span>
        <span className="font-normal text-ink-secondary">
          {min}–{max}
          {unit ? ` ${unit}` : ""} ({count})
        </span>
      </legend>
      {enhanced ? (
        <div className="flex flex-col gap-1">
          {slider("lo")}
          {slider("hi")}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm text-ink-secondary" htmlFor={`${id}-min`}>
          {m.min}
          <input
            id={`${id}-min`}
            name={`min_${code}`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder={String(min)}
            value={lo}
            onChange={(event) => setLo(event.target.value)}
            className="h-11 rounded-full border border-line-input bg-surface-page px-4 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-ink-secondary" htmlFor={`${id}-max`}>
          {m.max}
          <input
            id={`${id}-max`}
            name={`max_${code}`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder={String(max)}
            value={hi}
            onChange={(event) => setHi(event.target.value)}
            className="h-11 rounded-full border border-line-input bg-surface-page px-4 text-base text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          />
        </label>
      </div>
    </fieldset>
  );
}
