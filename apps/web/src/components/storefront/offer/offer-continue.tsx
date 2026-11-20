"use client";

import { useState, useTransition } from "react";
import { storeButtonVariants } from "@ecom/ui";
import { continueOfferPaymentAction } from "@/app/(oferta)/oferta/[jeton]/actions";
import { getMessages } from "@/messages";

const m = getMessages().storefront.offer;

/**
 * «Continuă plata» din linkul unei oferte deja transformate în comandă, când plata cu cardul s-a oprit (Faza 11, C8). Fără bifa
 * Termenilor: ea s-a dat la prima plată și e salvată pe comandă. Serverul verifică după jeton că plata se mai poate continua și
 * trimite clientul pe pagina de reîncercare a plății din Faza 10; nu se creează o a doua comandă.
 */
export function OfferContinue({ token }: { token: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const go = () => {
    setProblem(null);
    start(async () => {
      const result = await continueOfferPaymentAction({ token });
      if (result.ok) {
        window.location.assign(result.redirect);
        return;
      }
      setProblem(m.converted.errors[result.code]);
    });
  };

  return (
    <div className="flex flex-col items-start gap-3">
      <button
        type="button"
        className={storeButtonVariants({ variant: "primary" })}
        onClick={go}
        disabled={pending}
        data-offer-continue
      >
        {pending ? m.converted.continuing : m.converted.continue}
      </button>
      {problem ? (
        <p role="alert" className="max-w-prose text-tone-problem-fg">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
