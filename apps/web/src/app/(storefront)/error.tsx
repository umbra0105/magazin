"use client";

import Link from "next/link";
import { StoreButton, StorefrontState, storeButtonVariants } from "@ecom/ui";
import { getMessages } from "@/messages";

const m = getMessages().storefront.states.error;

/**
 * Eroare neprevăzută într-o pagină a vitrinei: header-ul și footer-ul rămân (cadrul e în layout), în locul paginii apare starea de
 * eroare cu «Reîncearcă» și un link spre prima pagină. Codul de referință (`digest`) leagă mesajul de jurnalul serverului; textul
 * erorii nu se arată niciodată.
 */
export default function StorefrontError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <StorefrontState
      role="alert"
      title={m.title}
      description={m.description}
      actions={
        <>
          <StoreButton size="lg" onClick={reset}>
            {m.retry}
          </StoreButton>
          <Link href="/" className={storeButtonVariants({ variant: "secondary", size: "lg" })}>
            {m.home}
          </Link>
        </>
      }
    >
      {error.digest ? (
        <p className="text-sm text-ink-secondary">{m.reference(error.digest)}</p>
      ) : null}
    </StorefrontState>
  );
}
