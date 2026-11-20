"use client";

import { useId, useState } from "react";
import { Button, Input, Label } from "@ecom/ui";
import { getMessages } from "@/messages";

const t = getMessages().admin.orders.offers;

/**
 * Linkul ofertei, arătat o SINGURĂ dată (la creare și la retrimitere): jetonul nu se păstrează în clar nicăieri, deci după ce
 * panoul dispare linkul nu se mai poate citi, ci doar înlocui cu unul nou. Copierea trece prin clipboard-ul browserului; dacă nu
 * există, câmpul rămâne selectabil.
 */
export function LinkPanel({ link, emailQueued }: { link: string; emailQueued: boolean | null }) {
  const id = useId();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      document.getElementById(id)?.focus();
      (document.getElementById(id) as HTMLInputElement | null)?.select();
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-surface-subtle p-4" data-offer-link-panel>
      <p className="text-body">{t.created.linkHelp}</p>
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{t.created.linkLabel}</Label>
        <div className="flex flex-wrap gap-2">
          <Input id={id} readOnly value={link} className="min-w-64 flex-1" data-offer-link />
          <Button type="button" variant="outline" onClick={copy}>
            {t.created.copy}
          </Button>
        </div>
      </div>
      <p role="status" aria-live="polite" className="text-body text-ink-secondary">
        {copied ? t.created.copied : ""}
      </p>
      {emailQueued === true && <p className="text-body">{t.created.emailQueued}</p>}
      {emailQueued === false && (
        <p role="alert" className="text-body text-tone-problem-fg">
          {t.created.emailFailed}
        </p>
      )}
    </div>
  );
}
