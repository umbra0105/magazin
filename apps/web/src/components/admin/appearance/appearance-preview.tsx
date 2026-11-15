"use client";

import {
  AnnouncementBar,
  HeroBanner,
  ProductCard,
  StoreButton,
  cn,
  type StorePillTone,
} from "@ecom/ui";
import type { MenuNode } from "@ecom/core";
import { StoreFooter } from "@/components/storefront/store-footer";
import { StoreHeader } from "@/components/storefront/store-header";
import { getMessages } from "@/messages";
import type { SettingsForm } from "./appearance-form";

const m = getMessages().admin.appearance.preview;
const gallery = getMessages().storefront.gallery;

/** Meniul de demonstrație al previzualizării (din mesaje, fără baza de date). */
const DEMO_MENU: MenuNode[] = gallery.menu.map((top, index) => ({
  id: `p-${index}`,
  name: top.name,
  href: "#",
  image: null,
  children: top.children.map((child, childIndex) => ({
    id: `p-${index}-${childIndex}`,
    name: child,
    href: "#",
    image: null,
    children: [],
  })),
}));

export interface AppearancePreviewProps {
  /** CSS-ul previzualizării (din server: doar valori validate), aplicat pe elementul de previzualizare. */
  css: string;
  settings: SettingsForm;
  storeName: string;
  logoUrl: string | null;
  /** Se actualizează chiar acum (cererea către server e în curs). */
  updating: boolean;
}

/**
 * Previzualizarea live a vitrinei din editorul de temă: aceleași componente ca în vitrină (header, hero, carduri, footer, bara de
 * anunț), cu tema formularului. Se desenează în `[data-theme-preview]` (aceeași mecanică ca galeria de design): tokenii de culoare,
 * font și formă se rezolvă pe acest element, deci adminul din jur nu se schimbă. Linkurile sunt inerte (`#`), căutarea și coșul
 * sunt cele din vitrină (dezactivate până la fazele lor). Nu e interactivă: `inert` oprește focusul, ca tabulatorul să rămână în formular.
 */
export function AppearancePreview({
  css,
  settings,
  storeName,
  logoUrl,
  updating,
}: AppearancePreviewProps) {
  const statusTone: StorePillTone = "success";
  return (
    <div
      data-theme-preview
      data-surface="storefront"
      data-container="lg"
      data-header={settings.headerVariant}
      data-appearance-preview
      aria-busy={updating}
      inert
      className={cn(
        "overflow-hidden rounded-lg border border-line-subtle bg-surface-page text-ink",
        updating && "opacity-80",
      )}
    >
      <style>{css}</style>
      {settings.announcementEnabled && settings.announcementText ? (
        <AnnouncementBar
          text={settings.announcementText}
          href={settings.announcementHref || undefined}
          tone={settings.announcementTone}
        />
      ) : null}
      <StoreHeader
        variant={settings.headerVariant}
        storeName={storeName}
        logoUrl={logoUrl}
        menu={DEMO_MENU}
        phone=""
        slots={{ search: "disabled", cart: "disabled", wishlist: "hidden" }}
        className="relative"
      />
      <main>
        <HeroBanner
          titleAs="h2"
          media={
            <div className="flex size-full items-end p-6 text-sm text-on-image">
              {m.imageCaption}
            </div>
          }
          title={m.heroTitle}
          accent={m.heroAccent}
          lede={m.heroLede}
          actions={<StoreButton variant="onImage">{m.heroAction}</StoreButton>}
          className="min-h-80"
        />
        <ul
          className={cn(
            "grid gap-4 p-6",
            settings.cardLayout === "horizontal" ? "grid-cols-1" : "grid-cols-2",
          )}
        >
          {m.cardNames.map((name, index) => (
            <li key={name}>
              <ProductCard
                href="#"
                name={name}
                price={m.cardPrices[index] ?? ""}
                status={{ label: m.cardStatus, tone: statusTone }}
                layout={settings.cardLayout}
                media={<div aria-hidden="true" className="size-full bg-card" />}
                className="h-full"
              />
            </li>
          ))}
        </ul>
      </main>
      <StoreFooter
        variant={settings.footerVariant}
        storeName={storeName}
        tagline=""
        menu={DEMO_MENU}
        company={{
          legalName: gallery.footerCompany.legalName,
          vatId: gallery.footerCompany.vatId,
          tradeRegisterNo: gallery.footerCompany.tradeRegister,
          address: gallery.footerCompany.address,
          phone: "",
          email: gallery.footerCompany.email,
        }}
        legal={{ anpcUrl: "", salUrl: "", odrUrl: "" }}
        year={new Date().getFullYear()}
      />
    </div>
  );
}
