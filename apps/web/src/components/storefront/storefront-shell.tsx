import type { ReactNode } from "react";
import { getMessages } from "@/messages";
import type { StorefrontChrome } from "@/lib/storefront-chrome";
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
  children,
}: {
  chrome: StorefrontChrome;
  year: number;
  children: ReactNode;
}) {
  return (
    <div
      data-surface="storefront"
      data-container={chrome.container}
      className="flex min-h-dvh flex-col bg-surface-page text-ink"
    >
      <a
        href="#continut"
        className="sr-only z-50 rounded-button bg-surface-page px-5 py-3 font-semibold text-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:ring-2 focus:ring-brand"
      >
        {m.skipToContent}
      </a>
      <StoreHeader
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
      />
    </div>
  );
}
