"use client";

import { useState, useTransition } from "react";
import { storeButtonVariants } from "@ecom/ui";
import { payByLinkAction } from "@/app/(storefront)/comanda/plata/actions";
import { getMessages } from "@/messages";

const m = getMessages().storefront.cardPayment;

/** «Plătește cu cardul» din linkul de reîncercare: pornește o tentativă nouă și duce clientul la procesator. */
export function PayByLinkButton({ token }: { token: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const pay = () => {
    setProblem(null);
    start(async () => {
      const result = await payByLinkAction(token);
      if (result.ok) {
        window.location.assign(result.redirect);
        return;
      }
      setProblem(
        result.code === "no_stock"
          ? m.retry.noStock
          : result.code === "expired" || result.code === "forbidden"
            ? m.retry.expired
            : result.code === "unavailable"
              ? m.retry.unavailable
              : m.retry.failed,
      );
    });
  };

  return (
    <div className="flex flex-col items-start gap-3">
      <button
        type="button"
        className={storeButtonVariants({ variant: "primary" })}
        onClick={pay}
        disabled={pending}
        data-pay-by-link
      >
        {pending ? m.retry.starting : m.link.pay}
      </button>
      {problem && (
        <p role="alert" className="max-w-prose text-tone-problem-fg">
          {problem}
        </p>
      )}
    </div>
  );
}
