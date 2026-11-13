"use client";

import { Button } from "@ecom/ui";
import { getMessages } from "@/messages";
import "./globals.css";

const m = getMessages().states.error;

/**
 * Ultima plasă: o eroare în layout-ul rădăcină (înlocuiește tot documentul, deci are propriul `<html>`). Fără baza de date,
 * fără setări: doar textul din mesaje și tokenii adminului (suprafața e pusă pe `<body>`).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ro">
      <body data-surface="admin" className="bg-surface-page font-sans text-body text-ink">
        <main
          role="alert"
          className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 py-8 text-center"
        >
          <h1 className="text-section">{m.title}</h1>
          <p className="max-w-prose text-body text-ink-secondary">{m.description}</p>
          <Button type="button" onClick={reset}>
            {m.retry}
          </Button>
          {error.digest ? (
            <p className="text-label text-ink-secondary">{m.reference(error.digest)}</p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
