import type { ReactNode } from "react";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { readConsent } from "@/lib/consent-server";
import { getStorefrontChrome } from "@/lib/storefront-chrome";

// Header, footer și meniu depind de setări, steaguri și categorii: dinamic (cache-ul vitrinei: Faza 7).
export const dynamic = "force-dynamic";

export default async function StorefrontLayout({ children }: { children: ReactNode }) {
  const [chrome, consent] = await Promise.all([getStorefrontChrome(), readConsent()]);
  return (
    <StorefrontShell chrome={chrome} year={new Date().getFullYear()} consent={consent}>
      {children}
    </StorefrontShell>
  );
}
