import { describe, expect, it } from "vitest";
import {
  ACCEPT_ALL,
  CART_COOKIE,
  CONSENT_CATEGORIES,
  NECESSARY_COOKIES,
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  CONSENT_VERSION,
  REFUSE_ALL,
  consentCookieString,
  isConsentGiven,
  parseConsent,
  readConsentCookie,
  serializeConsent,
} from "./consent";

describe("consimțământul implicit e «refuzat»", () => {
  it("fără alegere salvată nu e permisă nicio categorie care cere consimțământ", () => {
    for (const choices of [null, undefined]) {
      expect(isConsentGiven(choices, "analytics")).toBe(false);
      expect(isConsentGiven(choices, "marketing")).toBe(false);
    }
    expect(isConsentGiven(REFUSE_ALL, "analytics")).toBe(false);
  });

  it("o alegere explicită se respectă, pe categorie", () => {
    expect(isConsentGiven(ACCEPT_ALL, "analytics")).toBe(true);
    expect(isConsentGiven({ analytics: true, marketing: false }, "marketing")).toBe(false);
    expect(isConsentGiven({ analytics: false, marketing: true }, "marketing")).toBe(true);
  });
});

describe("serializeConsent / parseConsent", () => {
  it("dus-întors pentru toate cele patru combinații", () => {
    for (const analytics of [false, true]) {
      for (const marketing of [false, true]) {
        const raw = serializeConsent({ analytics, marketing });
        expect(raw).toMatch(/^v\d+\.a[01]\.m[01]$/);
        expect(parseConsent(raw)).toEqual({ analytics, marketing });
      }
    }
  });

  it("valori lipsă, stricate sau de altă versiune nu sunt o alegere (revine «refuzat» și bannerul)", () => {
    const stale = `v${CONSENT_VERSION + 1}.a1.m1`;
    for (const bad of [
      null,
      undefined,
      "",
      "v1",
      "v1.a2.m0",
      "v1.a1",
      "x.a1.m1",
      stale,
      "v1.a1.m1;x",
      "V1.a1.m1",
    ]) {
      expect(parseConsent(bad), String(bad)).toBeNull();
    }
  });

  it("valoarea nu conține caractere care cer codificare în cookie", () => {
    expect(serializeConsent(ACCEPT_ALL)).not.toMatch(/[\s",;\\]/);
  });
});

describe("consentCookieString", () => {
  it("cookie propriu, 12 luni, pe tot site-ul, SameSite=Lax; Secure doar pe HTTPS", () => {
    const https = consentCookieString(ACCEPT_ALL, true);
    expect(https).toContain(`${CONSENT_COOKIE}=${serializeConsent(ACCEPT_ALL)}`);
    expect(https).toContain(`Max-Age=${CONSENT_MAX_AGE_SECONDS}`);
    expect(https).toContain("Path=/");
    expect(https).toContain("SameSite=Lax");
    expect(https).toContain("Secure");
    expect(consentCookieString(REFUSE_ALL, false)).not.toContain("Secure");
    expect(CONSENT_MAX_AGE_SECONDS).toBe(31_536_000);
  });
});

describe("readConsentCookie", () => {
  it("găsește cookie-ul printre altele; lipsa dă null", () => {
    expect(readConsentCookie(`a=1; ${CONSENT_COOKIE}=v1.a1.m0; b=2`)).toBe("v1.a1.m0");
    expect(readConsentCookie("a=1; b=2")).toBeNull();
    expect(readConsentCookie(null)).toBeNull();
    expect(readConsentCookie("")).toBeNull();
  });

  it("nu confundă un cookie cu nume asemănător", () => {
    expect(readConsentCookie(`x_${CONSENT_COOKIE}=v1.a1.m1`)).toBeNull();
  });
});

describe("cookie-ul coșului de oaspete (strict necesar)", () => {
  it("e în lista cookie-urilor necesare și nu depinde de nicio categorie care cere consimțământ", () => {
    expect(NECESSARY_COOKIES).toContain(CART_COOKIE);
    expect(CART_COOKIE).toBe("ecom_cart");
    // refuzul tuturor categoriilor nu atinge cookie-ul coșului: nu există categorie «coș» printre cele care cer acord
    expect((CONSENT_CATEGORIES as readonly string[]).some((c) => /cart|cos/i.test(c))).toBe(false);
  });
});
