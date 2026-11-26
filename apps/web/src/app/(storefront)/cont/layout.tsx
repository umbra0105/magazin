import type { Metadata } from "next";
import type { ReactNode } from "react";
import { hasDigitalProducts } from "@ecom/core";
import { getDb } from "@ecom/db";
import { Container } from "@ecom/ui";
import { AccountNav, type AccountNavItem } from "@/components/storefront/account/account-nav";
import { AccountSignOut } from "@/components/storefront/account/account-sign-out";
import { isFlagOn, requireCustomer } from "@/lib/account";
import { getMessages } from "@/messages";

const m = getMessages().account;

export const metadata: Metadata = {
  title: { template: `%s | ${m.metaTitle}`, default: m.metaTitle },
  robots: { index: false, follow: false },
};

// sesiunea se citește la fiecare cerere
export const dynamic = "force-dynamic";

/**
 * Cadrul contului clientului: meniu lateral în stilul vitrinei. Verificarea sesiunii e pe server (middleware-ul vede doar cookie-ul).
 * «Favorite» apare doar cu flag-ul `wishlist` pornit; «Recenziile mele» vin în Faza 17 și nu au intrare (fără pagină goală).
 */
export default async function AccountLayout({ children }: { children: ReactNode }) {
  const { user } = await requireCustomer("/cont");
  const [wishlist, digital, loyalty] = await Promise.all([
    isFlagOn("wishlist"),
    hasDigitalProducts(getDb(), user.id),
    isFlagOn("loyalty"),
  ]);
  const items: AccountNavItem[] = [
    { href: "/cont", label: m.nav.dashboard },
    { href: "/cont/comenzi", label: m.nav.orders },
    ...(digital
      ? [{ href: "/cont/produsele-mele", label: getMessages().digital.library.navLabel }]
      : []),
    { href: "/cont/retururi", label: m.nav.returns },
    { href: "/cont/adrese", label: m.nav.addresses },
    ...(wishlist ? [{ href: "/cont/favorite", label: m.nav.favorites }] : []),
    ...(loyalty ? [{ href: "/cont/puncte", label: m.nav.points }] : []),
    { href: "/cont/date-personale", label: m.nav.profile },
  ];
  return (
    <Container className="flex flex-col gap-8 py-8 sm:py-12 lg:flex-row" data-account>
      <aside className="flex flex-col gap-4 lg:w-56 lg:shrink-0">
        <AccountNav items={[...items]} label={m.nav.label} />
        <div className="hidden lg:block">
          <AccountSignOut />
        </div>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
      <div className="lg:hidden">
        <AccountSignOut />
      </div>
    </Container>
  );
}
