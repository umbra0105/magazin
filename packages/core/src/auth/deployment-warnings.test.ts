import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { proxyHopsWarning } from "./deployment-warnings";

/**
 * Blocul C, C-02: o instalare de producție cu `auth.trustedProxyHops = 0` nu vede adresa IP a clientului, deci limitele pe adresă
 * se reduc la plafoane globale. Aplicația nu trebuie să tacă: la pornire scrie un avertisment clar, în română.
 */

describe("proxyHopsWarning", () => {
  it("în producție cu 0 proxy-uri de încredere întoarce un avertisment care numește setarea și consecința", () => {
    const warning = proxyHopsWarning({ isProduction: true, trustedProxyHops: 0 });
    expect(warning).toContain("auth.trustedProxyHops");
    expect(warning).toMatch(/adresa IP/);
    expect(warning).toMatch(/accesibilă direct|fără proxy/);
  });

  it("în producție cu cel puțin un proxy, sau în dezvoltare/test, nu avertizează", () => {
    expect(proxyHopsWarning({ isProduction: true, trustedProxyHops: 1 })).toBeNull();
    expect(proxyHopsWarning({ isProduction: true, trustedProxyHops: 2 })).toBeNull();
    expect(proxyHopsWarning({ isProduction: false, trustedProxyHops: 0 })).toBeNull();
  });
});

describe("avertismentul e legat la pornirea aplicației", () => {
  it("instrumentation.ts cheamă verificările de pornire (runtime Node)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../../apps/web/src/instrumentation.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("startup-checks");
  });
});
