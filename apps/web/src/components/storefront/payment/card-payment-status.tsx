"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { storeButtonVariants } from "@ecom/ui";
import {
  pollCardPaymentAction,
  retryCardPaymentAction,
} from "@/app/(storefront)/comanda/plata/actions";
import type { PaymentStateDto } from "@/lib/card-payment-view";
import { getMessages } from "@/messages";

const m = getMessages().storefront.cardPayment;

const POLL_MS = 3000;
/** Cel mult 200 de interogări (aproximativ 10 minute); apoi pagina rămâne cu ultima stare, iar «Reîncearcă» e disponibil. */
const MAX_POLLS = 200;

/**
 * Pagina de așteptare a plății cu cardul: întreabă serverul la câteva secunde cât timp plata se verifică. NU confirmă nimic din ce
 * vine din adresa de retur: starea vine din baza noastră, actualizată doar de notificările procesatorului.
 */
export function CardPaymentStatus({
  paymentId,
  initial,
}: {
  paymentId: string;
  initial: PaymentStateDto;
}) {
  const [view, setView] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const polls = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const poll = useCallback(async () => {
    polls.current += 1;
    const result = await pollCardPaymentAction(paymentId);
    if (result.ok) setView(result.view);
  }, [paymentId]);

  useEffect(() => {
    if (view.state !== "checking" || polls.current >= MAX_POLLS) return;
    const timer = setTimeout(() => void poll(), POLL_MS);
    return () => clearTimeout(timer);
  }, [view, poll]);

  // starea nouă se anunță cititoarelor de ecran și primește focusul (titlul), ca schimbarea să nu treacă neobservată
  const previous = useRef(view.state);
  useEffect(() => {
    if (previous.current !== view.state) {
      previous.current = view.state;
      headingRef.current?.focus();
    }
  }, [view.state]);

  const retry = () => {
    setProblem(null);
    start(async () => {
      const result = await retryCardPaymentAction(paymentId);
      if (result.ok) {
        window.location.assign(result.redirect);
        return;
      }
      setProblem(
        result.code === "no_stock"
          ? m.retry.noStock
          : result.code === "expired"
            ? m.retry.expired
            : result.code === "unavailable"
              ? m.retry.unavailable
              : m.retry.failed,
      );
    });
  };

  const copy =
    view.state === "paid"
      ? { title: m.states.paid.title, body: m.states.paid.body(view.orderNumber) }
      : view.state === "failed"
        ? m.states.failed
        : view.state === "cancelled"
          ? m.states.cancelled
          : view.state === "stock_lost"
            ? m.states.stockLost
            : view.state === "attention"
              ? m.states.attention
              : m.states.checking;
  const slow = view.state === "checking" && (view.pendingSeconds ?? 0) >= 120;

  return (
    <div className="flex flex-col gap-4" data-card-payment-state={view.state}>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="heading-display text-3xl focus-visible:outline-none sm:text-4xl"
      >
        {copy.title}
      </h2>
      <p className="text-lg">{m.orderLine(view.orderNumber)}</p>
      <p className="max-w-prose" role="status" aria-live="polite">
        {copy.body}
        {slow ? ` ${m.states.checking.slow}` : ""}
      </p>
      {view.canRetry && (
        <div className="flex flex-col items-start gap-2">
          <button
            type="button"
            className={storeButtonVariants({ variant: "primary" })}
            onClick={retry}
            disabled={pending}
            data-retry-payment
          >
            {pending ? m.retry.starting : m.retry.button}
          </button>
          {view.retryUntilText && (
            <span className="text-sm text-ink-secondary">{m.retry.until(view.retryUntilText)}</span>
          )}
        </div>
      )}
      {problem && (
        <p role="alert" className="max-w-prose text-tone-problem-fg">
          {problem}
        </p>
      )}
      <p className="flex flex-wrap gap-4">
        <Link href="/comanda/urmarire" className="underline underline-offset-4">
          {m.track}
        </Link>
        <Link href="/" className="underline underline-offset-4">
          {m.home}
        </Link>
      </p>
    </div>
  );
}
