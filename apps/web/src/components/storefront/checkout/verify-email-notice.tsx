"use client";

import Link from "next/link";
import { useState } from "react";
import { StoreButton, storeButtonVariants } from "@ecom/ui";
import { authPost } from "@/lib/auth-client";
import { getMessages } from "@/messages";

const m = getMessages().digital.checkout;
const common = getMessages().storefront.checkout;

/**
 * Cont cu emailul neverificat, la un coș cu produse digitale (Faza 14c): produsele digitale se comandă doar cu un cont verificat.
 * Același endpoint de retrimitere ca pe pagina de autentificare; nu schimbă regulile contului.
 */
export function VerifyEmailNotice({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  async function resend() {
    setState("sending");
    const result = await authPost("/api/auth/send-verification-email", {
      email,
      callbackURL: "/verificare-email",
    });
    setState(result.ok ? "sent" : "failed");
  }

  return (
    <div className="flex max-w-prose flex-col gap-4" data-verify-email-notice>
      <p className="text-ink-secondary">{m.verifyLede}</p>
      <p role="status" className="text-sm" data-verify-email-status={state}>
        {state === "sent" ? m.verifyResent : state === "failed" ? m.verifyFailed : null}
      </p>
      <div className="flex flex-wrap gap-3">
        <StoreButton type="button" disabled={state === "sending"} onClick={() => void resend()}>
          {m.verifyResend}
        </StoreButton>
        <Link href="/checkout" className={storeButtonVariants({ variant: "secondary" })}>
          {m.verifyReload}
        </Link>
        <Link href="/cos" className={storeButtonVariants({ variant: "secondary" })}>
          {common.backToCart}
        </Link>
      </div>
    </div>
  );
}
