import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură pentru plățile online (Faza 10). Reguli, pe codul de producție (testele, e2e și scripturile sunt scutite):
 *  1. NICIUN apel direct la un procesator în afara adaptoarelor `PaymentProvider` (`packages/integrations/src/payments`): niciun
 *     domeniu de procesator și niciun `callProcessor` în altă parte.
 *  2. Webhook-ul NU are cale fără semnătură: ruta apelează DOAR `ingestPaymentWebhook`, iar acesta apelează `verifyWebhook` ÎNAINTE
 *     de orice înregistrare a unui eveniment «primit»; un eveniment respins se înregistrează fără conținut (`normalized`).
 *  3. Furnizorul DEMO e imposibil în producție: se construiește doar printr-un constructor care apelează garda unică, iar paginile
 *     și acțiunile lui apelează aceeași gardă; nimic altceva nu importă `DemoPaymentProvider`.
 *  4. Fără `float` pe sume în plăți (core și adaptoare): niciun `parseFloat`, `toFixed` sau înmulțire/împărțire cu 100.
 *  5. Nicio dependență nouă de plăți: niciun SDK/bibliotecă de procesator în vreun `package.json`.
 *  6. Starea comenzii se schimbă doar prin `transitionOrder` (regula e păzită și de `orders.architecture`; aici, în zona plăților,
 *     nu apare niciun `order.update*` în afară de `order-service`).
 *  7. Cheile și semnăturile nu ajung în loguri: nicio acțiune de plăți nu pune `credentials` într-un apel de audit sau de log.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

interface SourceFile {
  path: string;
  content: string;
}

const SKIP = new Set(["node_modules", ".next", ".next-e2e", ".next-probe", "dist", "generated"]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".next")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

const isTestPath = (path: string): boolean =>
  /\.(test|spec)\.[cm]?tsx?$/.test(path) ||
  /\.e2e\.[cm]?tsx?$/.test(path) ||
  path.startsWith("e2e/") ||
  path.startsWith("test/") ||
  /(^|\/)test-utils\//.test(path) ||
  /(^|\/)scripts\//.test(path);

function load(bases: string[], filter: (path: string) => boolean = () => true): SourceFile[] {
  const out: string[] = [];
  for (const base of bases) walk(join(root, base), out);
  return out
    .map((full) => relative(root, full).split(sep).join("/"))
    .filter((path) => /\.[cm]?tsx?$/.test(path) && !isTestPath(path) && filter(path))
    .map((path) => ({ path, content: readFileSync(join(root, path), "utf8") }));
}

/** Scoate comentariile (păstrând numerele de linie), ca textul din documentație să nu declanșeze regulile. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i] as string;
    const n = source[i + 1];
    if (c === "/" && n === "/" && source[i - 1] !== ":") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const ADAPTERS = "packages/integrations/src/payments/";
const PROCESSOR_HOSTS = /(euplatesc\.ro|netopia-payments\.com|mobilpay\.ro)/i;

export function findProcessorLeaks(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    if (file.path.startsWith(ADAPTERS)) continue;
    const code = stripComments(file.content);
    code.split("\n").forEach((line, index) => {
      if (PROCESSOR_HOSTS.test(line)) out.push(`${file.path}:${index + 1} domeniu de procesator`);
      if (/\bcallProcessor\s*\(/.test(line)) out.push(`${file.path}:${index + 1} callProcessor`);
    });
  }
  return out;
}

export function findFloatMoney(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const code = stripComments(file.content);
    code.split("\n").forEach((line, index) => {
      if (/\bparseFloat\s*\(|\.toFixed\s*\(/.test(line))
        out.push(`${file.path}:${index + 1} float`);
      if (/[*/]\s*100\b(?!_)|\b100\s*[*/]/.test(line) && /(minor|amount|bani|price)/i.test(line)) {
        out.push(`${file.path}:${index + 1} înmulțire/împărțire cu 100 pe o sumă`);
      }
    });
  }
  return out;
}

export function findOrderWrites(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    if (file.path.endsWith("orders/order-service.ts")) continue;
    const code = stripComments(file.content);
    code.split("\n").forEach((line, index) => {
      if (/\border\.(update|updateMany|upsert)\s*\(/.test(line)) {
        out.push(`${file.path}:${index + 1} order.update în afara transitionOrder`);
      }
      if (/UPDATE\s+"?customer_order"?/i.test(line))
        out.push(`${file.path}:${index + 1} UPDATE customer_order`);
    });
  }
  return out;
}

const PAYMENT_SDKS = [
  "euplatesc",
  "netopia",
  "mobilpay",
  "jsonwebtoken",
  "jose",
  "jws",
  "jwa",
  "stripe",
  "@stripe/stripe-js",
  "payu",
  "twispay",
];

export function findForbiddenDeps(manifests: Array<{ path: string; json: unknown }>): string[] {
  const out: string[] = [];
  for (const { path, json } of manifests) {
    const pkg = json as Record<string, Record<string, string> | undefined>;
    for (const group of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const name of Object.keys(pkg[group] ?? {})) {
        if (PAYMENT_SDKS.includes(name.toLowerCase())) out.push(`${path}: ${group}.${name}`);
      }
    }
  }
  return out;
}

describe("funcțiile de verificare detectează încălcările (cazuri sintetice)", () => {
  it("apel direct la procesator, float, scrieri pe comandă, dependențe", () => {
    expect(
      findProcessorLeaks([
        { path: "packages/core/src/x.ts", content: 'fetch("https://secure.euplatesc.ro/x")' },
        { path: "packages/core/src/y.ts", content: "await callProcessor(a, b)" },
        { path: `${ADAPTERS}ok.ts`, content: 'fetch("https://secure.euplatesc.ro/x")' },
        {
          path: "packages/core/src/z.ts",
          content: "// https://secure.euplatesc.ro e doar comentariu",
        },
      ]),
    ).toEqual([
      "packages/core/src/x.ts:1 domeniu de procesator",
      "packages/core/src/y.ts:1 callProcessor",
    ]);
    expect(
      findFloatMoney([
        {
          path: "a.ts",
          content:
            "const x = parseFloat(amount);\nconst y = (minor / 100).toFixed(2);\nconst z = 10;",
        },
      ]).length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      findFloatMoney([
        { path: "a.ts", content: "const limit = 1_000_000; const n = items / 100;" },
      ]),
    ).toEqual([]);
    expect(
      findOrderWrites([
        { path: "packages/core/src/payments/a.ts", content: "await tx.order.update({ data })" },
        {
          path: "packages/core/src/orders/order-service.ts",
          content: "await tx.order.update({ data })",
        },
      ]),
    ).toEqual(["packages/core/src/payments/a.ts:1 order.update în afara transitionOrder"]);
    expect(
      findForbiddenDeps([
        { path: "package.json", json: { dependencies: { zod: "1", euplatesc: "1" } } },
        { path: "p/package.json", json: { devDependencies: { Jose: "1" } } },
      ]),
    ).toEqual(["package.json: dependencies.euplatesc", "p/package.json: devDependencies.Jose"]);
  });
});

describe("plățile respectă regulile (codul real)", () => {
  const code = load(["packages", "apps"], (p) => !p.includes("/generated/"));
  const paymentsCore = code.filter((f) => f.path.startsWith("packages/core/src/payments/"));
  const adapters = code.filter((f) => f.path.startsWith(ADAPTERS));

  it("scanează fișierele de plăți (nu trece în gol)", () => {
    expect(paymentsCore.length).toBeGreaterThan(8);
    expect(adapters.length).toBeGreaterThanOrEqual(6);
  });

  it("niciun apel direct la un procesator în afara adaptoarelor PaymentProvider", () => {
    expect(findProcessorLeaks(code)).toEqual([]);
  });

  it("niciun float pe sume în plăți (core, adaptoare, acțiuni)", () => {
    const scope = code.filter(
      (f) =>
        f.path.startsWith("packages/core/src/payments/") ||
        f.path.startsWith(ADAPTERS) ||
        f.path.startsWith("packages/shared/src/payment-provider") ||
        f.path.includes("/admin/comenzi/plati/") ||
        f.path.includes("/comanda/plata/"),
    );
    expect(findFloatMoney(scope)).toEqual([]);
  });

  it("zona plăților nu scrie starea comenzii în afara transitionOrder", () => {
    expect(findOrderWrites(paymentsCore)).toEqual([]);
  });

  it("webhook: ruta apelează doar ingestPaymentWebhook, iar acesta verifică semnătura ÎNAINTE de a înregistra un eveniment", () => {
    const route = code.find(
      (f) => f.path === "apps/web/src/app/api/webhooks/payments/[provider]/route.ts",
    );
    expect(route).toBeDefined();
    const routeCode = stripComments(route?.content ?? "");
    expect(routeCode).toMatch(/ingestPaymentWebhook\s*\(/);
    // ruta nu atinge direct baza sau procesarea: nicio cale ocolește verificarea
    expect(routeCode).not.toMatch(/paymentWebhookEvent|processPaymentEvent|\.payment\./);
    const processor = stripComments(
      code.find((f) => f.path === "packages/core/src/payments/payment-processor.ts")?.content ?? "",
    );
    const ingest = processor.slice(processor.indexOf("export async function ingestPaymentWebhook"));
    const verifyAt = ingest.indexOf("verifyWebhook(");
    const receivedAt = ingest.indexOf('status: "received"');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(receivedAt).toBeGreaterThan(verifyAt);
    // un eveniment respins nu are conținut
    const rejectedAt = processor.indexOf("async function recordRejected");
    const rejectedBody = processor.slice(rejectedAt, processor.indexOf("function normalizedOf"));
    expect(rejectedBody).not.toContain("normalized");
  });

  it("fiecare adaptor real verifică semnătura în verifyWebhook și refuză cu WebhookRejectedError", () => {
    for (const name of ["euplatesc.ts", "netopia.ts", "demo.ts"]) {
      const file = stripComments(
        adapters.find((f) => f.path === `${ADAPTERS}${name}`)?.content ?? "",
      );
      expect(file, name).toMatch(/verifyWebhook\s*\(/);
      expect(file, name).toContain("WebhookRejectedError");
    }
    const netopia = stripComments(
      adapters.find((f) => f.path === `${ADAPTERS}netopia-ipn.ts`)?.content ?? "",
    );
    expect(netopia).toContain('"RS512"');
    expect(netopia).toContain("timingSafeEqual");
    expect(netopia).not.toMatch(/\bHS(256|384|512)\b.*verify/);
  });

  it("DEMO: constructorul apelează garda, iar paginile și acțiunile DEMO o apelează și ele", () => {
    const demo = stripComments(
      adapters.find((f) => f.path === `${ADAPTERS}demo.ts`)?.content ?? "",
    );
    const ctor = demo.slice(demo.indexOf("constructor("));
    expect(ctor.slice(0, ctor.indexOf("this.signingKey"))).toContain("isDemoPaymentAllowed(");
    for (const path of [
      "apps/web/src/app/(storefront)/plata-demo/[paymentRef]/page.tsx",
      "apps/web/src/app/(storefront)/plata-demo/actions.ts",
      "packages/core/src/payments/payment-config.ts",
    ]) {
      const source = stripComments(code.find((f) => f.path === path)?.content ?? "");
      expect(source, path).toContain("isDemoPaymentAllowed(");
    }
    // garda e unică: o singură definiție
    const defs = code.filter((f) => /export function isDemoPaymentAllowed\b/.test(f.content));
    expect(defs.map((f) => f.path)).toEqual([`${ADAPTERS}demo-guard.ts`]);
    // niciun alt loc nu construiește DemoPaymentProvider
    const builders = code.filter(
      (f) =>
        /new DemoPaymentProvider\s*\(/.test(stripComments(f.content)) &&
        !f.path.startsWith(ADAPTERS),
    );
    expect(builders.map((f) => f.path)).toEqual([]);
  });

  it("garda DEMO nu depinde de NODE_ENV singur: cere E2E_HARNESS=1 sau flagul explicit de dezvoltare", () => {
    const guard = stripComments(
      code.find((f) => f.path === `${ADAPTERS}demo-guard.ts`)?.content ?? "",
    );
    expect(guard).toContain('E2E_HARNESS === "1"');
    expect(guard).toContain('NODE_ENV !== "production"');
    expect(guard).toContain('ECOM_DEMO_PAYMENTS === "1"');
  });

  it("niciun SDK sau bibliotecă de procesator în vreun package.json (nicio dependență nouă)", () => {
    const manifests: Array<{ path: string; json: unknown }> = [];
    const all: string[] = [];
    for (const base of ["packages", "apps"]) walk(join(root, base), all);
    for (const full of [
      join(root, "package.json"),
      ...all.filter((p) => p.endsWith(`${sep}package.json`)),
    ]) {
      manifests.push({
        path: relative(root, full).split(sep).join("/"),
        json: JSON.parse(readFileSync(full, "utf8")),
      });
    }
    expect(manifests.length).toBeGreaterThan(8);
    expect(findForbiddenDeps(manifests)).toEqual([]);
  });

  it("acțiunile de configurare nu pun valori de credențiale în audit", () => {
    const actions = stripComments(
      code.find((f) => f.path === "apps/web/src/app/(admin)/admin/setari/plati/actions.ts")
        ?.content ?? "",
    );
    // blocurile `record({ ... })`: nu referă `data.credentials` sau `credentials[`
    const blocks = [...actions.matchAll(/record\(\{[\s\S]*?\}\);/g)].map((m) => m[0]);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block).not.toMatch(/credentials\b/);
      expect(block).not.toMatch(/secretKey|apiKey|posSignature|publicKey|userApi|userKey/);
    }
  });

  it("trecerea în LIVE e posibilă doar prin acțiunea de admin (nu din seed, CI sau teste)", () => {
    // `confirmLive: true` apare în cod doar în acțiunea de admin (formular) și în interfața ei; seed-ul nu atinge integrările
    const callers = code
      .filter((f) => /confirmLive\s*:\s*true/.test(stripComments(f.content)))
      .map((f) => f.path)
      .sort();
    // plățile (Faza 10) și curierii (Faza 12) au fiecare ecranul lor de admin, cu aceeași gardă pe server
    expect(callers).toEqual([
      "apps/web/src/components/admin/payments/provider-settings.tsx",
      "apps/web/src/components/admin/shipping/carrier-settings.tsx",
    ]);
    const seed = load(["packages/core/scripts", "packages/db"]).concat(
      readdirSync(join(root, "packages/core/scripts"))
        .filter((n) => n.endsWith(".ts"))
        .map((n) => ({
          path: `packages/core/scripts/${n}`,
          content: readFileSync(join(root, "packages/core/scripts", n), "utf8"),
        })),
    );
    for (const file of seed) {
      expect(stripComments(file.content), file.path).not.toMatch(/mode:\s*"live"|confirmLive/);
    }
  });
});
