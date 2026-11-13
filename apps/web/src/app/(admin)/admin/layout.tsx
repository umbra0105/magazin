import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { adminBrandStyle, can, resolveAdminBrand } from "@ecom/core";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  buttonVariants,
} from "@ecom/ui";
import { AdminShell } from "@/components/admin/admin-shell";
import { AdminSurface } from "@/components/admin/admin-surface";
import type { SidebarNavItem } from "@/components/admin/sidebar-nav";
import { ADMIN_NAV, visibleNav } from "@/lib/admin-nav";
import { getAdminAccess } from "@/lib/admin-page";
import { getBranding, getFeatureFlags, getSettings } from "@/lib/services";
import { THEME_INIT_SCRIPT } from "@/lib/theme-choice";
import { getMessages } from "@/messages";

const m = getMessages().admin;

/**
 * Depinde de sesiune/setări la fiecare cerere: nu se prerandează la build (altfel build-ul ar cere DB și
 * ar îngheța conținutul în imaginea de build). Regula e pe segment, nu pe layout-ul rădăcină, ca
 * vitrina (Faza 7) să poată folosi cache și regenerare.
 */
export const dynamic = "force-dynamic";

// `noindex` și în meta; antetele `X-Robots-Tag` și `Cache-Control: no-store` vin din next.config.ts.
export const metadata: Metadata = {
  title: { default: m.metaTitle, template: `%s · ${m.metaTitle}` },
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Paza zonei de admin. Layout-ul NU se re-rulează la navigarea între pagini, deci fiecare pagină își
 * cere singură `requireAdmin()`; aici se tratează încărcarea inițială: redirect la autentificare
 * (fără sesiune sau sesiune expirată), „acces interzis” (fără `admin.access`), altfel cadrul.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const decision = await getAdminAccess();
  if (decision.kind === "redirect") redirect(decision.location);

  // Brandul magazinului (doar `accent`, cu garda de contrast) și sigla vin din Branding; cache-ul serviciului îl face ieftin.
  const branding = await getBranding().getConfig();
  const brandStyle = adminBrandStyle(resolveAdminBrand(branding.colors)) as CSSProperties;

  if (decision.kind === "denied") {
    return (
      <AdminSurface brandStyle={brandStyle}>
        <div className="flex min-h-dvh items-center justify-center px-4 py-8">
          <main className="w-full max-w-md">
            <Card>
              <CardHeader>
                <CardTitle as="h1">{m.forbidden.title}</CardTitle>
                <CardDescription>{m.forbidden.noAdminAccess}</CardDescription>
              </CardHeader>
              <CardContent>
                <Link href="/cont" className={buttonVariants({ className: "w-full" })}>
                  {m.forbidden.toAccount}
                </Link>
              </CardContent>
            </Card>
          </main>
        </div>
      </AdminSurface>
    );
  }

  const { subject } = decision;
  const [flags, storeName] = await Promise.all([
    getFeatureFlags().list(),
    getSettings().get("general.storeName"),
  ]);
  const enabled = new Set(flags.filter((f) => f.enabled).map((f) => f.key));
  const navItems: SidebarNavItem[] = visibleNav(ADMIN_NAV, {
    can: (permission) => can(subject, permission),
    isEnabled: (feature) => enabled.has(feature),
  }).map((entry) => ({
    id: entry.id,
    href: entry.href,
    basePath: entry.basePath,
    label: m.nav[entry.id],
    // grup care se deschide și se închide: doar elementele permise (vezi `visibleNav`)
    ...(entry.children && {
      children: entry.children.map((child) => ({
        id: child.id,
        href: child.href,
        label: m.nav[child.id],
        ...(child.keepParams && { keepParams: child.keepParams }),
      })),
    }),
  }));

  return (
    <AdminSurface brandStyle={brandStyle}>
      {/* Aplică tema și starea barei laterale salvate înainte de primul paint (fără flash); vezi lib/theme-choice.ts. */}
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      <AdminShell
        storeName={storeName}
        logoUrl={branding.logoUrl}
        email={subject.email}
        navItems={navItems}
      >
        {children}
      </AdminShell>
    </AdminSurface>
  );
}
