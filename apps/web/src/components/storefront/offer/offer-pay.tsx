"use client";

import Link from "next/link";
import { useId, useRef, useState, useTransition } from "react";
import { storeButtonVariants } from "@ecom/ui";
import { payOfferAction } from "@/app/(oferta)/oferta/[jeton]/actions";
import { getMessages } from "@/messages";

const m = getMessages().storefront.offer;
const checkout = getMessages().storefront.checkout;

/**
 * Acordul și butonul «Plătește cu cardul» din pagina ofertei. Fără validarea nativă a browserului (mesaje proprii, cu focus pe bifă);
 * textul acordului și versiunea vin de la server, iar serverul le verifică din nou la plată.
 */
export function OfferPay({
  token,
  consent,
}: {
  token: string;
  consent: { text: string; version: string };
}) {
  const base = useId();
  const box = useRef<HTMLInputElement>(null);
  const [accepted, setAccepted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [consentError, setConsentError] = useState(false);
  const [pending, start] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (!accepted) {
      setConsentError(true);
      box.current?.focus();
      return;
    }
    setConsentError(false);
    start(async () => {
      const result = await payOfferAction({
        token,
        consent: { accepted: true, version: consent.version },
      });
      if (result.ok) {
        window.location.assign(result.redirect);
        return;
      }
      setProblem(m.errors[result.code]);
    });
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4" data-offer-pay>
      <div className="flex flex-col gap-2">
        <label className="flex min-h-11 items-start gap-3">
          <input
            ref={box}
            id={`${base}-consent`}
            type="checkbox"
            name="consent"
            checked={accepted}
            aria-invalid={consentError ? true : undefined}
            aria-describedby={`${base}-links${consentError ? ` ${base}-error` : ""}`}
            onChange={(e) => {
              setAccepted(e.target.checked);
              if (e.target.checked) setConsentError(false);
            }}
            className="mt-1 size-5 shrink-0 accent-brand"
          />
          <span>{consent.text}</span>
        </label>
        <p id={`${base}-links`} className="text-sm text-ink-secondary">
          <Link
            href="/termeni-si-conditii"
            target="_blank"
            rel="noopener"
            className="underline underline-offset-4"
          >
            {checkout.consentLinks.terms}
          </Link>{" "}
          ·{" "}
          <Link
            href="/politica-de-confidentialitate"
            target="_blank"
            rel="noopener"
            className="underline underline-offset-4"
          >
            {checkout.consentLinks.privacy}
          </Link>{" "}
          ({m.draftNotice})
        </p>
        {consentError ? (
          <p id={`${base}-error`} role="alert" className="text-sm text-tone-problem-fg">
            {m.consentError}
          </p>
        ) : null}
      </div>
      {problem ? (
        <p role="alert" className="max-w-prose text-tone-problem-fg">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-col items-start gap-2">
        <button
          type="submit"
          className={storeButtonVariants({ variant: "primary" })}
          disabled={pending}
          data-offer-pay-button
        >
          {pending ? m.paying : m.pay}
        </button>
        <p className="max-w-prose text-sm text-ink-secondary">{m.paymentNote}</p>
      </div>
    </form>
  );
}
