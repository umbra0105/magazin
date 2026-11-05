import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură pentru flag-ul `multiWarehouse` (Faza 5, punctul 13). Cu flag-ul oprit magazinul rămâne cu un singur
 * depozit, iar rezervările, importul SmartBill, disponibilitatea și ecranul Stoc nu trebuie să depindă de codul de multi-depozit:
 *  1. codul de multi-depozit (`warehouse-service`, `warehouse-store`) și flag-ul `multiWarehouse` apar DOAR în fișierele
 *     din lista de mai jos: orice altă sursă (rezervări, import, disponibilitate …) care le atinge pică;
 *  2. tabela de depozite se scrie DOAR prin `warehouse-store` (și seed-ul de bază): nicio sursă nu ocolește serviciul, care
 *     verifică flag-ul;
 *  3. fiecare metodă publică a `WarehouseService` începe cu verificarea flag-ului și a drepturilor.
 * Lista se lărgește conștient, odată cu fiecare sub-etapă (transfer, ecran, selector), nu pe nesimțite.
 *
 * Citește sursa ca text; funcțiile de verificare sunt pure și testate pe fișiere sintetice.
 */

const root = fileURLToPath(new URL("../../../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

/** Fișierele care au voie să importe codul de multi-depozit sau să numească flag-ul */
const AWARE = new Set([
  "packages/core/src/features/registry.ts",
  "packages/core/src/inventory/warehouse-service.ts",
  "packages/core/src/inventory/warehouse-store.ts",
  // transferul între depozite: refuză cu FEATURE_DISABLED (importă eroarea serviciului de depozite)
  "packages/core/src/inventory/stock-transfer.ts",
  "packages/core/src/inventory/index.ts",
  // legătura serviciului cu flag-ul real (singurul loc în care `isEnabled("multiWarehouse")` e scris pentru depozite)
  "apps/web/src/lib/inventory.ts",
  // ecranul «Depozite»: elementul din meniu și pagina declară flag-ul (oprit: nici element, nici rută)
  "apps/web/src/lib/admin-nav.ts",
  "apps/web/src/app/(admin)/admin/produse/depozite/page.tsx",
]);

/** Singurele fișiere care scriu în tabela de depozite (seed-ul creează «Depozit principal») */
const WAREHOUSE_WRITERS = new Set([
  "packages/core/src/inventory/warehouse-store.ts",
  "packages/core/src/seed/base-seed.ts",
]);

const isTest = (path: string): boolean =>
  /\.(test|spec)\.(ts|tsx)$/.test(path) ||
  path.includes("/test/") ||
  path.includes("/test-utils/") ||
  path.includes("/scripts/") ||
  path.startsWith("e2e/");

const WAREHOUSE_CODE_IMPORT = /from\s+["'][^"']*\/warehouse-(?:service|store)["']/;
const FLAG_MENTION = /["']multiWarehouse["']|\bmultiWarehouse\b/;
const WAREHOUSE_WRITE =
  /\.\s*warehouse\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;

export function findMultiWarehouseViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (isTest(file.path) || file.path.startsWith("packages/db/")) continue;
    if (!AWARE.has(file.path)) {
      if (WAREHOUSE_CODE_IMPORT.test(file.content)) {
        problems.push(
          `${file.path}: importă codul de multi-depozit (rezervările, importul și disponibilitatea nu depind de el)`,
        );
      }
      if (FLAG_MENTION.test(file.content)) {
        problems.push(`${file.path}: numește flag-ul multiWarehouse fără să fie în lista permisă`);
      }
    }
    if (WAREHOUSE_WRITE.test(file.content) && !WAREHOUSE_WRITERS.has(file.path)) {
      problems.push(
        `${file.path}: scrie direct în tabela de depozite (doar warehouse-store, care e apelat de serviciul ce verifică flag-ul)`,
      );
    }
  }
  return problems;
}

const SKIP_DIRS = new Set(["node_modules", "generated", ".next", ".turbo", "dist", "coverage"]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".next")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
}

function load(base: string): SourceFile[] {
  const paths: string[] = [];
  walk(join(root, base), paths);
  return paths.map((full) => ({
    path: relative(root, full).split(sep).join("/"),
    content: readFileSync(full, "utf8"),
  }));
}

describe("multiWarehouse: codul de multi-depozit rămâne separat de restul stocului (sursa reală)", () => {
  const files = [
    ...load("apps/web/src"),
    ...load("packages/core/src"),
    ...load("packages/jobs/src"),
    ...load("packages/integrations/src"),
  ];

  it("scanează sursele (nu trece în gol) și lista permisă există", () => {
    expect(files.length).toBeGreaterThan(500);
    for (const path of AWARE)
      expect(
        files.some((f) => f.path === path),
        path,
      ).toBe(true);
    for (const path of WAREHOUSE_WRITERS)
      expect(
        files.some((f) => f.path === path),
        path,
      ).toBe(true);
  });

  it("nicio altă sursă nu importă codul de multi-depozit, nu numește flag-ul și nu scrie în tabela de depozite", () => {
    expect(findMultiWarehouseViolations(files)).toEqual([]);
  });

  it("fiecare metodă publică a WarehouseService verifică flag-ul și drepturile înainte de orice", () => {
    const service = files.find(
      (f) => f.path === "packages/core/src/inventory/warehouse-service.ts",
    );
    const content = service?.content ?? "";
    const klass = content.slice(content.indexOf("export class WarehouseService"));
    // metodele publice sunt `  async nume(` (cele private au `private` înainte)
    const found = [...klass.matchAll(/\n {2}async (\w+)\(/g)].map((m) => ({
      name: m[1] as string,
      index: m.index as number,
    }));
    expect(found.map((m) => m.name).sort()).toEqual(
      ["list", "listActive", "create", "rename", "deactivate", "activate"].sort(),
    );
    found.forEach((method, i) => {
      const body = klass.slice(method.index, found[i + 1]?.index ?? klass.length);
      // listActive trece prin list (care verifică); celelalte încep cu `authorize`
      expect(body, `metoda ${method.name}`).toMatch(
        method.name === "listActive" ? /await this\.list\(/ : /await this\.authorize\(/,
      );
    });
    // `authorize` citește steagul ÎNAINTEA drepturilor
    const authorize = klass.slice(klass.indexOf("private async authorize"));
    expect(authorize.indexOf("this.deps.isEnabled()")).toBeGreaterThan(-1);
    expect(authorize.indexOf("this.deps.isEnabled()")).toBeLessThan(
      authorize.indexOf("assertCan("),
    );
  });
});

describe("ecranul «Depozite» e ascuns de flag: meniu, rută, acțiuni (sursa reală)", () => {
  const adminFiles = [...load("apps/web/src/app/(admin)/admin/produse/depozite")];
  const pages = adminFiles.filter((f) => /\/page\.tsx$/.test(f.path));
  const FEATURE_REQUIRED = /requireAdmin\(\s*\{[^}]*feature:\s*["']multiWarehouse["'][^}]*\}\s*\)/;

  it("fiecare pagină de sub /admin/produse/depozite cere flag-ul ȘI inventory.read în requireAdmin (oprit: 404)", () => {
    expect(pages.map((p) => p.path)).toEqual([
      "apps/web/src/app/(admin)/admin/produse/depozite/page.tsx",
    ]);
    for (const page of pages) {
      expect(FEATURE_REQUIRED.test(page.content), page.path).toBe(true);
      expect(page.content, page.path).toMatch(/permission:\s*["']inventory\.read["']/);
    }
  });

  it("intrarea din meniu declară flag-ul și dreptul de citire", () => {
    const nav = readFileSync(join(root, "apps/web/src/lib/admin-nav.ts"), "utf8");
    expect(nav).toMatch(
      /id:\s*"warehouses"[^}]*permission:\s*"inventory\.read"[^}]*feature:\s*"multiWarehouse"/s,
    );
  });

  it("acțiunile cer inventory.write și ating depozitele DOAR prin WarehouseService (care verifică flag-ul)", () => {
    const actions = adminFiles.find((f) => f.path.endsWith("/actions.ts"));
    expect(actions).toBeDefined();
    const content = actions?.content ?? "";
    const exported = [...content.matchAll(/export const (\w+) = withPermission\(\s*"([^"]+)"/g)];
    expect(exported.map((m) => m[1])).toEqual([
      "createWarehouse",
      "renameWarehouse",
      "setWarehouseActive",
    ]);
    for (const [, name, permission] of exported) expect(permission, name).toBe("inventory.write");
    expect(content).toContain("getWarehouseService()");
    // nicio cale spre bază: nici importul clientului, nici o folosire a lui, nici delegatul Prisma al depozitelor
    expect(content).not.toMatch(/getDb|@ecom\/db|\.warehouse\./);
  });
});

describe("transferul între depozite verifică steagul înaintea drepturilor și a bazei (sursa reală)", () => {
  const content = readFileSync(join(root, "packages/core/src/inventory/stock-transfer.ts"), "utf8");
  const body = content.slice(
    content.indexOf("async transfer("),
    content.indexOf("private async run("),
  );

  it("transfer() citește steagul întâi, apoi dreptul, apoi cererea; baza e atinsă abia la urmă", () => {
    const flag = body.indexOf("this.deps.isEnabled()");
    const permission = body.indexOf('assertCan(subject, "inventory.write")');
    const parse = body.indexOf("parseInput(");
    const database = body.indexOf("runStockTransaction(");
    expect(flag).toBeGreaterThan(-1);
    expect(flag).toBeLessThan(permission);
    expect(permission).toBeLessThan(parse);
    expect(parse).toBeLessThan(database);
  });

  it("singura cale spre baza de date e runStockTransaction (nicio altă metodă publică)", () => {
    const klass = content.slice(content.indexOf("export class StockTransferService"));
    // metodele publice sunt `  async nume(` (cele private au `private` înainte)
    const publicMethods = [...klass.matchAll(/\n {2}async (\w+)\(/g)].map((m) => m[1]);
    expect(publicMethods).toEqual(["transfer"]);
  });
});

describe("Stoc cu mai multe depozite (13d): selectorul și transferul sunt ascunse de flag (sursa reală)", () => {
  const read = (path: string): string => readFileSync(join(root, path), "utf8");
  const STOC = "apps/web/src/app/(admin)/admin/produse/stoc";

  it("paginile Stoc și Istoric își aleg depozitul DOAR prin getWarehouseChoice, înaintea oricărei citiri de stoc", () => {
    for (const path of [`${STOC}/page.tsx`, `${STOC}/[variantId]/page.tsx`]) {
      const content = read(path);
      const choice = content.indexOf("getWarehouseChoice(");
      expect(choice, `${path}: alegerea depozitului`).toBeGreaterThan(-1);
      expect(choice, `${path}: alegerea vine înaintea citirii`).toBeLessThan(
        content.search(/\.(?:list|movements|variant)\(\s*subject/),
      );
      // nu numesc flag-ul și nu ating serviciul de depozite sau baza: alegerea e rezolvată într-un singur loc
      expect(content, path).not.toMatch(/multiWarehouse|getWarehouseService|getDb|@ecom\/db/);
    }
  });

  it("pagina Stoc desenează selectorul și butonul de transfer doar când alegerea e vizibilă ȘI utilizatorul poate scrie", () => {
    const page = read(`${STOC}/page.tsx`);
    expect(page).toMatch(/choice\.visible/);
    // `transfer` către tabele se dă doar cu `canWrite && choice.visible`
    expect(page).toMatch(/canWrite\s*&&\s*choice\.visible/);
    // adresa păstrează depozitul ales în toate legăturile (filtre, vedere, paginare): pagina dă `urlQuery`, nu `query`
    expect(page).toMatch(/warehouseCode/);
    expect(page).toMatch(/stockHref\(urlQuery,\s*\{\s*page:\s*target\s*\}\)/);
    expect(page).toMatch(/<ViewSwitch\s+query=\{urlQuery\}/);
    expect(page).toMatch(/<StockFilters\s+query=\{urlQuery\}/);
    expect(page).toMatch(/<LowStockSummary\s+counts=\{page\.lowStock\}\s+query=\{urlQuery\}/);
  });

  it("getWarehouseChoice citește flag-ul real și îl dă alegerii; nu există altă citire a flag-ului pentru Stoc", () => {
    const inventory = read("apps/web/src/lib/inventory.ts");
    const start = inventory.indexOf("export async function getWarehouseChoice");
    expect(start).toBeGreaterThan(-1);
    const body = inventory.slice(start);
    expect(body).toMatch(/enabled:\s*await\s+getFeatureFlags\(\)\.isEnabled\("multiWarehouse"\)/);
    expect(body).toMatch(/resolveWarehouseChoice\(/);
    expect(body).toMatch(/getWarehouseService\(\)\.listActive\(/);
  });

  it("acțiunile din Stoc: ajustare, prag și transfer, toate cu inventory.write; transferul trece doar prin StockTransferService", () => {
    const actions = read(`${STOC}/actions.ts`);
    const exported = [...actions.matchAll(/export const (\w+) = withPermission\(\s*"([^"]+)"/g)];
    expect(exported.map((m) => m[1])).toEqual([
      "adjustStock",
      "setLowStockThreshold",
      "transferStock",
    ]);
    for (const [, name, permission] of exported) expect(permission, name).toBe("inventory.write");
    const transfer = actions.slice(actions.indexOf("export const transferStock"));
    expect(transfer).toContain("getStockTransferService().transfer(subject, input)");
    expect(transfer).toContain('{ action: "stock.transfer", entity: "stock_transfer" }');
    // nicio cale spre baza de date și niciun calcul de stoc în acțiune
    expect(actions).not.toMatch(/getDb|@ecom\/db|\.inventoryItem\.|\.stockMovement\./);
  });

  it("fiecare cod de eroare al transferului (și cele de cantitate) ajunge la dialog ca eroare de domeniu, nu ca eroare 500", () => {
    const transfer = read("packages/core/src/inventory/stock-transfer.ts");
    const codes = new Set([...transfer.matchAll(/"(STOCK_TRANSFER_[A-Z_]+)"/g)].map((m) => m[1]));
    expect(codes.size).toBeGreaterThanOrEqual(7);
    const support = read("apps/web/src/lib/product-action-support.ts");
    const domain = support.slice(support.indexOf("const DOMAIN_CODES"));
    for (const code of [
      ...codes,
      "QUANTITY_NOT_MULTIPLE_OF_STEP",
      "STOCK_NO_WAREHOUSE",
      "FEATURE_DISABLED",
    ]) {
      expect(domain, code).toContain(`"${code}"`);
    }
  });

  it("dialogul de transfer are mesaj propriu în română pentru fiecare cod de eroare (nu arată codul brut)", () => {
    const transfer = read("packages/core/src/inventory/stock-transfer.ts");
    const codes = new Set([...transfer.matchAll(/"(STOCK_TRANSFER_[A-Z_]+)"/g)].map((m) => m[1]));
    const messages = read("apps/web/src/messages/ro.ts");
    const section = messages.slice(messages.indexOf("transfer: {"));
    for (const code of [...codes, "QUANTITY_NOT_MULTIPLE_OF_STEP", "FEATURE_DISABLED"]) {
      expect(section, code).toContain(`${code}:`);
    }
  });
});

describe("findMultiWarehouseViolations pe fișiere sintetice (testul pică când trebuie)", () => {
  it("prinde importul codului de multi-depozit în rezervări, import sau disponibilitate", () => {
    const problems = findMultiWarehouseViolations([
      {
        path: "packages/core/src/inventory/stock-service.ts",
        content: `import { WarehouseService } from "./warehouse-service";`,
      },
      {
        path: "packages/core/src/inventory/stock-report-import.ts",
        content: `import { createPrismaWarehouseStore } from "./warehouse-store";`,
      },
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("importă codul de multi-depozit");
  });

  it("prinde numirea flag-ului în afara listei", () => {
    const problems = findMultiWarehouseViolations([
      {
        path: "packages/core/src/inventory/availability.ts",
        content: `if (await flags.isEnabled("multiWarehouse")) { }`,
      },
    ]);
    expect(problems).toEqual([expect.stringContaining("multiWarehouse")]);
  });

  it("prinde scrierea directă în tabela de depozite", () => {
    const problems = findMultiWarehouseViolations([
      {
        path: "apps/web/src/app/(admin)/admin/produse/stoc/actions.ts",
        content: `await getDb().warehouse.update({ where: { id }, data: { name } });`,
      },
      {
        path: "packages/core/src/inventory/stock-activation.ts",
        content: `await tx.warehouse.create({ data });`,
      },
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("tabela de depozite");
  });

  it("nu dă fals pozitive: fișierele permise, citirea depozitelor, testele și fixture-urile", () => {
    expect(
      findMultiWarehouseViolations([
        {
          path: "packages/core/src/inventory/warehouse-store.ts",
          content: `import { x } from "./warehouse-service"; db.warehouse.create({ data });`,
        },
        {
          path: "apps/web/src/lib/inventory.ts",
          content: `import { WarehouseService } from "@ecom/core"; isEnabled("multiWarehouse")`,
        },
        { path: "packages/core/src/seed/base-seed.ts", content: `db.warehouse.upsert({})` },
        {
          path: "packages/core/src/inventory/stock-service.ts",
          content: `await tx.warehouse.findFirst({ where: { isDefault: true } });`,
        },
        {
          path: "packages/core/src/inventory/x.integration.test.ts",
          content: `tx.warehouse.create({}); import "./warehouse-service"; "multiWarehouse"`,
        },
        {
          path: "packages/core/src/test-utils/stock-fixtures.ts",
          content: `db.warehouse.create({})`,
        },
      ]),
    ).toEqual([]);
  });
});
