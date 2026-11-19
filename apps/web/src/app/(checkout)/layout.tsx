import type { Metadata } from "next";
import type { ReactNode } from "react";
import { loadEnv } from "@ecom/config";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { getStorefrontChrome } from "@/lib/storefront-chrome";

/** Checkout-ul «curat»: aceeași suprafață și aceiași tokeni ca vitrina, fără meniu și subsol (docs/03 §2). Nu se indexează. */
export async function generateMetadata(): Promise<Metadata> {
  const { storeName } = await getStorefrontChrome();
  return {
    metadataBase: new URL(loadEnv().APP_URL),
    title: { template: `%s | ${storeName}`, default: storeName },
    robots: { index: false, follow: false },
  };
}

export default async function CheckoutLayout({ children }: { children: ReactNode }) {
  const chrome = await getStorefrontChrome();
  return (
    <StorefrontShell chrome={chrome} year={new Date().getFullYear()} minimal>
      {children}
    </StorefrontShell>
  );
}
