import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură pentru facturare (Faza 13). Reguli, pe codul de producție (testele, e2e și scripturile sunt scutite):
 *  1. Documentele fiscale (`invoice`, `invoice_line`, `invoice_event`) se scriu DOAR în `invoicing/invoice-service.ts` și
 *     `invoicing/invoice-schedule.ts`: nicio altă cale nu face create, update, delete sau upsert pe ele.
 *  2. Furnizorul se apelează pentru EMITERE doar din `InvoiceService` (`issueInvoice`, `issueProforma`, `reverseInvoice`,
 *     `cancelProforma`): nicio altă cale din producție nu emite, nu stornează și nu anulează.
 *  3. Seria și numărul se iau EXCLUSIV din răspunsul furnizorului: aplicația nu numerotează (niciun contor, nicio secvență).
 *  4. Adaptoarele de facturare apelează rețeaua DOAR prin `callInvoiceProvider` (`invoicing/http.ts`): cu timp limită, fără
 *     redirecturi, cu erori fără date personale. Niciun `fetch(`, `console.*` sau logger în adaptoare; adresa SmartBill apare doar în
 *     `smartbill.ts`.
 *  5. Costul de achiziție (`costPrice`, `costNet`, NIR) nu apare nicăieri în facturare, nici în adaptoare.
 *  6. `markInvoiced` (ora facturii pe angajările de stoc) se apelează DOAR din `InvoiceService`, după emitere.
 *  7. Marca `verifiedInSandboxAt` a furnizorului de facturare se scrie DOAR în `invoicing/invoice-config.ts` (acțiunea explicită a unui
 *     Owner). Furnizorul DEMO nu se poate construi fără garda `isDemoPaymentAllowed`.
 *  8. Facturarea nu intră în `CheckoutService` și în motorul de prețuri, iar `packages/core/src/invoicing` nu importă React.
 *  9. Outbox-ul se scrie doar din `addOrderEvent` (`scheduleOrderInvoices`), în aceeași tranzacție cu evenimentul.
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
  "packages/shared/src",
]);

const INVOICE_TABLES = "(?:invoice|invoiceLine|invoiceEvent)";

/** Scrieri pe tabelele facturării (create, update, delete, upsert) în afara fișierelor permise. */
export function findInvoiceWrites(
  files: readonly SourceFile[],
  allowed: readonly string[],
): string[] {
  const clientCall = new RegExp(
    `\\.${INVOICE_TABLES}\\.(create|createMany|createManyAndReturn|update|updateMany|delete|deleteMany|upsert)\\s*\\(`,
  );
  const sql = /(insert\s+into|update|delete\s+from)\s+"?invoice(_line|_event)?"?\b/i;
  return files
    .filter((f) => !allowed.includes(f.path))
    .filter((f) => {
      const text = stripComments(f.content);
      return clientCall.test(text) || sql.test(text);
    })
    .map((f) => f.path);
}

/** Apeluri de emitere sau storno către furnizor în afara fișierelor permise. */
export function findProviderCalls(
  files: readonly SourceFile[],
  allowed: readonly string[],
): string[] {
  return files
    .filter((f) => !allowed.includes(f.path))
    .filter((f) =>
      /\.(issueInvoice|issueProforma|reverseInvoice|cancelProforma)\s*\(/.test(
        stripComments(f.content),
      ),
    )
    .map((f) => f.path);
}

/** Numerotare locală: o secvență, un contor sau o atribuire a seriei/numărului din altceva decât răspunsul furnizorului. */
export function findLocalNumbering(file: SourceFile): string[] {
  const text = stripComments(file.content);
  const found: string[] = [];
  if (/nextval|CREATE\s+SEQUENCE|invoiceCounter|nextInvoiceNumber|nextNumber\s*\(/i.test(text)) {
    found.push("secvență sau contor");
  }
  for (const match of text.matchAll(/\b(number|series)\s*:\s*([A-Za-z_.]+)/g)) {
    const field = match[1] as string;
    const value = match[2] as string;
    // în emiterea unui document, seria și numărul se iau doar din `issued` (răspunsul furnizorului) sau din părintele deja emis
    if (/^(issued|parent|invoice|proforma|doc|ref)\./.test(value)) continue;
    if (/^(true|false|null|undefined|string)$/.test(value)) continue;
    found.push(`${field}: ${value}`);
  }
  return found;
}

/** Date de achiziție în facturare. */
export function findCostLeaks(files: readonly SourceFile[]): string[] {
  return files
    .filter((f) => {
      // singura apariție permisă: parametrul gol al motorului de prețuri (`costNetMinor: null`), care nu poartă niciun cost
      const text = stripComments(f.content).replace(/costNetMinor\s*:\s*null/g, "");
      return /costPrice|costNet|costPriceDate|CostPriceHistory|\bNIR\b/.test(text);
    })
    .map((f) => f.path);
}

const INVOICING_CORE = "packages/core/src/invoicing/";
const ADAPTERS = "packages/integrations/src/invoicing/";

describe("facturarea respectă regulile (codul real)", () => {
  const invoicingFiles = code.filter(
    (f) => f.path.startsWith(INVOICING_CORE) || f.path.startsWith(ADAPTERS),
  );

  it("există cod de facturare de verificat (garda nu trece pe gol)", () => {
    expect(invoicingFiles.length).toBeGreaterThanOrEqual(9);
    expect(code.some((f) => f.path === `${INVOICING_CORE}invoice-service.ts`)).toBe(true);
  });

  it("1 · documentele fiscale se scriu doar în serviciul de facturare și în outbox", () => {
    expect(
      findInvoiceWrites(code, [
        `${INVOICING_CORE}invoice-service.ts`,
        `${INVOICING_CORE}invoice-schedule.ts`,
      ]),
    ).toEqual([]);
  });

  it("2 · emiterea, stornarea și anularea la furnizor se apelează doar din InvoiceService", () => {
    expect(findProviderCalls(code, [`${INVOICING_CORE}invoice-service.ts`])).toEqual([]);
    // plasă de siguranță: serviciul chiar le apelează
    const service = stripComments(
      code.find((f) => f.path === `${INVOICING_CORE}invoice-service.ts`)?.content ?? "",
    );
    for (const call of ["issueInvoice", "issueProforma", "reverseInvoice", "cancelProforma"]) {
      expect(service).toContain(`.${call}(`);
    }
  });

  it("3 · seria și numărul vin doar de la furnizor: nicio numerotare locală", () => {
    // adaptoarele SUNT furnizorul (DEMO își generează numerele simulate); regula e a aplicației, deci a lui `core/invoicing`
    for (const file of invoicingFiles.filter((f) => f.path.startsWith(INVOICING_CORE))) {
      expect(findLocalNumbering(file), file.path).toEqual([]);
    }
    // plasă de siguranță: serviciul scrie seria și numărul din răspunsul furnizorului
    const service = stripComments(
      code.find((f) => f.path === `${INVOICING_CORE}invoice-service.ts`)?.content ?? "",
    );
    expect(service).toMatch(/series:\s*issued\.series/);
    expect(service).toMatch(/number:\s*issued\.number/);
  });

  it("4 · adaptoarele apelează rețeaua doar prin callInvoiceProvider, fără console sau logger", () => {
    const adapters = code.filter((f) => f.path.startsWith(ADAPTERS));
    expect(adapters.length).toBeGreaterThanOrEqual(5);
    const direct = adapters
      .filter((f) => f.path !== `${ADAPTERS}http.ts`)
      .filter((f) => /\bfetch\s*\(/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(direct).toEqual([]);
    const logging = adapters
      .filter(
        (f) =>
          /\bconsole\./.test(stripComments(f.content)) ||
          /\blogger\b/.test(stripComments(f.content)),
      )
      .map((f) => f.path);
    expect(logging).toEqual([]);
    const base = adapters
      .filter(
        (f) =>
          /smartbill\.ro/i.test(stripComments(f.content)) && f.path !== `${ADAPTERS}smartbill.ts`,
      )
      .map((f) => f.path);
    expect(base).toEqual([]);
  });

  it("5 · costul de achiziție nu apare în facturare", () => {
    expect(findCostLeaks(invoicingFiles)).toEqual([]);
  });

  it("6 · markInvoiced se apelează doar din InvoiceService", () => {
    const callers = code
      .filter((f) => /\.markInvoiced\s*\(/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(callers).toEqual([`${INVOICING_CORE}invoice-service.ts`]);
  });

  it("7 · marca «testat cu cont real» se scrie doar în configurarea facturării; DEMO are garda", () => {
    const writers = code
      .filter((f) => f.path.startsWith(INVOICING_CORE) || f.path.startsWith(ADAPTERS))
      .filter((f) => /verifiedInSandboxAt\s*:\s*(?!null)/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(writers).toEqual([`${INVOICING_CORE}invoice-config.ts`]);
    const demo = stripComments(code.find((f) => f.path === `${ADAPTERS}demo.ts`)?.content ?? "");
    expect(demo).toContain("isDemoPaymentAllowed(options.env)");
    const config = stripComments(
      code.find((f) => f.path === `${INVOICING_CORE}invoice-config.ts`)?.content ?? "",
    );
    // un furnizor în LIVE neverificat nu se construiește și LIVE se refuză fără marcă
    expect(config).toContain("INVOICING_LIVE_NOT_VERIFIED");
    expect(config).toMatch(/row\.mode === "live" && !row\.verifiedInSandboxAt/);
  });

  it("8 · facturarea nu intră în CheckoutService sau în motorul de prețuri, iar core/invoicing nu importă React", () => {
    const leaks = code
      .filter(
        (f) =>
          f.path === "packages/core/src/orders/checkout-service.ts" ||
          f.path.startsWith("packages/core/src/pricing/"),
      )
      .filter((f) => /invoic/i.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(leaks).toEqual([]);
    const react = code
      .filter((f) => f.path.startsWith(INVOICING_CORE))
      .filter((f) => /from\s+["']react|from\s+["']next\//.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(react).toEqual([]);
  });

  it("9 · outbox-ul se scrie doar din addOrderEvent, în aceeași tranzacție cu evenimentul", () => {
    const callers = code
      .filter((f) => /\bscheduleOrderInvoices\s*\(/.test(stripComments(f.content)))
      .map((f) => f.path)
      .filter((p) => p !== `${INVOICING_CORE}invoice-schedule.ts`);
    expect(callers).toEqual(["packages/core/src/orders/order-service.ts"]);
  });
});

describe("funcțiile de verificare găsesc încălcările (cazuri sintetice)", () => {
  const file = (path: string, content: string): SourceFile => ({ path, content });

  it("scrieri pe documente în afara fișierelor permise", () => {
    const bad = file(
      "packages/core/src/orders/x.ts",
      "await tx.invoice.update({ where: { id }, data: {} });",
    );
    const sql = file(
      "packages/core/src/orders/y.ts",
      "await db.$executeRaw`UPDATE invoice SET status = 1`;",
    );
    const ok = file(
      "packages/core/src/invoicing/invoice-service.ts",
      "await tx.invoice.update({});",
    );
    const comment = file("packages/core/src/orders/z.ts", "// tx.invoice.delete({}) nu se face");
    expect(
      findInvoiceWrites(
        [bad, sql, ok, comment],
        ["packages/core/src/invoicing/invoice-service.ts"],
      ),
    ).toEqual(["packages/core/src/orders/x.ts", "packages/core/src/orders/y.ts"]);
    expect(findInvoiceWrites([file("a.ts", "await tx.invoiceLine.createMany({});")], [])).toEqual([
      "a.ts",
    ]);
    expect(findInvoiceWrites([file("a.ts", "await tx.invoiceEvent.create({});")], [])).toEqual([
      "a.ts",
    ]);
  });

  it("emitere în afara serviciului", () => {
    expect(findProviderCalls([file("a.ts", "await provider.issueInvoice(req);")], [])).toEqual([
      "a.ts",
    ]);
    expect(findProviderCalls([file("a.ts", "provider.reverseInvoice(ref, d)")], [])).toEqual([
      "a.ts",
    ]);
    expect(findProviderCalls([file("a.ts", "// provider.issueInvoice(req)")], [])).toEqual([]);
    expect(findProviderCalls([file("ok.ts", "provider.issueInvoice(r)")], ["ok.ts"])).toEqual([]);
  });

  it("numerotare locală", () => {
    expect(
      findLocalNumbering(file("a.ts", "const n = nextInvoiceNumber();")).length,
    ).toBeGreaterThan(0);
    expect(
      findLocalNumbering(file("a.ts", "data: { number: counter.next }")).length,
    ).toBeGreaterThan(0);
    expect(
      findLocalNumbering(file("a.ts", "data: { number: issued.number, series: issued.series }")),
    ).toEqual([]);
    expect(findLocalNumbering(file("a.ts", "const x = { number: parent.number }"))).toEqual([]);
  });

  it("scurgeri de cost", () => {
    expect(findCostLeaks([file("a.ts", "const c = variant.costPrice;")])).toEqual(["a.ts"]);
    expect(findCostLeaks([file("a.ts", "// costPrice nu se folosește")])).toEqual([]);
    // parametrul gol al motorului de prețuri nu e o scurgere; orice altă valoare a lui da
    expect(findCostLeaks([file("a.ts", "const i = { costNetMinor: null };")])).toEqual([]);
    expect(findCostLeaks([file("a.ts", "const i = { costNetMinor: variant.cost };")])).toEqual([
      "a.ts",
    ]);
  });
});
