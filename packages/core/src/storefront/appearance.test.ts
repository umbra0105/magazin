import { describe, expect, it } from "vitest";
import { getSettingSchema, settingGroups } from "../settings/registry";
import {
  ANNOUNCEMENT_MAX_LENGTH,
  CARD_LAYOUTS,
  CONTAINER_WIDTHS,
  FOOTER_VARIANTS,
  HEADER_VARIANTS,
  cardLayoutOf,
  containerWidthOf,
  footerVariantOf,
  headerVariantOf,
  isSafeAnnouncementHref,
} from "./appearance";

describe("setările de aspect din registru", () => {
  it("valorile implicite: header și footer standard, container xl, card vertical, fără anunț", () => {
    const a = settingGroups.appearance;
    expect(a.headerVariant.parse(undefined)).toBe("default");
    expect(a.footerVariant.parse(undefined)).toBe("default");
    expect(a.containerWidth.parse(undefined)).toBe("xl");
    expect(a.cardLayout.parse(undefined)).toBe("vertical");
    expect(a.announcementEnabled.parse(undefined)).toBe(false);
    expect(a.announcementText.parse(undefined)).toBe("");
    expect(a.announcementHref.parse(undefined)).toBe("");
    expect(a.announcementTone.parse(undefined)).toBe("brand");
  });

  it("la scriere se acceptă doar valorile din listă (cheia trece prin schema din registru)", () => {
    expect(getSettingSchema("appearance.headerVariant")?.safeParse("glass").success).toBe(true);
    expect(getSettingSchema("appearance.headerVariant")?.safeParse("transparent").success).toBe(
      false,
    );
    expect(getSettingSchema("appearance.footerVariant")?.safeParse("compact").success).toBe(true);
    expect(getSettingSchema("appearance.footerVariant")?.safeParse("gigant").success).toBe(false);
    expect(getSettingSchema("appearance.containerWidth")?.safeParse("3xl").success).toBe(false);
    expect(getSettingSchema("appearance.cardLayout")?.safeParse("horizontal").success).toBe(true);
    expect(getSettingSchema("appearance.cardLayout")?.safeParse("diagonal").success).toBe(false);
  });

  it("textul anunțului are plafon, iar destinația respinge schemele periculoase", () => {
    const text = getSettingSchema("appearance.announcementText");
    expect(text?.safeParse("a".repeat(ANNOUNCEMENT_MAX_LENGTH)).success).toBe(true);
    expect(text?.safeParse("a".repeat(ANNOUNCEMENT_MAX_LENGTH + 1)).success).toBe(false);
    const href = getSettingSchema("appearance.announcementHref");
    for (const ok of ["", "/oferte", "/categorie/pompe?x=1", "https://exemplu.ro/oferta"]) {
      expect(href?.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "http://exemplu.ro",
      "//exemplu.ro",
      "/a b",
      '/"onclick="x',
      "/\\evil",
      "https://",
    ]) {
      expect(href?.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("isSafeAnnouncementHref", () => {
  it("cale locală sau https, fără spații, ghilimele sau paranteze unghiulare", () => {
    expect(isSafeAnnouncementHref("/x")).toBe(true);
    expect(isSafeAnnouncementHref("https://a.ro")).toBe(true);
    expect(isSafeAnnouncementHref("/x<script>")).toBe(false);
  });
});

describe("valori necunoscute cad pe implicit", () => {
  it("setări vechi sau stricate nu strică vitrina", () => {
    expect(headerVariantOf("glass")).toBe("glass");
    expect(headerVariantOf("ceva")).toBe("default");
    expect(headerVariantOf(undefined)).toBe("default");
    expect(footerVariantOf("compact")).toBe("compact");
    expect(footerVariantOf(3)).toBe("default");
    expect(containerWidthOf("2xl")).toBe("2xl");
    expect(containerWidthOf("")).toBe("xl");
    expect(cardLayoutOf("horizontal")).toBe("horizontal");
    expect(cardLayoutOf(null)).toBe("vertical");
  });

  it("listele de opțiuni nu sunt goale și au implicitul pe primul loc", () => {
    expect(HEADER_VARIANTS[0]).toBe("default");
    expect(FOOTER_VARIANTS[0]).toBe("default");
    expect(CARD_LAYOUTS[0]).toBe("vertical");
    expect(CONTAINER_WIDTHS).toContain("xl");
  });
});

describe("setările de mentenanță din registru", () => {
  it("oprit implicit, cu mesaj gol (se folosește textul din mesajele aplicației)", () => {
    expect(settingGroups.maintenance.enabled.parse(undefined)).toBe(false);
    expect(settingGroups.maintenance.message.parse(undefined)).toBe("");
  });

  it("mesajul are plafon și se curăță de spații la capete; pornirea cere o valoare booleană", () => {
    const message = getSettingSchema("maintenance.message");
    expect(message?.parse("  Revenim la 18:00  ")).toBe("Revenim la 18:00");
    expect(message?.safeParse("a".repeat(301)).success).toBe(false);
    expect(getSettingSchema("maintenance.enabled")?.safeParse("da").success).toBe(false);
    expect(getSettingSchema("maintenance.enabled")?.safeParse(true).success).toBe(true);
  });
});
