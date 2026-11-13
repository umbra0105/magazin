"use client";

import { Button, EmptyState } from "@ecom/ui";
import { getMessages } from "@/messages";

const m = getMessages().states.error;

/**
 * Eroare neprevăzută într-o pagină de admin: cadrul (meniul) rămâne, iar în locul paginii apare starea de eroare cu o singură
 * acțiune, «Reîncearcă». Codul de referință (`digest`) leagă mesajul de intrarea din jurnalul serverului; nu se arată niciodată
 * textul erorii.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div role="alert">
      <EmptyState
        as="h2"
        title={m.title}
        description={m.description}
        action={
          <div className="flex flex-col items-center gap-3">
            <Button type="button" onClick={reset}>
              {m.retry}
            </Button>
            {error.digest ? (
              <p className="text-label text-ink-secondary">{m.reference(error.digest)}</p>
            ) : null}
          </div>
        }
      />
    </div>
  );
}
