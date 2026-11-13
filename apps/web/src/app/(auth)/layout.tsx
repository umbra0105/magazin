import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { adminBrandStyle, resolveAdminBrand } from "@ecom/core";
import { AdminSurface } from "@/components/admin/admin-surface";
import { getBranding, getSettings } from "@/lib/services";

/**
 * Depinde de sesiune/setări la fiecare cerere: nu se prerandează la build (altfel build-ul ar cere DB și
 * ar îngheța conținutul în imaginea de build). Regula e pe segment, nu pe layout-ul rădăcină, ca
 * vitrina (Faza 7) să poată folosi cache și regenerare.
 */
export const dynamic = "force-dynamic";

/**
 * Cadrul comun al paginilor de autentificare: suprafața adminului (tokeni, temă deschisă și închisă; brandul magazinului doar
 * ca accent, cu garda de contrast), numele magazinului (din setări) și conținutul centrat.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const [storeName, branding] = await Promise.all([
    getSettings().get("general.storeName"),
    getBranding().getConfig(),
  ]);
  const brandStyle = adminBrandStyle(resolveAdminBrand(branding.colors)) as CSSProperties;
  return (
    <AdminSurface brandStyle={brandStyle}>
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-8">
        <Link
          href="/"
          className="rounded-md text-section focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          {storeName}
        </Link>
        <main className="w-full max-w-md">{children}</main>
      </div>
    </AdminSurface>
  );
}
