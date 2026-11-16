import type { ReactNode } from "react";
import { AnnouncementBar } from "@ecom/ui";
import { getMessages } from "@/messages";
import type { ConsentChoices } from "@/lib/consent";
import type { StorefrontChrome } from "@/lib/storefront-chrome";
import { ConsentBanner } from "./consent-banner";
import { StoreFooter } from "./store-footer";
import { StoreHeader } from "./store-header";

const m = getMessages().storefront;

/**
 * Carcasa paginilor vitrinei: suprafața `storefront` (tokenii din `storefront-tokens.css`, culorile din `Branding`), legătura
 * «Sari la conținut» (prima oprire la tabulator), header, conținutul (`main`, ținta legăturii) și footer. Nu conține `h1`.
 */
export function StorefrontShell({
  chrome,
  year,
  consent,
  children,
}: {
  chrome: StorefrontChrome;
  year: number;
  /** Alegerea de cookie-uri din cererea curentă; `null` = fără alegere (refuzat, cu banner). */
  consent: ConsentChoices | null;
  children: ReactNode;
}) {
  return (
    <div
      data-surface="storefront"
      data-container={chrome.container}
      data-header={chrome.headerVariant}
      data-card-layout={chrome.cardLayout}
      className="flex min-h-dvh flex-col bg-surface-page text-ink"
    >
      <a
        href="#continut"
        className="sr-only z-50 rounded-button bg-surface-page px-5 py-3 font-semibold text-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:ring-2 focus:ring-brand"
      >
        {m.skipToContent}
      </a>
      {chrome.announcement ? (
        <AnnouncementBar
          label={m.announcementLabel}
          text={chrome.announcement.text}
          href={chrome.announcement.href || undefined}
          tone={chrome.announcement.tone}
        />
      ) : null}
      <StoreHeader
        variant={chrome.headerVariant}
        storeName={chrome.storeName}
        logoUrl={chrome.logoUrl}
        menu={chrome.menu}
        phone={chrome.company.phone}
        slots={chrome.slots}
      />
      <main id="continut" className="flex-1">
        {children}
      </main>
      <StoreFooter
        storeName={chrome.storeName}
        tagline={chrome.tagline}
        menu={chrome.menu}
        company={chrome.company}
        legal={chrome.legal}
        year={year}
        variant={chrome.footerVariant}
      />
      <ConsentBanner initial={consent} />
    </div>
  );
}
