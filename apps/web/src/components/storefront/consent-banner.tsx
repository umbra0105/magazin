"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Dialog, StoreButton } from "@ecom/ui";
import {
  ACCEPT_ALL,
  CONSENT_CATEGORIES,
  REFUSE_ALL,
  consentCookieString,
  parseConsent,
  readConsentCookie,
  type ConsentChoices,
} from "@/lib/consent";
import { getMessages } from "@/messages";

const m = getMessages().storefront.consent;

/** Evenimentul prin care subsolul redeschide preferințele (butonul «Setările cookie-urilor»). */
export const CONSENT_OPEN_EVENT = "ecom:consent-open";

/**
 * Bannerul de consimțământ (docs/19 §1: implicit REFUZAT). Cât timp nu există o alegere salvată, arată bannerul și NIMIC care
 * cere consimțământ nu pornește. «Refuz» și «Acceptă tot» au același stil și aceeași mărime (refuzul e la fel de ușor ca acceptul);
 * «Preferințe» deschide alegerea pe categorii. Alegerea ajunge într-un cookie propriu (12 luni); bannerul nu e un perete: pagina
 * rămâne folosibilă, iar focusul nu e capturat. Alegerea se citește din cookie DUPĂ hidratare (nu pe server): așa pagina
 * vitrinei poate fi servită din cache, la fel pentru toți vizitatorii; cât timp nu e citită, bannerul nu se desenează (nu clipește).
 */
export function ConsentBanner() {
  // `undefined` = cookie-ul încă necitit (serverul și prima desenare); `null` = fără alegere valabilă
  const [saved, setSaved] = useState<ConsentChoices | null | undefined>(undefined);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<ConsentChoices>(REFUSE_ALL);
  const titleId = useId();

  useEffect(() => {
    setSaved(parseConsent(readConsentCookie(document.cookie)));
  }, []);

  useEffect(() => {
    const open = () => {
      setDraft(saved ?? REFUSE_ALL);
      setDialogOpen(true);
    };
    window.addEventListener(CONSENT_OPEN_EVENT, open);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, open);
  }, [saved]);

  const choose = (choices: ConsentChoices) => {
    document.cookie = consentCookieString(choices, window.location.protocol === "https:");
    setSaved(choices);
    setDialogOpen(false);
  };

  return (
    <>
      {saved === null ? (
        <section
          aria-labelledby={titleId}
          data-consent-banner
          className="fixed inset-x-0 bottom-0 z-50 border-t border-line-subtle bg-surface-page text-ink shadow-popover"
        >
          <div className="mx-auto flex max-w-(--container-width) flex-col gap-4 px-gutter py-4 md:flex-row md:items-center md:justify-between">
            <div className="max-w-3xl">
              <p id={titleId} className="font-semibold">
                {m.title}
              </p>
              <p className="mt-1 text-sm text-ink-secondary">
                {m.body}{" "}
                <Link
                  href="/politica-cookie-uri"
                  className="text-link underline underline-offset-2"
                >
                  {m.policy}
                </Link>
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row md:shrink-0">
              <StoreButton data-consent="reject" onClick={() => choose(REFUSE_ALL)}>
                {m.reject}
              </StoreButton>
              <StoreButton data-consent="accept" onClick={() => choose(ACCEPT_ALL)}>
                {m.accept}
              </StoreButton>
              <StoreButton
                variant="secondary"
                data-consent="preferences"
                onClick={() => {
                  setDraft(REFUSE_ALL);
                  setDialogOpen(true);
                }}
              >
                {m.preferences}
              </StoreButton>
            </div>
          </div>
        </section>
      ) : null}
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={m.dialogTitle}
        description={m.dialogBody}
        closeLabel={m.close}
      >
        <div className="flex flex-col gap-4">
          <label className="flex items-start gap-3">
            <input type="checkbox" checked disabled className="mt-1 size-4" />
            <span>
              <span className="block font-semibold">{m.necessary.title}</span>
              <span className="block text-sm text-ink-secondary">{m.necessary.description}</span>
            </span>
          </label>
          {CONSENT_CATEGORIES.map((category) => (
            <label key={category} className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={draft[category]}
                onChange={(event) => setDraft({ ...draft, [category]: event.target.checked })}
                className="mt-1 size-4"
              />
              <span>
                <span className="block font-semibold">{m[category].title}</span>
                <span className="block text-sm text-ink-secondary">{m[category].description}</span>
              </span>
            </label>
          ))}
          <div className="flex justify-end">
            <StoreButton onClick={() => choose(draft)}>{m.save}</StoreButton>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/** Butonul din subsol care redeschide preferințele (retragerea consimțământului trebuie să fie la fel de ușoară ca darea lui). */
export function ConsentSettingsButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      data-consent-settings
      onClick={() => window.dispatchEvent(new CustomEvent(CONSENT_OPEN_EVENT))}
      className={className}
    >
      {m.footerLink}
    </button>
  );
}
