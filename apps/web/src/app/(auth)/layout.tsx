import Link from "next/link";
import type { ReactNode } from "react";
import { getSettings } from "@/lib/services";

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
