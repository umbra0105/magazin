"use client";

import { Minus, Plus } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { getMessages } from "@/messages";

const m = getMessages().storefront.cart;

/**
 * Selectorul de cantitate ÎN PAȘI (D11): numărul de pași (cutii, saci, bucăți), nu cantitatea brută; cantitatea comandată e mereu
 * multiplu exact al pasului. Aici se alege doar numărul întreg; serverul validează pasul, minimul, stocul și plafoanele. Butoanele
 * au 44 px, câmpul se confirmă la ieșirea din el sau cu Enter, iar valoarea invalidă revine la ultima bună.
 */
export function QuantityStepper({
  steps,
  minSteps = 1,
  label,
  disabled = false,
  onChange,
}: {
  steps: number;
  minSteps?: number;
  /** Eticheta câmpului (cititoare de ecran): «Cantitate pentru <produs>». */
  label: string;
  disabled?: boolean;
  onChange: (steps: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(steps));
  useEffect(() => setDraft(String(steps)), [steps]);

  const commit = (value: string) => {
    const parsed = /^[0-9]{1,7}$/.test(value.trim())
      ? Number.parseInt(value.trim(), 10)
      : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < minSteps) {
      setDraft(String(steps));
      return;
    }
    if (parsed !== steps) onChange(parsed);
  };

  const button =
    "inline-flex size-11 items-center justify-center text-ink transition-colors duration-(--motion) hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand disabled:opacity-40";

  return (
    <div className="inline-flex items-center overflow-hidden rounded-full border border-line-control bg-surface-page">
      <button
        type="button"
        className={button}
        aria-label={m.decrease}
        disabled={disabled || steps <= minSteps}
        onClick={() => onChange(steps - 1)}
      >
        <Minus aria-hidden="true" className="size-4" />
      </button>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        value={draft}
        inputMode="numeric"
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(event.currentTarget.value);
          }
        }}
        className="h-11 w-12 bg-transparent text-center text-base font-semibold tabular-nums text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
      />
      <button
        type="button"
        className={button}
        aria-label={m.increase}
        disabled={disabled}
        onClick={() => onChange(steps + 1)}
      >
        <Plus aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
