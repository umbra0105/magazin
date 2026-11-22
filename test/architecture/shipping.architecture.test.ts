import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură pentru livrare și AWB (Faza 12). Reguli, pe codul de producție (testele, e2e și scripturile sunt scutite):
 *  1. Expedierile (`shipment`) se scriu DOAR în `shipping/shipment-service.ts`: nicio altă cale nu face create, update, delete sau
 *     upsert pe ele (starea comenzii trece prin `transitionOrder`, iar AWB-ul prin serviciu, cu `OrderEvent`).
 *  2. Adaptoarele curierilor (`packages/integrations/src/shipping`) apelează rețeaua DOAR prin `callCarrier` (`http.ts`): cu timp
 *     limită, fără redirecturi și cu erori fără date personale. Niciun `fetch(` în afara lui, niciun `console.*` sau logger în adaptoare
 *     (datele clientului nu ajung în loguri).
 *  3. Nu există integrare Cargus separată (decizia utilizatorului, 2026-11-22): nici fișier, nici cod de furnizor.
 *  4. Marca `verifiedInSandboxAt` a curierilor se scrie DOAR în `shipping/carrier-config.ts` (acțiunea explicită a unui Owner); trecerea
 *     în LIVE e posibilă doar prin serviciul de configurare.
 *  5. `CheckoutService` nu cunoaște paletizatul sau curierii: regula stă în `ShippingService` (texte schimbate doar în interfață).
 *  6. Valorile transportului paletizat (preț, prag, capacitate) vin din setări: codul de producție nu importă `DEFAULT_PALLET_SETTINGS`
 *     (oglinda din teste) și nu scrie sume de palet de mână.
 *  7. Reconcilierea rambursului nu atinge stocul și nu schimbă `status`: doar plata și `paymentStatus`, prin `transitionOrder`.
 *
 * Funcțiile `find…` sunt pure și testate pe cazuri sintetice, ca testul să nu poată trece «în gol».
 */
const root = fileURLToPath(new URL("../../", import.meta.url));

interface SourceFile {
  path: string;
  content: string;
}

const isTestPath = (path: string): boolean =>
  /\.(test|spec)\.[cm]?tsx?$/.test(path) ||
  /\.e2e\.[cm]?tsx?$/.test(path) ||
  path.startsWith("e2e/") ||
  path.startsWith("test/") ||
  /(^|\/)test-utils\//.test(path) ||
  /(^|\/)test\//.test(path) ||
  /(^|\/)scripts\//.test(path);

const isCode = (path: string): boolean => /\.[cm]?tsx?$/.test(path) && !isTestPath(path);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function walk(dir: string, out: SourceFile[]): void {
  for (const name of readdirSync(join(root, dir))) {
    if (name === "node_modules" || name.startsWith(".") || name === "generated") continue;
    const rel = `${dir}/${name}`;
    const full = join(root, rel);
    if (statSync(full).isDirectory()) walk(rel, out);
    else if (isCode(rel.split(sep).join("/"))) {
      out.push({
        path: relative(root, full).split(sep).join("/"),
        content: readFileSync(full, "utf8"),
      });
    }
  }
}

const load = (dirs: string[]): SourceFile[] => {
  const out: SourceFile[] = [];
  for (const dir of dirs) walk(dir, out);
  return out;
};

const code = load([
  "apps/web/src",
  "packages/core/src",
  "packages/jobs/src",
  "packages/integrations/src",
]);

/** Scrieri pe `shipment` (create, update, delete, upsert) în afara fișierelor permise. */
export function findShipmentWrites(
  files: readonly SourceFile[],
  allowed: readonly string[],
): string[] {
  return files
    .filter((f) => !allowed.includes(f.path))
    .filter(
      (f) =>
        /\.shipment\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/.test(
          stripComments(f.content),
        ) ||
        /(insert\s+into|update|delete\s+from)\s+"?shipment"?\b/i.test(stripComments(f.content)),
    )
    .map((f) => f.path);
}

export function findDirectFetch(
  files: readonly SourceFile[],
  allowed: readonly string[],
): string[] {
  return files
    .filter((f) => !allowed.includes(f.path))
    .filter((f) => /(^|[^.\w])fetch\s*\(/.test(stripComments(f.content)))
    .map((f) => f.path);
}

export function findLogging(files: readonly SourceFile[]): string[] {
  return files
    .filter((f) =>
      /\bconsole\.\w+\s*\(|getLogger|createLogger|from\s+"pino"/.test(stripComments(f.content)),
    )
    .map((f) => f.path);
}

describe("findShipmentWrites (funcție pură)", () => {
  it("prinde create, update, delete și SQL; ignoră fișierul permis și comentariile", () => {
    const files: SourceFile[] = [
      { path: "a.ts", content: "await tx.shipment.create({ data })" },
      { path: "b.ts", content: "await db.shipment.updateMany({})" },
      { path: "c.ts", content: "await db.$executeRaw`delete from shipment where 1=1`" },
      { path: "d.ts", content: "// tx.shipment.create(x)\nconst ok = tx.shipment.findMany({})" },
      { path: "ok.ts", content: "tx.shipment.create({})" },
    ];
    expect(findShipmentWrites(files, ["ok.ts"])).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

describe("findDirectFetch / findLogging (funcții pure)", () => {
  it("fetch( direct e prins, `callCarrier(` și `.fetch(` pe alt obiect nu", () => {
    const files: SourceFile[] = [
      { path: "x.ts", content: "const r = await fetch(url);" },
      { path: "y.ts", content: "const r = await callCarrier(f, url, {});" },
      { path: "z.ts", content: "const r = await doFetch(url, init);" },
    ];
    expect(findDirectFetch(files, [])).toEqual(["x.ts"]);
  });
  it("console și logger sunt prinse", () => {
    expect(findLogging([{ path: "l.ts", content: "console.log(x)" }])).toEqual(["l.ts"]);
    expect(findLogging([{ path: "l.ts", content: "const log = getLogger();" }])).toEqual(["l.ts"]);
    expect(findLogging([{ path: "l.ts", content: "const ok = 1;" }])).toEqual([]);
  });
});

describe("livrarea respectă regulile (codul real)", () => {
  it("expedierile se scriu doar în `shipment-service.ts`", () => {
    expect(findShipmentWrites(code, ["packages/core/src/shipping/shipment-service.ts"])).toEqual(
      [],
    );
  });

  it("adaptoarele curierilor apelează rețeaua doar prin `callCarrier` și nu loghează", () => {
    const adapters = code.filter((f) => f.path.startsWith("packages/integrations/src/shipping/"));
    expect(adapters.length).toBeGreaterThanOrEqual(5);
    expect(findDirectFetch(adapters, ["packages/integrations/src/shipping/http.ts"])).toEqual([]);
    expect(findLogging(adapters)).toEqual([]);
  });

  it("nu există integrare Cargus separată", () => {
    const files = code.filter(
      (f) => /cargus/i.test(f.path) || /["'`]cargus["'`]/i.test(stripComments(f.content)),
    );
    expect(files.map((f) => f.path)).toEqual([]);
    const registry = readFileSync(join(root, "packages/shared/src/shipping-provider.ts"), "utf8");
    expect(registry).toMatch(/SHIPPING_PROVIDER_CODES = \["wootpro", "sameday", "demo"\]/);
  });

  it("marca «testat cu cont real» se scrie doar în serviciul de configurare a curierilor", () => {
    const writers = code
      .filter(
        (f) =>
          f.path.startsWith("packages/core/src/shipping/") || f.path.startsWith("apps/web/src"),
      )
      .filter((f) => /verifiedInSandboxAt\s*[:=]/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(writers).toEqual(
      ["packages/core/src/shipping/carrier-config.ts"].filter(() => writers.length > 0),
    );
    // seed-ul și CI-ul nu pun marca (nu există cale automată spre LIVE)
    const scripts = readdirSync(join(root, "packages/core/scripts"))
      .filter((n) => n.endsWith(".ts"))
      .map((n) => readFileSync(join(root, "packages/core/scripts", n), "utf8"));
    for (const content of scripts) expect(content).not.toMatch(/'shipping'|"shipping"/);
  });

  it("`CheckoutService` nu cunoaște paletizatul sau curierii", () => {
    const checkout = stripComments(
      readFileSync(join(root, "packages/core/src/orders/checkout-service.ts"), "utf8"),
    );
    expect(checkout).not.toMatch(
      /CarrierRuntime|CarrierConfig|carrier-guard|shipment-service|decidePalletTransport|palletOffer|palletCount|\bshipments?\b/,
    );
  });

  it("valorile paletului vin din setări: `DEFAULT_PALLET_SETTINGS` nu se importă în codul de producție", () => {
    const users = code
      .filter((f) => /DEFAULT_PALLET_SETTINGS/.test(stripComments(f.content)))
      .map((f) => f.path)
      .filter((p) => p !== "packages/core/src/shipping/pallet.ts");
    expect(users).toEqual([]);
  });

  it("reconcilierea rambursului nu atinge stocul și nu schimbă `status`", () => {
    const file = stripComments(
      readFileSync(join(root, "packages/core/src/shipping/cod-reconciliation.ts"), "utf8"),
    );
    expect(file).not.toMatch(/StockService|stock\.|confirmReservation|release\(/);
    // schimbarea de stare: doar `paymentStatus`, prin `transitionOrder` (nicio altă cheie în obiectul de schimbare)
    const change = /transitionOrder\(\s*tx,\s*orderId,\s*\{([^}]*)\}/.exec(file);
    expect(change?.[1]?.trim()).toBe('paymentStatus: "paid"');
  });
});
