import { cache } from "react";
import { buildMenuTree, createPrismaMenuStore, settingGroups, type MenuNode } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { getBranding, getFeatureFlags, getSettings } from "./services";
import {
  STOREFRONT_READINESS,
  containerWidthOf,
  headerSlots,
  type ContainerWidth,
  type HeaderSlots,
} from "./storefront-chrome-rules";

/** Nivelurile de categorii din meniu: rădăcini, subcategorii, sub-subcategorii (mai adânc nu se afișează în meniu). */
const MENU_LEVELS = 3;

export interface StorefrontChrome {
  storeName: string;
  tagline: string;
  logoUrl: string | null;
  menu: MenuNode[];
  slots: HeaderSlots;
  container: ContainerWidth;
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
  company: { legalName: "", vatId: "", tradeRegisterNo: "", address: "", phone: "", email: "" },
  legal: { anpcUrl: "", salUrl: "", odrUrl: "" },
});

/**
 * Datele cadrului vitrinei (header și footer), din setări, `Branding`, steaguri și categorii. Fără baza de date sau Redis pagina
 * rămâne afișabilă, cu valorile implicite din registru (la fel ca tema).
 */
export async function loadStorefrontChrome(): Promise<StorefrontChrome> {
  try {
    const settings = getSettings();
    const [general, company, legal, appearance, branding, wishlistFlag, categories] =
      await Promise.all([
        settings.getGroup("general"),
        settings.getGroup("company"),
        settings.getGroup("legal"),
        settings.getGroup("appearance"),
        getBranding().getConfig(),
        getFeatureFlags().isEnabled("wishlist"),
        createPrismaMenuStore(getDb()).listCategories(),
      ]);
    const { street, city, county, postalCode } = company.address;
    return {
      storeName: general.storeName,
      tagline: general.storeTagline,
      logoUrl: branding.logoUrl,
      menu: buildMenuTree(categories, { maxLevels: MENU_LEVELS }),
      slots: headerSlots({ wishlistFlag, readiness: STOREFRONT_READINESS }),
      container: containerWidthOf(appearance.containerWidth),
      company: {
        legalName: company.legalName,
        vatId: company.vatId,
        tradeRegisterNo: company.tradeRegisterNo,
        address: [street, [postalCode, city].filter(Boolean).join(" "), county]
          .filter(Boolean)
          .join(", "),
        phone: company.phone,
        email: company.email,
      },
      legal: { anpcUrl: legal.anpcUrl, salUrl: legal.salUrl, odrUrl: legal.odrUrl },
    };
  } catch (error) {
    getLogger().warn(
      { err: error },
      "nu pot citi datele cadrului vitrinei, folosesc valorile implicite",
    );
    return defaults();
  }
}

/** O singură încărcare pe cerere: layout-ul și pagina cer aceleași date. */
export const getStorefrontChrome = cache(loadStorefrontChrome);
