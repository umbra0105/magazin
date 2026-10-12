"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { consumeHashToken } from "@/lib/hash-token";
import { getMessages } from "@/messages";
import { FormAlert } from "./form-alert";
import { ResetForm } from "./reset-form";

const m = getMessages().auth;

/**
 * Pagina de resetare: tokenul vine în fragmentul linkului din email (`#token=…`), deci nu apare în
 * nicio cerere HTTP, în loguri sau în `Referer`. Se citește în browser, se scoate din adresă și
 * se trimite doar în corpul unui POST când utilizatorul alege parola nouă.
 */
export function ResetPanel({ minPasswordLength }: { minPasswordLength: number }) {
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setToken(consumeHashToken());
    // Același document, alt fragment (ex. linkul deschis într-o pagină deja încărcată).
    const onHashChange = () => {
      const next = consumeHashToken();
      if (next) setToken(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (token === undefined) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {m.reset.loading}
      </p>
    );
  }
  if (token === null) {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="error">{m.reset.missingToken}</FormAlert>
        <Link
          href="/recuperare-parola"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          {m.reset.requestNew}
        </Link>
      </div>
    );
  }
  return <ResetForm token={token} minPasswordLength={minPasswordLength} />;
}
