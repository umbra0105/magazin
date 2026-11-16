import type { ReactNode } from "react";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { getStorefrontChrome } from "@/lib/storefront-chrome";

// Fără `force-dynamic` și fără cookie-uri/antete citite aici: cadrul vitrinei vine din cache cu etichete (`storefront-chrome`,
// `catalog`), deci paginile pot fi servite din cache și regenerate (ISR). Consimțământul se citește în browser (ConsentBanner).
export default async function StorefrontLayout({ children }: { children: ReactNode }) {
  const chrome = await getStorefrontChrome();
  return (
    <StorefrontShell chrome={chrome} year={new Date().getFullYear()}>
      {children}
    </StorefrontShell>
  );
}
