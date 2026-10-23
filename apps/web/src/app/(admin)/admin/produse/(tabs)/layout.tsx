import type { ReactNode } from "react";
import { can } from "@ecom/core";
import { AdminTabBar } from "@/components/admin/admin-tab-bar";
import { PRODUCT_TABS, visibleTabs } from "@/lib/admin-nav";
import { getAdminAccess } from "@/lib/admin-page";
import { getFeatureFlags } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin;

/**
 * Cadrul ecranelor grupului «Produse»: bara de taburi deasupra paginii. Editorul de produs, produsul nou, importul
 * și editorul fișei explodate sunt în afara grupului `(tabs)`, deci pagini întregi, fără bară. Taburile apar după
 * permisiunea și flag-ul fiecărui ecran; fiecare pagină își păstrează propriul `requireAdmin` (layout-ul nu e o
 * măsură de securitate, doar de ordine, și nu se re-rulează la navigarea între pagini).
 */
export default async function ProductTabsLayout({ children }: { children: ReactNode }) {
  const decision = await getAdminAccess();
  if (decision.kind !== "allow") return children;
  const { subject } = decision;
  const flags = await getFeatureFlags().list();
  const enabled = new Set(flags.filter((f) => f.enabled).map((f) => f.key));
  const tabs = visibleTabs(PRODUCT_TABS, {
    can: (permission) => can(subject, permission),
    isEnabled: (feature) => enabled.has(feature),
  });
  return (
    <>
      {tabs.length > 0 ? (
        <AdminTabBar
          label={m.productTabsLabel}
          items={tabs.map((tab) => ({
            id: tab.id,
            href: tab.href,
            ...(tab.exact && { exact: tab.exact }),
            ...(tab.keepParams && { keepParams: tab.keepParams }),
            label: m.nav[tab.id],
          }))}
        />
      ) : null}
      {children}
    </>
  );
}
