import type { Metadata } from "next";
import type { ReactNode } from "react";
import { loadEnv } from "@ecom/config";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { getStorefrontChrome } from "@/lib/storefront-chrome";

// Fără `force-dynamic` și fără cookie-uri/antete citite aici: cadrul vitrinei vine din cache cu etichete (`storefront-chrome`,
// `catalog`), deci paginile pot fi servite din cache și regenerate (ISR). Consimțământul se citește în browser (ConsentBanner).
/** Adresa de bază a magazinului (canonice, Open Graph) și șablonul titlurilor: «Pagina | Numele magazinului». */
export async function generateMetadata(): Promise<Metadata> {
  const { storeName } = await getStorefrontChrome();
  return {
    metadataBase: new URL(loadEnv().APP_URL),
    title: { template: `%s | ${storeName}`, default: storeName },
    openGraph: { siteName: storeName, locale: "ro_RO" },
  };
}

export default async function StorefrontLayout({ children }: { children: ReactNode }) {
  const chrome = await getStorefrontChrome();
  return (
    <StorefrontShell chrome={chrome} year={new Date().getFullYear()}>
      {children}
    </StorefrontShell>
  );
}
