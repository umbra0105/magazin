import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură pentru comenzi (Faza 9). Reguli, pe codul de producție (testele, e2e și scripturile sunt scutite):
 *  1. O comandă se creează DOAR prin `CheckoutService` (`orders/checkout-service.ts`): niciun alt `order.create` sau
 *     `INSERT INTO customer_order`. Totalul vine DOAR din `CartService` (motorul de prețuri) și din `computeOrderTotals`: în
 *     `orders/` nu se apelează `priceLines` / `resolveUnitPrice` (niciun al doilea calcul de preț).
 *  2. Starea unei comenzi (`status`, `paymentStatus`, `fulfillmentStatus`) se schimbă DOAR prin `transitionOrder`
 *     (`orders/order-service.ts`): niciun alt `order.update`, `order.updateMany`, `order.upsert` sau `UPDATE customer_order`.
 *  3. `OrderEvent` e jurnal: nicio cale de producție nu face update sau delete pe el.
 *  4. Referința de stoc a comenzii vine din constanta `ORDER_REF_TYPE`: niciun `refType: "order"` scris de mână.
 *  5. Fără `float` pe sume în zona comenzilor (`orders/`): niciun `parseFloat`, `toFixed`, `Math.round|floor|ceil|trunc`, niciun
 *     literal zecimal. Sumele sunt `int` în bani, TVA-ul se extrage cu `vat.ts`.
 *  6. Costul de achiziție nu apare în zonele comenzii, livrării, geografiei și checkout-ului (nici în interfața lor).
 *  7. Niciun apel direct la ANAF în afara clientului din `packages/integrations/src/anaf`.
 *  8. Rambursul interzis la liniile «La comandă» (regulă fixă): decizia stă DOAR în `orders/payment-rules.ts`; `CheckoutService`
 *     o apelează și la previzualizare (`availablePaymentMethods`) ȘI la plasare (`assertPaymentMethodAllowed`); interfața din
 *     checkout și codul de transport nu o refac (niciun `"on_order"` în componentele de checkout, în `checkout-dto` doar ca motiv).
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
  /checkout-fixtures\.ts$/.test(path) ||
  /(^|\/)scripts\//.test(path);

const isCode = (path: string): boolean => /\.[cm]?tsx?$/.test(path) && !isTestPath(path);

/** Scoate comentariile, păstrând numerele de linie și șirurile (regulile caută și în SQL scris ca text; `//` din URL nu e comentariu). */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i] as string;
    const n = source[i + 1];
    if (c === "/" && n === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          out += source[i];
          i++;
        }
        out += source[i] ?? "";
        i++;
      }
      out += quote;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Scoate comentariile ȘI șirurile de caractere (pentru reguli care se aplică doar pe cod, nu pe text). */
export function stripCommentsAndStrings(source: string): string {
  const text = stripComments(source);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        if (text[i] === "\n") out += "\n";
        i++;
      }
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function listFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".") || name === "generated") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...listFiles(full));
    else found.push(full);
  }
  return found;
}

function productionFiles(): SourceFile[] {
  const dirs = [
    "packages/core/src",
    "packages/jobs/src",
    "packages/integrations/src",
    "apps/web/src",
  ];
  return dirs.flatMap((dir) =>
    listFiles(join(root, dir))
      .map((full) => relative(root, full).split(sep).join("/"))
      .filter(isCode)
      .map((path) => ({ path, content: readFileSync(join(root, path), "utf8") })),
  );
}

const CHECKOUT_SERVICE = "packages/core/src/orders/checkout-service.ts";
const ORDER_SERVICE = "packages/core/src/orders/order-service.ts";
const ORDERS_ZONE = /^packages\/core\/src\/orders\//;
const NO_COST_ZONE =
  /^(packages\/core\/src\/(orders|shipping|geo)\/|apps\/web\/src\/(lib\/checkout|components\/storefront\/(checkout|order)|app\/\(checkout\)|app\/\(storefront\)\/comanda))/;

export interface Violation {
  path: string;
  line: number;
  rule: string;
}

function scan(
  files: readonly SourceFile[],
  applies: (path: string) => boolean,
  rules: ReadonlyArray<[RegExp, string]>,
  strip: (source: string) => string,
): Violation[] {
  const found: Violation[] = [];
  for (const file of files) {
    if (!applies(file.path)) continue;
    const lines = strip(file.content).split("\n");
    for (const [pattern, rule] of rules) {
      lines.forEach((text, index) => {
        if (pattern.test(text)) found.push({ path: file.path, line: index + 1, rule });
      });
    }
  }
  return found;
}

export function findOrderCreation(files: readonly SourceFile[]): Violation[] {
  return scan(
    files,
    (path) => path !== CHECKOUT_SERVICE,
    [
      [
        /\.order\.(?:create|createMany|createManyAndReturn)\s*\(/,
        "order.create în afara CheckoutService",
      ],
      [
        /INSERT\s+INTO\s+"?customer_order"?/i,
        "INSERT INTO customer_order în afara CheckoutService",
      ],
    ],
    stripComments,
  );
}

export function findStatusWrites(files: readonly SourceFile[]): Violation[] {
  return scan(
    files,
    (path) => path !== ORDER_SERVICE,
    [
      [/\.order\.(?:update|updateMany|upsert)\s*\(/, "order.update în afara transitionOrder"],
      [/UPDATE\s+"?customer_order"?/i, "UPDATE customer_order în afara transitionOrder"],
    ],
    stripComments,
  );
}

export function findEventMutations(files: readonly SourceFile[]): Violation[] {
  return scan(
    files,
    () => true,
    [
      [
        /\.orderEvent\.(?:update|updateMany|upsert|delete|deleteMany)\s*\(/,
        "orderEvent modificat sau șters",
      ],
      [/(?:UPDATE|DELETE\s+FROM)\s+"?order_event"?/i, "order_event modificat sau șters prin SQL"],
    ],
    stripComments,
  );
}

export function findSecondPricing(files: readonly SourceFile[]): Violation[] {
  return scan(
    files,
    (path) => ORDERS_ZONE.test(path),
    [[/\b(?:priceLines|resolveUnitPrice)\s*\(/, "calcul de preț în afara motorului"]],
    stripCommentsAndStrings,
  );
}

export function findOrderRefLiteral(files: readonly SourceFile[]): Violation[] {
  return scan(
    files,
    (path) => path !== "packages/core/src/inventory/constants.ts",
    [
      [
        /refType\s*:\s*["'`]order["'`]/,
        'refType: "order" scris de mână (folosește ORDER_REF_TYPE)',
      ],
    ],
    stripComments,
  );
}

const FLOAT_FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/\bparseFloat\s*\(/, "parseFloat"],
  [/\.toFixed\s*\(/, "toFixed"],
  [/\bMath\.(?:round|floor|ceil|trunc)\s*\(/, "Math.round/floor/ceil/trunc"],
  [/(?<![\w.])\d+\.\d+(?![\w.])/, "literal zecimal"],
];

export function findFloatMoney(files: readonly SourceFile[]): Violation[] {
  return scan(files, (path) => ORDERS_ZONE.test(path), FLOAT_FORBIDDEN, stripCommentsAndStrings);
}

export function findCostNames(files: readonly SourceFile[]): Violation[] {
  return scan(
    files,
    (path) => NO_COST_ZONE.test(path),
    [[/\bcost(?:Price|PriceDate|Net)\w*|CostPriceHistory/i, "cost de achiziție în zona comenzii"]],
    stripCommentsAndStrings,
  );
}

export function findAnafCalls(files: readonly SourceFile[]): Violation[] {
  return scan(
    files,
    (path) => !path.startsWith("packages/integrations/src/anaf/"),
    [[/webservicesp\.anaf\.ro/, "adresa ANAF în afara clientului ANAF"]],
    stripComments,
  );
}

const PAYMENT_RULES = "packages/core/src/orders/payment-rules.ts";

/** Regula rambursului stă într-un singur loc, iar serverul o aplică și la previzualizare, și la plasare. */
export function findCodRuleBypass(files: readonly SourceFile[]): Violation[] {
  const found = scan(
    files,
    (path) =>
      path !== PAYMENT_RULES &&
      (/^packages\/core\/src\/(orders|shipping)\//.test(path) ||
        /^apps\/web\/src\/(components\/storefront\/checkout|app\/\(checkout\))/.test(path)),
    [
      [/\bon_order\b/, "stare «La comandă» citită în afara payment-rules pentru a decide plata"],
      [/\bhas_on_order_line\b/, "motivul regulii rambursului construit în afara payment-rules"],
    ],
    stripComments,
  ).filter(
    (v) =>
      // locuri legitime: starea fizică a liniei (stoc, termen de livrare), nu decizia de plată
      !/^packages\/core\/src\/(orders\/(checkout-service|order-read)\.ts|shipping\/)/.test(v.path),
  );
  const service = files.find((f) => f.path === CHECKOUT_SERVICE);
  const text = service ? stripComments(service.content) : "";
  for (const call of ["availablePaymentMethods(", "assertPaymentMethodAllowed("]) {
    if (!text.includes(call))
      found.push({
        path: CHECKOUT_SERVICE,
        line: 1,
        rule: `CheckoutService nu mai apelează ${call}): rambursul la «La comandă» nu mai e validat`,
      });
  }
  return found;
}

const file = (path: string, content: string): SourceFile => ({ path, content });

describe("funcțiile de verificare găsesc încălcările (cazuri sintetice)", () => {
  it("crearea comenzii în afara CheckoutService", () => {
    expect(
      findOrderCreation([file("packages/core/src/x.ts", "await tx.order.create({ data })")]),
    ).toHaveLength(1);
    expect(
      findOrderCreation([
        file("apps/web/src/a.ts", "db.$executeRaw`INSERT INTO customer_order (id) VALUES (1)`"),
      ]),
    ).toHaveLength(1);
    expect(
      findOrderCreation([file(CHECKOUT_SERVICE, "await tx.order.create({ data })")]),
    ).toHaveLength(0);
    expect(
      findOrderCreation([file("packages/core/src/x.ts", "// tx.order.create ar fi interzis")]),
    ).toHaveLength(0);
  });
  it("scrierea stărilor în afara transitionOrder", () => {
    expect(
      findStatusWrites([
        file("packages/core/src/x.ts", 'await db.order.update({ where, data: { status: "x" } })'),
      ]),
    ).toHaveLength(1);
    expect(
      findStatusWrites([file("packages/core/src/x.ts", "UPDATE customer_order SET status = 'x'")]),
    ).toHaveLength(1);
    expect(
      findStatusWrites([file(ORDER_SERVICE, "await tx.order.update({ where, data })")]),
    ).toHaveLength(0);
  });
  it("modificarea jurnalului", () => {
    expect(
      findEventMutations([file("packages/core/src/x.ts", "tx.orderEvent.deleteMany({})")]),
    ).toHaveLength(1);
    expect(
      findEventMutations([file("packages/core/src/x.ts", "tx.orderEvent.create({ data })")]),
    ).toHaveLength(0);
  });
  it("al doilea calcul de preț", () => {
    expect(
      findSecondPricing([file("packages/core/src/orders/x.ts", "priceLines(list, options)")]),
    ).toHaveLength(1);
    expect(
      findSecondPricing([file("packages/core/src/cart/x.ts", "priceLines(list, options)")]),
    ).toHaveLength(0);
  });
  it("referința de stoc scrisă de mână", () => {
    expect(
      findOrderRefLiteral([
        file("packages/core/src/x.ts", 'const ref = { refType: "order", refId }'),
      ]),
    ).toHaveLength(1);
    expect(
      findOrderRefLiteral([file("packages/core/src/inventory/constants.ts", 'refType: "order"')]),
    ).toHaveLength(0);
  });
  it("float pe sume, costul și ANAF", () => {
    expect(
      findFloatMoney([file("packages/core/src/orders/x.ts", "const a = Math.round(x * 1.5)")])
        .length,
    ).toBeGreaterThan(0);
    expect(
      findFloatMoney([file("packages/core/src/orders/x.ts", "const a = bigint")]),
    ).toHaveLength(0);
    expect(
      findCostNames([file("packages/core/src/orders/x.ts", "const c = line.costPrice")]),
    ).toHaveLength(1);
    expect(
      findAnafCalls([file("apps/web/src/a.ts", 'fetch("https://webservicesp.anaf.ro/x")')]),
    ).toHaveLength(1);
    expect(
      findAnafCalls([
        file(
          "packages/integrations/src/anaf/anaf-client.ts",
          'const U = "https://webservicesp.anaf.ro/x"',
        ),
      ]),
    ).toHaveLength(0);
  });
});

describe("regula rambursului (cazuri sintetice)", () => {
  const service = (body: string) => file(CHECKOUT_SERVICE, body);
  const ok = service("availablePaymentMethods({}); assertPaymentMethodAllowed({}, m);");
  it("trece când serverul aplică regula în ambele locuri", () => {
    expect(findCodRuleBypass([ok])).toEqual([]);
  });
  it("pică dacă la plasare nu se mai validează metoda", () => {
    expect(findCodRuleBypass([service("availablePaymentMethods({});")]).length).toBe(1);
  });
  it("pică dacă previzualizarea nu mai calculează metodele", () => {
    expect(findCodRuleBypass([service("assertPaymentMethodAllowed({}, m);")]).length).toBe(1);
  });
  it("pică dacă interfața de checkout re-decide rambursul", () => {
    const ui = file(
      "apps/web/src/components/storefront/checkout/checkout-flow.tsx",
      'const noCod = lines.some((l) => l.state === "on_order");',
    );
    expect(findCodRuleBypass([ok, ui]).length).toBe(1);
  });
  it("pică dacă un alt fișier din orders/ refolosește motivul", () => {
    const other = file("packages/core/src/orders/x.ts", 'const r = "has_on_order_line";');
    expect(findCodRuleBypass([ok, other]).length).toBe(1);
  });
});

describe("codul de producție respectă regulile comenzilor", () => {
  const files = productionFiles();
  const show = (violations: Violation[]) => violations.map((v) => `${v.path}:${v.line} ${v.rule}`);

  it("scanează fișiere (nu trece în gol)", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.path === CHECKOUT_SERVICE)).toBe(true);
    expect(files.some((f) => f.path === ORDER_SERVICE)).toBe(true);
  });
  it("comanda se creează doar în CheckoutService", () => {
    expect(show(findOrderCreation(files))).toEqual([]);
  });
  it("starea comenzii se schimbă doar prin transitionOrder", () => {
    expect(show(findStatusWrites(files))).toEqual([]);
  });
  it("jurnalul comenzii nu se modifică și nu se șterge", () => {
    expect(show(findEventMutations(files))).toEqual([]);
  });
  it("niciun al doilea calcul de preț în zona comenzilor", () => {
    expect(show(findSecondPricing(files))).toEqual([]);
  });
  it("referința de stoc a comenzii vine din constantă", () => {
    expect(show(findOrderRefLiteral(files))).toEqual([]);
  });
  it("fără float pe sume în zona comenzilor", () => {
    expect(show(findFloatMoney(files))).toEqual([]);
  });
  it("costul de achiziție nu apare în zona comenzii, livrării și checkout-ului", () => {
    expect(show(findCostNames(files))).toEqual([]);
  });
  it("ANAF se apelează doar din clientul dedicat", () => {
    expect(show(findAnafCalls(files))).toEqual([]);
  });
  it("rambursul interzis la «La comandă»: o singură regulă, aplicată la previzualizare și la plasare", () => {
    expect(show(findCodRuleBypass(files))).toEqual([]);
  });
});
