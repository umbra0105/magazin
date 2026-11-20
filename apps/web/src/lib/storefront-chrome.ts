import { unstable_cache } from "next/cache";
import { cache } from "react";
import {
  buildMenuTree,
  cardLayoutOf,
  containerWidthOf,
  CATALOG_TAG,
  STOREFRONT_CHROME_TAG,
  createPrismaMenuStore,
  footerVariantOf,
  formatCompanyAddress,
  headerVariantOf,
  settingGroups,
  type AnnouncementTone,
  type CardLayout,
  type ContainerWidth,
  type FooterVariant,
  type HeaderVariant,
  type MenuNode,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { getStorage } from "./media";
import { getBranding, getFeatureFlags, getSettings } from "./services";
import { STOREFRONT_READINESS, headerSlots, type HeaderSlots } from "./storefront-chrome-rules";

/** Nivelurile de categorii din meniu: rădăcini, subcategorii, sub-subcategorii (mai adânc nu se afișează în meniu). */
const MENU_LEVELS = 3;

export interface StorefrontChrome {
  storeName: string;
  tagline: string;
  logoUrl: string | null;
  menu: MenuNode[];
  slots: HeaderSlots;
  container: ContainerWidth;
  headerVariant: HeaderVariant;
  footerVariant: FooterVariant;
  /** Layout-ul cardului de produs (îl folosesc listele din Faza 7; aici ajunge pe carcasă ca `data-card-layout`). */
  cardLayout: CardLayout;
  /** Bara de anunț: `null` când e oprită sau fără text. */
  announcement: { text: string; href: string; tone: AnnouncementTone } | null;
  company: {
    legalName: string;
    vatId: string;
    tradeRegisterNo: string;
    address: string;
    phone: string;
    email: string;
  };
  legal: { anpcUrl: string; salUrl: string; odrUrl: string };
}

const defaults = (): StorefrontChrome => ({
  storeName: settingGroups.general.storeName.parse(undefined),
  tagline: "",
  logoUrl: null,
  menu: [],
  slots: headerSlots({ wishlistFlag: false, readiness: STOREFRONT_READINESS }),
  container: "xl",
  headerVariant: "default",
  footerVariant: "default",
  cardLayout: "vertical",
  announcement: null,
  company: { legalName: "", vatId: "", tradeRegisterNo: "", address: "", phone: "", email: "" },
  legal: { anpcUrl: "", salUrl: "", odrUrl: "" },
});

/**
 * Datele cadrului vitrinei (header și footer), din setări, `Branding`, steaguri și categorii. Fără baza de date sau Redis pagina
 * rămâne afișabilă, cu valorile implicite din registru (la fel ca tema).
 */
export async function loadStorefrontChrome(): Promise<StorefrontChrome> {
  try {
    return await readStorefrontChromeCached();
  } catch (error) {
    getLogger().warn(
      { err: error },
      "nu pot citi datele cadrului vitrinei, folosesc valorile implicite",
    );
    return defaults();
  }
}

/**
 * Citirea propriu-zisă, FĂRĂ valori implicite la eroare: o eroare aruncată nu intră în cache (`unstable_cache` nu memorează
 * excepțiile), deci o pană scurtă a bazei de date nu se păstrează 5 minute. Cache-ul se invalidează cu `storefront-chrome`
 * (setări, branding, flag-uri: `AdminWrites`) și cu `catalog` (categoriile din meniu), din aplicație sau din worker.
 */
async function readStorefrontChrome(): Promise<StorefrontChrome> {
  {
    const settings = getSettings();
    const [general, company, legal, appearance, branding, wishlistFlag, categories] =
      await Promise.all([
        settings.getGroup("general"),
        settings.getGroup("company"),
        settings.getGroup("legal"),
        settings.getGroup("appearance"),
        getBranding().getConfig(),
        getFeatureFlags().isEnabled("wishlist"),
        createPrismaMenuStore(getDb(), { storage: getStorage() }).listCategories(),
      ]);
    return {
      storeName: general.storeName,
      tagline: general.storeTagline,
      logoUrl: branding.logoUrl,
      menu: buildMenuTree(categories, { maxLevels: MENU_LEVELS }),
      slots: headerSlots({ wishlistFlag, readiness: STOREFRONT_READINESS }),
      container: containerWidthOf(appearance.containerWidth),
      headerVariant: headerVariantOf(appearance.headerVariant),
      footerVariant: footerVariantOf(appearance.footerVariant),
      cardLayout: cardLayoutOf(appearance.cardLayout),
      announcement:
        appearance.announcementEnabled && appearance.announcementText
          ? {
              text: appearance.announcementText,
              href: appearance.announcementHref,
              tone: appearance.announcementTone,
            }
          : null,
      company: {
        legalName: company.legalName,
        vatId: company.vatId,
        tradeRegisterNo: company.tradeRegisterNo,
        address: formatCompanyAddress(company.address),
        phone: company.phone,
        email: company.email,
      },
      legal: { anpcUrl: legal.anpcUrl, salUrl: legal.salUrl, odrUrl: legal.odrUrl },
    };
  }
}

const readStorefrontChromeCached = unstable_cache(readStorefrontChrome, ["storefront-chrome"], {
  tags: [STOREFRONT_CHROME_TAG, CATALOG_TAG],
  revalidate: 300,
});

/** O singură încărcare pe cerere: layout-ul și pagina cer aceleași date. */
export const getStorefrontChrome = cache(loadStorefrontChrome);
