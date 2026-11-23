import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură pentru contul clientului și retururi (Faza 14). Reguli, pe codul de producție (testele, e2e și scripturile sunt
 * scutite):
 *  1. `ReturnRequest.status` se scrie DOAR în `returns/return-transition.ts` (state machine explicit, ca la comenzi): nicio altă cale nu
 *     face `returnRequest.update/updateMany/upsert` cu `status`.
 *  2. Orice interogare pe comenzi din serviciile contului (`packages/core/src/account`) trece prin regula de proprietate
 *     (`ownedOrdersWhere` / `ownedOrderWhere`), deci un client nu poate atinge comanda altuia.
 *  3. Ecranele și rutele clientului (`cont`, `components/storefront/account`, `api/account`) nu conțin câmpuri interne: nota internă,
 *     marcajul «La furnizor», starea stornoului sau costul de achiziție.
 *  4. Costul de achiziție nu apare nicăieri în `account` și `returns` (core), nici în exportul GDPR.
 *  5. Wishlist-ul stă în spatele flag-ului `wishlist`: pagina, ruta de stare și acțiunea îl verifică ÎNAINTE de orice citire sau scriere.
 *  6. Rambursarea unui retur trece EXCLUSIV prin serviciul din Faza 10 (`requestOrderRefund`): `returns` nu scrie `refund` sau `payment`.
 *  7. Repunerea pe stoc trece prin `StockService.adjustPhysical`: `returns` nu scrie direct `inventoryItem` sau `stockMovement`.
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

const code = load(["apps/web/src", "packages/core/src", "packages/jobs/src"]);

/** Argumentele (text) ale apelului care începe la `open` (paranteza deschisă), cu paranteze echilibrate. */
function callArguments(content: string, open: number): string {
  let depth = 0;
  for (let i = open; i < content.length; i += 1) {
    const char = content[i];
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return content.slice(open + 1, i);
    }
  }
  return content.slice(open + 1);
}

/** Apelurile `<receiver>.<method>(...)` din fișiere, cu argumentele lor. */
function findCalls(
  files: readonly SourceFile[],
  receiver: RegExp,
  methods: readonly string[],
): Array<{ path: string; method: string; args: string }> {
  const out: Array<{ path: string; method: string; args: string }> = [];
  const pattern = new RegExp(`${receiver.source}\\s*\\.\\s*(${methods.join("|")})\\s*\\(`, "g");
  for (const file of files) {
    const text = stripComments(file.content);
    for (const match of text.matchAll(pattern)) {
      const open = (match.index ?? 0) + match[0].length - 1;
      out.push({ path: file.path, method: match[1] as string, args: callArguments(text, open) });
    }
  }
  return out;
}

export function findReturnStatusWrites(
  files: readonly SourceFile[],
  allowed: readonly string[],
): string[] {
  return findCalls(files, /\breturnRequest/, [
    "update",
    "updateMany",
    "upsert",
    "create",
    "createMany",
  ])
    .filter((call) => /\bstatus\s*:/.test(call.args) && !allowed.includes(call.path))
    .map(
      (call) =>
        `${call.path}: returnRequest.${call.method} scrie «status» în afara state machine-ului`,
    );
}

export function findUnownedOrderQueries(files: readonly SourceFile[]): string[] {
  return findCalls(files, /\b(?:db|tx)\s*\.\s*order\b/, [
    "findMany",
    "findFirst",
    "findFirstOrThrow",
    "count",
    "findUnique",
  ])
    .filter((call) => !/ownedOrdersWhere|ownedOrderWhere/.test(call.args))
    .map((call) => `${call.path}: order.${call.method} fără regula de proprietate`);
}

export function findForbiddenWords(files: readonly SourceFile[], words: RegExp): string[] {
  const out: string[] = [];
  for (const file of files) {
    const match = words.exec(stripComments(file.content));
    if (match) out.push(`${file.path}: conține «${match[0]}»`);
  }
  return out;
}

export function findDirectMoneyOrStockWrites(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const call of findCalls(
    files,
    /\b(?:db|tx|inner)\s*\.\s*(?:refund|payment|inventoryItem|stockMovement|stockSnapshot)\b/,
    ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"],
  )) {
    out.push(`${call.path}: ${call.method} direct pe bani sau stoc`);
  }
  return out;
}

const filesIn = (prefixes: readonly string[]) =>
  code.filter((f) => prefixes.some((p) => f.path.startsWith(p)));

describe("contul clientului și retururile respectă regulile (codul real)", () => {
  it("1 · statusul returului se scrie doar în return-transition.ts", () => {
    expect(code.some((f) => f.path === "packages/core/src/returns/return-transition.ts")).toBe(
      true,
    );
    expect(
      findReturnStatusWrites(code, ["packages/core/src/returns/return-transition.ts"]),
    ).toEqual([]);
  });

  it("2 · interogările pe comenzi din contul clientului trec prin regula de proprietate", () => {
    const account = filesIn(["packages/core/src/account/"]);
    expect(account.length).toBeGreaterThan(3);
    expect(findUnownedOrderQueries(account)).toEqual([]);
  });

  it("3 · ecranele și rutele clientului nu conțin câmpuri interne", () => {
    const customer = filesIn([
      "apps/web/src/app/(storefront)/cont/",
      "apps/web/src/components/storefront/account/",
      "apps/web/src/app/api/account/",
    ]);
    expect(customer.length).toBeGreaterThan(10);
    expect(
      findForbiddenWords(
        customer,
        /\b(adminNote|supplierName|supplierNote|supplierMarkedAt|stornoState|stornoNote|costPrice|costNet|OrderNote)\b/,
      ),
    ).toEqual([]);
  });

  it("4 · costul de achiziție nu apare în contul clientului și în retururi", () => {
    expect(
      findForbiddenWords(
        filesIn(["packages/core/src/account/", "packages/core/src/returns/"]),
        /\b(costPrice|costPriceDate|costNet|CostPriceHistory)\b/,
      ),
    ).toEqual([]);
  });

  it("5 · wishlist-ul verifică flag-ul înaintea oricărei citiri sau scrieri", () => {
    const page = code.find(
      (f) => f.path === "apps/web/src/app/(storefront)/cont/favorite/page.tsx",
    );
    expect(page?.content).toMatch(/await requireFlag\("wishlist"\)/);
    const state = code.find(
      (f) => f.path === "apps/web/src/app/api/account/wishlist-state/route.ts",
    );
    expect(state?.content).toMatch(/isFlagOn\("wishlist"\)/);
    const actions = code.find((f) => f.path === "apps/web/src/app/(storefront)/cont/actions.ts");
    const toggle =
      /export async function toggleWishlistAction[\s\S]*?\n}\n/.exec(actions?.content ?? "")?.[0] ??
      "";
    expect(toggle).toMatch(/await requireFlag\("wishlist"\)/);
    expect(toggle.indexOf("requireFlag")).toBeLessThan(toggle.indexOf("addToWishlist"));
  });

  it("6 și 7 · retururile nu scriu direct bani sau stoc", () => {
    const returns = filesIn(["packages/core/src/returns/"]);
    expect(returns.length).toBeGreaterThan(8);
    expect(findDirectMoneyOrStockWrites(returns)).toEqual([]);
    const refund = code.find((f) => f.path === "packages/core/src/returns/return-refund.ts");
    expect(refund?.content).toMatch(/requestOrderRefund\(/);
    const restock = code.find((f) => f.path === "packages/core/src/returns/return-restock.ts");
    expect(restock?.content).toMatch(/adjustPhysical\(/);
  });
});

describe("funcțiile de verificare prind încălcările (cazuri sintetice)", () => {
  const f = (path: string, content: string): SourceFile => ({ path, content });

  it("statusul scris în afara state machine-ului e prins; în afara lui, nu", () => {
    const bad = f(
      "packages/core/src/returns/x.ts",
      "await tx.returnRequest.update({ where: { id }, data: { status: 'approved' } });",
    );
    expect(findReturnStatusWrites([bad], ["a.ts"])).toHaveLength(1);
    const ok = f(
      "packages/core/src/returns/y.ts",
      "await tx.returnRequest.update({ where: { id }, data: { adminNote: 'x' } });",
    );
    expect(findReturnStatusWrites([ok], [])).toEqual([]);
    const allowed = f("a.ts", "await tx.returnRequest.update({ data: { status: to } });");
    expect(findReturnStatusWrites([allowed], ["a.ts"])).toEqual([]);
    const commented = f("c.ts", "// tx.returnRequest.update({ data: { status: 'x' } })");
    expect(findReturnStatusWrites([commented], [])).toEqual([]);
  });

  it("o interogare pe comenzi fără proprietate e prinsă", () => {
    expect(
      findUnownedOrderQueries([f("a.ts", "await db.order.findMany({ where: { email } });")]),
    ).toHaveLength(1);
    expect(
      findUnownedOrderQueries([
        f("a.ts", "await db.order.findMany({ where: ownedOrdersWhere(user) });"),
      ]),
    ).toEqual([]);
    expect(
      findUnownedOrderQueries([
        f("a.ts", "await tx.order.findFirst({ where: ownedOrderWhere(user, id) });"),
      ]),
    ).toEqual([]);
  });

  it("cuvintele interzise sunt prinse, iar comentariile nu contează", () => {
    expect(
      findForbiddenWords([f("a.tsx", "const x = order.adminNote;")], /\badminNote\b/),
    ).toHaveLength(1);
    expect(findForbiddenWords([f("a.tsx", "// adminNote nu apare")], /\badminNote\b/)).toEqual([]);
  });

  it("scrierile directe pe bani sau stoc sunt prinse", () => {
    expect(
      findDirectMoneyOrStockWrites([f("a.ts", "await tx.refund.create({ data })")]),
    ).toHaveLength(1);
    expect(
      findDirectMoneyOrStockWrites([f("a.ts", "await tx.inventoryItem.update({ data })")]),
    ).toHaveLength(1);
    expect(findDirectMoneyOrStockWrites([f("a.ts", "await tx.refund.findMany({})")])).toEqual([]);
  });
});
