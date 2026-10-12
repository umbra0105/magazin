import Link from "next/link";
import type { ReactNode } from "react";
import { getSettings } from "@/lib/services";

/**
 * Depinde de sesiune/setări la fiecare cerere: nu se prerandează la build (altfel build-ul ar cere DB și
 * ar îngheța conținutul în imaginea de build). Regula e pe segment, nu pe layout-ul rădăcină, ca
 * vitrina (Faza 7) să poată folosi cache și regenerare.
 */
export const dynamic = "force-dynamic";

/** Cadru comun al paginilor de autentificare: numele magazinului (din setări) și conținutul centrat. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const storeName = await getSettings().get("general.storeName");
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-8">
      <Link
        href="/"
        className="rounded-md text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {storeName}
      </Link>
      <main className="w-full max-w-md">{children}</main>
    </div>
  );
}
