"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, buttonVariants } from "@ecom/ui";
import { authErrorMessage, authPost } from "@/lib/auth-client";
import { consumeHashToken } from "@/lib/hash-token";
import { getMessages } from "@/messages";
import { EmailRequestForm } from "./email-request-form";
import { FormAlert } from "./form-alert";

const m = getMessages().auth;

type State =
  | { phase: "reading" }
  | { phase: "missing" }
  | { phase: "ready"; token: string; notice?: string }
  | { phase: "confirming"; token: string }
  | { phase: "verified" }
  | { phase: "invalid" };

/**
 * Confirmarea emailului. Tokenul vine în fragmentul linkului (nu ajunge la server în adresă) și se
 * trimite doar când utilizatorul apasă butonul (POST): scanerele de linkuri nu îl pot consuma.
 */
export function VerifyEmailPanel() {
  const [state, setState] = useState<State>({ phase: "reading" });

  useEffect(() => {
    const token = consumeHashToken();
    setState(token ? { phase: "ready", token } : { phase: "missing" });
    // Același document, alt fragment (ex. linkul deschis într-o pagină deja încărcată).
    const onHashChange = () => {
      const next = consumeHashToken();
      if (next) setState({ phase: "ready", token: next });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  async function confirm(token: string) {
    setState({ phase: "confirming", token });
    const result = await authPost("/api/verify-email", { token });
    if (result.ok) {
      setState({ phase: "verified" });
    } else if (result.status === 429 || result.code === "NETWORK_ERROR") {
      // Limitare pe IP sau rețea: tokenul nu a fost consumat, se poate reîncerca.
      setState({ phase: "ready", token, notice: authErrorMessage(result, "verify", m) });
    } else {
      setState({ phase: "invalid" });
    }
  }

  if (state.phase === "reading") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {m.verify.loading}
      </p>
    );
  }

  if (state.phase === "verified") {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">{m.verify.successTitle}</h1>
        <FormAlert tone="success">{m.verify.success}</FormAlert>
        <Link href="/autentificare" className={buttonVariants({ className: "w-full" })}>
          {m.login.submit}
        </Link>
      </div>
    );
  }

  if (state.phase === "ready" || state.phase === "confirming") {
    const token = state.token;
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">{m.verify.confirmTitle}</h1>
        <p className="text-sm text-muted-foreground">{m.verify.confirmDescription}</p>
        {state.phase === "ready" && state.notice ? (
          <FormAlert tone="error">{state.notice}</FormAlert>
        ) : null}
        <Button
          type="button"
          disabled={state.phase === "confirming"}
          onClick={() => void confirm(token)}
        >
          {state.phase === "confirming" ? m.verify.confirming : m.verify.confirm}
        </Button>
      </div>
    );
  }

  // missing | invalid: mesaj clar + posibilitatea de a cere un mesaj nou.
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{m.verify.errorTitle}</h1>
      <FormAlert tone="error">
        {state.phase === "invalid" ? m.verify.error : m.verify.incomplete}
      </FormAlert>
      <p className="text-sm text-muted-foreground">{m.verify.resendDescription}</p>
      <EmailRequestForm
        endpoint="/api/auth/send-verification-email"
        body={{ callbackURL: "/verificare-email" }}
        context="verify"
        submitLabel={m.verify.resend}
        successMessage={m.verify.sent}
        idPrefix="verify"
      />
    </div>
  );
}
