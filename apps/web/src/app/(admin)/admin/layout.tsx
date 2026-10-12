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
  }).map((entry) => ({ id: entry.id, href: entry.href, label: m.nav[entry.id] }));

  return (
    <>
      {/* Paletele pentru alegerea Luminos/Întunecat/Sistem; vin după /theme.css din <head>. */}
      {/* eslint-disable @next/next/no-css-tags -- foi generate dinamic de rute, nu fișiere din bundle */}
      <link id={THEME_LIGHT_LINK_ID} rel="stylesheet" href="/theme-light.css" media="not all" />
      <link
        id={THEME_DARK_LINK_ID}
        rel="stylesheet"
        href="/theme-dark.css"
        media="(prefers-color-scheme: dark)"
      />
      {/* eslint-enable @next/next/no-css-tags */}
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      <AdminShell storeName={storeName} email={subject.email} navItems={navItems}>
        {children}
      </AdminShell>
    </>
  );
}
