import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { can } from "@ecom/core";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  buttonVariants,
} from "@ecom/ui";
import { AdminShell } from "@/components/admin/admin-shell";
import type { SidebarNavItem } from "@/components/admin/sidebar-nav";
import { ADMIN_NAV, visibleNav } from "@/lib/admin-nav";
import { getAdminAccess } from "@/lib/admin-page";
import { getFeatureFlags, getSettings } from "@/lib/services";
import { THEME_INIT_SCRIPT, THEME_DARK_LINK_ID, THEME_LIGHT_LINK_ID } from "@/lib/theme-choice";
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

  if (decision.kind === "denied") {
    return (
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
    <>
      {/* Paletele pentru alegerea Luminos/Întunecat/Sistem; vin după /theme.css din <head>. */}
      {/* eslint-disable @next/next/no-css-tags -- foi generate dinamic de rute, nu fișiere din bundle */}
      {/* suppressHydrationWarning: scriptul de mai jos le schimbă `media` ÎNAINTE de hidratare, intenționat. */}
      <link
        id={THEME_LIGHT_LINK_ID}
        rel="stylesheet"
        href="/theme-light.css"
        media="not all"
        suppressHydrationWarning
      />
      <link
        id={THEME_DARK_LINK_ID}
        rel="stylesheet"
        href="/theme-dark.css"
        media="(prefers-color-scheme: dark)"
        suppressHydrationWarning
      />
      {/* eslint-enable @next/next/no-css-tags */}
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      <AdminShell storeName={storeName} email={subject.email} navItems={navItems}>
        {children}
      </AdminShell>
    </>
  );
}
