import type { Metadata } from "next";
import type { ReactNode } from "react";
import { loadEnv } from "@ecom/config";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { getStorefrontChrome } from "@/lib/storefront-chrome";

/**
 * Pagina ofertei de plată (Faza 11): același cadru «curat» ca checkout-ul (fără meniu și subsol), dar FĂRĂ «Înapoi la coș»:
 * clientul vine dintr-un email și nu are coș. Ieșirea spre pagina de start rămâne logo-ul. Nu se indexează.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { storeName } = await getStorefrontChrome();
  return {
    metadataBase: new URL(loadEnv().APP_URL),
    title: { template: `%s | ${storeName}`, default: storeName },
    robots: { index: false, follow: false },
  };
}

export default async function OfferLayout({ children }: { children: ReactNode }) {
  const chrome = await getStorefrontChrome();
  return (
    <StorefrontShell chrome={chrome} year={new Date().getFullYear()} minimal backToCart={false}>
      {children}
    </StorefrontShell>
  );
}
