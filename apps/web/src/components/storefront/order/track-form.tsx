"use client";

import { useId, useState } from "react";
import { StoreButton } from "@ecom/ui";
import {
  trackOrderAction,
  type SerializedOrder,
} from "@/app/(storefront)/comanda/urmarire/actions";
import { EMAIL_PATTERN } from "@/lib/checkout-validation";
import { getMessages } from "@/messages";
import { FIELD, Field } from "../checkout/fields";
import { OrderSummaryView } from "./order-summary-view";

const m = getMessages().storefront.order;

/** Urmărirea comenzii (număr + email): răspuns identic pentru orice pereche necunoscută; rezultatul fără date personale. */
export function TrackForm({
  format,
  timeZone,
}: {
  format: { currency: string; locale: string };
  timeZone: string;
}) {
  const base = useId();
  const [number, setNumber] = useState("");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [order, setOrder] = useState<SerializedOrder | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setOrder(null);
    if (number.trim() === "" || !EMAIL_PATTERN.test(email.trim())) {
      setMessage(m.trackInvalid);
      document.getElementById(`${base}-number`)?.focus();
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const result = await trackOrderAction({ number, email });
      if (result.status === "found") setOrder(result.order);
      else if (result.status === "rate_limited") setMessage(m.trackRateLimited);
      else if (result.status === "invalid") setMessage(m.trackInvalid);
      else setMessage(m.trackNotFound);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <form noValidate onSubmit={submit} className="grid max-w-xl gap-4" data-track-form>
        <Field id={`${base}-number`} label={m.trackNumber}>
          {(a) => (
            <input
              {...a}
              name="number"
              type="text"
              autoComplete="off"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              className={FIELD}
            />
          )}
        </Field>
        <Field id={`${base}-email`} label={m.trackEmail}>
          {(a) => (
            <input
              {...a}
              name="email"
              type="text"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={FIELD}
            />
          )}
        </Field>
        <div>
          <StoreButton type="submit" disabled={pending}>
            {pending ? m.trackSearching : m.trackSubmit}
          </StoreButton>
        </div>
        <p role="status" className="min-h-6 text-tone-problem-fg" data-track-message>
          {message}
        </p>
      </form>
      {order ? (
        <section aria-label={m.trackTitle} data-track-result className="flex flex-col gap-2">
          <p className="text-lg font-semibold">{order.number}</p>
          <OrderSummaryView
            order={{
              ...order,
              placedAt: new Date(order.placedAt),
              reservationExpiresAt: order.reservationExpiresAt
                ? new Date(order.reservationExpiresAt)
                : null,
            }}
            format={format}
            timeZone={timeZone}
          />
        </section>
      ) : null}
    </div>
  );
}
