"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Button, Dialog } from "@ecom/ui";
import { cancelOfferAction, reissueOfferAction } from "@/app/(admin)/admin/comenzi/oferte/actions";
import { LinkPanel } from "@/components/admin/offers/link-panel";
import { getMessages } from "@/messages";

const t = getMessages().admin.orders.offers;
const close = getMessages().admin.orders.actions.close;

type DialogId = "reissue" | "cancel" | null;

/**
 * Acțiunile unei oferte active (decizia A): «Retrimite (link nou)» și «Anulează oferta», fiecare cu dialog propriu (fără
 * `window.confirm`). Jetonul nou apare o singură dată, în panoul de link; refresh-ul paginii nu-l mai poate arăta. Permisiunea
 * `orders.offers` se verifică din nou pe server la fiecare acțiune.
 */
export function OfferDetailActions({ offerId }: { offerId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState<DialogId>(null);
  const [sendEmail, setSendEmail] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ link: string; emailQueued: boolean | null } | null>(null);
  const [pending, start] = useTransition();

  const reissue = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    start(async () => {
      setProblem(null);
      const result = await reissueOfferAction({ offerId, sendEmail });
      if (!result.ok) return setProblem(t.wizard.errors[result.code]);
      setOpen(null);
      setIssued({ link: result.link, emailQueued: result.emailQueued });
      router.refresh();
    });
  };

  const cancel = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    start(async () => {
      setProblem(null);
      const result = await cancelOfferAction({ offerId });
      if (!result.ok) return setProblem(t.wizard.errors[result.code]);
      setOpen(null);
      setIssued(null);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-3" data-offer-actions>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => setOpen("reissue")}>
          {t.detail.reissue}
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen("cancel")}>
          {t.detail.cancel}
        </Button>
      </div>
      {problem && (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {problem}
        </p>
      )}
      {issued && <LinkPanel link={issued.link} emailQueued={issued.emailQueued} />}

      {open === "reissue" && (
        <Dialog
          open
          onClose={() => setOpen(null)}
          title={t.detail.reissue}
          description={t.detail.reissueHelp}
          closeLabel={close}
          className="max-w-lg"
        >
          <form noValidate onSubmit={reissue} className="flex flex-col gap-4">
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={sendEmail}
                onChange={(e) => setSendEmail(e.target.checked)}
                className="size-5 accent-brand"
              />
              <span>{t.detail.reissueSend}</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(null)}>
                {t.detail.keep}
              </Button>
              <Button type="submit" disabled={pending}>
                {t.detail.reissueConfirm}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {open === "cancel" && (
        <Dialog
          open
          onClose={() => setOpen(null)}
          title={t.detail.cancel}
          description={t.detail.cancelHelp}
          closeLabel={close}
          className="max-w-lg"
        >
          <form noValidate onSubmit={cancel} className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(null)}>
              {t.detail.keep}
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {t.detail.cancelConfirm}
            </Button>
          </form>
        </Dialog>
      )}
    </div>
  );
}
