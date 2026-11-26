"use client";

import { StoreButton } from "@ecom/ui";
import type { CheckoutLoyaltyDto } from "@/lib/checkout-dto";
import { snapPoints } from "@/lib/snap-points";
import { getMessages } from "@/messages";

const m = getMessages().storefront.checkout.loyalty;

/** «Ai N puncte (N lei). Folosește-le?» Suma de plată o calculează mereu serverul; aici se alege doar numărul de puncte. */
export function PointsChoice(props: {
  id: string;
  redeem: NonNullable<CheckoutLoyaltyDto["redeem"]>;
  value: number;
  appliedText: string | null;
  pending: boolean;
  onChange: (points: number) => void;
}) {
  const { redeem, value, id } = props;
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3 rounded-card border border-line-control px-4 py-3"
      data-points-choice
    >
      <legend className="px-1 font-semibold">{m.title}</legend>
      <p data-points-balance>{redeem.balanceText}</p>
      <p id={`${id}-help`} className="text-sm text-ink-secondary">
        {redeem.maxText} {redeem.minPoints > 1 ? m.min(String(redeem.minPoints)) : null}
      </p>
      <label htmlFor={id} className="text-sm font-medium">
        {m.slider}
      </label>
      <div className="flex min-w-0 items-center gap-3">
        <input
          id={id}
          type="range"
          name="loyaltyPoints"
          min={0}
          max={redeem.maxPoints}
          step={1}
          value={Math.min(value, redeem.maxPoints)}
          aria-describedby={`${id}-help`}
          onChange={(e) =>
            props.onChange(
              snapPoints(Number(e.target.value), value, redeem.minPoints, redeem.maxPoints),
            )
          }
          className="min-h-11 min-w-0 flex-1 accent-brand"
        />
        <output htmlFor={id} className="w-16 shrink-0 text-right font-semibold tabular-nums">
          {value}
        </output>
      </div>
      <div className="flex flex-wrap gap-2">
        <StoreButton
          type="button"
          variant="secondary"
          onClick={() => props.onChange(redeem.maxPoints)}
          data-points-max
        >
          {m.useMax}
        </StoreButton>
        <StoreButton type="button" variant="secondary" onClick={() => props.onChange(0)}>
          {m.useNone}
        </StoreButton>
      </div>
      <p className="text-sm" aria-live="polite" data-points-applied>
        {props.pending ? "" : (props.appliedText ?? m.none)}
      </p>
    </fieldset>
  );
}
