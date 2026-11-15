import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Container, StorefrontState } from "@ecom/ui";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().storefront.states.maintenance;

export const dynamic = "force-dynamic";

/** Pagina de mentenanță nu se indexează (statusul 503 îl pune middleware-ul; vezi `lib/maintenance.ts`). */
export const metadata: Metadata = { title: m.title, robots: { index: false, follow: false } };

/**
 * Pagina afișată vizitatorilor cât modul de mentenanță e pornit: numele sau logo-ul magazinului și mesajul din setări (sau textul
 * implicit). Fără meniu, fără căutare, fără coș. Cu modul oprit, adresa nu există (404). Statusul 503 și `Retry-After` vin de la
 * middleware, care rescrie orice cerere a vitrinei spre această pagină.
 */
export default async function MaintenancePage() {
  const settings = getSettings();
  const current = await Promise.all([
    settings.get("maintenance.enabled"),
    settings.get("maintenance.message"),
  ]).catch(() => null);
  if (!current || !current[0]) notFound();
  const message = current[1];
  const chrome = await getStorefrontChrome();
  return (
    <div
      data-surface="storefront"
      data-container={chrome.container}
      className="min-h-dvh bg-surface-page text-ink"
    >
      <header className="py-6">
        <Container>
          {chrome.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- logo din Branding (https sau cale locală), cu dimensiune fixă
            <img src={chrome.logoUrl} alt={chrome.storeName} className="h-9 w-auto max-w-48" />
          ) : (
            <p className="heading-display text-xl">{chrome.storeName}</p>
          )}
        </Container>
      </header>
      <main>
        <StorefrontState title={m.title} description={message || m.description} role="status" />
      </main>
    </div>
  );
}
