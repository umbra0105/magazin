import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Curățarea comenzilor și a plăților în specurile E2E: fiecare fișier șterge DOAR ce e al lui, pe tag (mini-faza
 * `e2e-curatare-comenzi`).
 *
 * `removeE2eOrders()` fără tag ștergea TOATE comenzile cu emailul `@e2e-comanda.invalid`. Apelată din `afterAll` de mai multe specuri
 * din proiectul `chromium` (`fullyParallel`), ștergerea unui fișier lovea comanda în lucru a altuia: `checkout.spec.ts:146` a picat
 * în `verify:full` (`readE2eOrder` = `null`), reprodus 3 din 3 cu un proces separat care apela în buclă ștergerea globală. Regula
 * (din CLAUDE.md: fixture-urile comune cu curățare globală se folosesc dintr-un singur loc):
 *  1. niciun fișier din `e2e/` în afară de `global-setup.ts` și `global-teardown.ts` nu atinge ștergerile GLOBALE
 *     (`removeAllE2eOrders`, `removeAllE2eDemoPayments`: comenzile tuturor tag-urilor, integrarea DEMO, furnizorul de card);
 *  2. orice apel `removeE2eOrders(...)` / `removeE2eDemoPayments(...)` primește `{ tag }`, iar `tag` e declarat în același fișier ca
 *     `const tag = randomBytes(N).toString("hex")` (aleator: două fișiere nu pot împărți un tag; un tag fix, literal, e refuzat);
 *  3. `global-setup.ts` și `global-teardown.ts` fac curățarea globală (plățile ÎNTÂI, rambursările blochează ștergerea comenzilor);
 *  4. orice spec care apelează `seedE2eDemoPayments` apelează `removeE2eDemoProvider()` (doar starea: rândul `integration` și
 *     `payment.cardProvider`, nu comenzi) într-un `afterAll`, ca «Card online» să nu rămână activ pentru specurile care rulează după
 *     el (`checkout.spec.ts:165` afirmă că cardul NU există; `verify:full` din 2026-11-21 a picat când starea a rămas până la teardown).
 *
 * Citește sursa ca text; `findOrdersCleanupViolations` e pură și testată pe fișiere sintetice, iar mutanții (câte o stricare a
 * fiecărei reguli) se aplică atât pe fișiere sintetice, cât și pe specurile reale: toți trebuie prinși.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

/** Ștergerile globale: doar `global-setup` și `global-teardown` le pot atinge. */
export const GLOBAL_DELETERS = ["removeAllE2eOrders", "removeAllE2eDemoPayments"] as const;
/** Ștergerile pe tag: apelul primește `{ tag }`. */
export const TAGGED_DELETERS = ["removeE2eOrders", "removeE2eDemoPayments"] as const;
const GLOBAL_FILES = ["e2e/global-setup.ts", "e2e/global-teardown.ts"];

const TAG_ARGUMENT = /^\s*\{\s*tag(?:\s*:\s*tag)?\s*,?\s*\}\s*$/;
const TAG_DECLARATION = /^\s*const tag = randomBytes\((\d+)\)\.toString\("hex"\);?\s*$/gm;
const FIXED_TAG = /\bconst tag\s*(?::\s*string)?\s*=\s*["'`]([^"'`]*)["'`]/g;

/** Fără comentarii: un apel dintr-un comentariu nu contează. */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

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

function calls(content: string, name: string): Array<{ args: string; line: number }> {
  const found: Array<{ args: string; line: number }> = [];
  const pattern = new RegExp(`\\b${name}\\(`, "g");
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    found.push({
      args: callArguments(content, match.index + name.length),
      line: content.slice(0, match.index).split("\n").length,
    });
  }
  return found;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** Poziția primului apel al lui `name`, sau -1. */
function firstCall(content: string, name: string): number {
  return content.search(new RegExp(`\\b${name}\\(`));
}

/** Un apel `afterAll(...)` al cărui corp apelează `name(...)` (fără comentarii: `code` e deja curățat). */
export function afterAllCalls(code: string, name: string): boolean {
  return calls(code, "afterAll").some((call) => call.args.includes(`${name}(`));
}

export function findOrdersCleanupViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  const fixedTags = new Map<string, string>();
  for (const file of files) {
    const code = stripComments(file.content);
    if (GLOBAL_FILES.includes(file.path)) {
      for (const name of GLOBAL_DELETERS) {
        if (firstCall(code, name) < 0) {
          problems.push(
            `${file.path}: lipsește curățarea globală \`${name}()\` (rândurile rămase dintr-o rulare întreruptă nu s-ar mai șterge)`,
          );
        }
      }
      const payments = firstCall(code, "removeAllE2eDemoPayments");
      const orders = firstCall(code, "removeAllE2eOrders");
      if (payments >= 0 && orders >= 0 && payments > orders) {
        problems.push(
          `${file.path}: \`removeAllE2eDemoPayments\` trebuie apelată ÎNAINTE de \`removeAllE2eOrders\` (rambursările blochează ștergerea comenzilor)`,
        );
      }
      continue;
    }
    // (1) ștergerile globale, în orice fișier din e2e/ în afară de setup și teardown (apel, import sau altă referință)
    for (const name of GLOBAL_DELETERS) {
      const reference = new RegExp(`\\b${name}\\b`).exec(code);
      if (reference) {
        problems.push(
          `${file.path}:${lineOf(code, reference.index)}: \`${name}\` e curățare GLOBALĂ (comenzile și plățile tuturor fișierelor): doar global-setup și global-teardown o pot apela`,
        );
      }
    }
    // (2) ștergerile pe tag: apel cu `{ tag }` și `tag` declarat aleator în același fișier
    const tagged = TAGGED_DELETERS.flatMap((name) =>
      calls(code, name).map((call) => ({ name, ...call })),
    );
    for (const literal of code.matchAll(FIXED_TAG)) {
      const value = literal[1] ?? "";
      problems.push(
        `${file.path}:${lineOf(code, literal.index ?? 0)}: tag fix («${value}»): tag-ul se declară \`const tag = randomBytes(N).toString("hex")\`, aleator la fiecare rulare`,
      );
      const owner = fixedTags.get(value);
      if (owner !== undefined && owner !== file.path) {
        problems.push(`${file.path}: tag-ul fix «${value}» e folosit și de ${owner}`);
      } else fixedTags.set(value, file.path);
    }
    // (2b) cine seedează integrarea DEMO îi șterge starea (rândul `integration` și `payment.cardProvider`) într-un afterAll
    if (
      calls(code, "seedE2eDemoPayments").length > 0 &&
      !afterAllCalls(code, "removeE2eDemoProvider")
    ) {
      problems.push(
        `${file.path}: seedează integrarea DEMO (\`seedE2eDemoPayments\`), deci trebuie să apeleze \`removeE2eDemoProvider()\` în \`afterAll\` (starea comună a plăților nu rămâne activă pentru specurile următoare)`,
      );
    }
    if (tagged.length === 0) continue;
    for (const call of tagged) {
      if (!TAG_ARGUMENT.test(call.args)) {
        problems.push(
          `${file.path}:${call.line}: ${call.name}(${call.args.trim()}) trebuie apelat cu \`{ tag }\` (altfel ar șterge și ce e al altor fișiere)`,
        );
      }
    }
    const declared = [...code.matchAll(TAG_DECLARATION)];
    const wellFormed = declared.filter((match) => {
      const bytes = Number(match[1]);
      return bytes >= 2 && bytes <= 6;
    });
    if (wellFormed.length !== 1) {
      problems.push(
        `${file.path}: apelează ${[...new Set(tagged.map((call) => call.name))].join(" și ")}, deci trebuie să declare exact un \`const tag = randomBytes(2..6).toString("hex")\` (găsite ${wellFormed.length})`,
      );
    }
  }
  return problems;
}

function listE2e(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listE2e(full, out);
    else if (name.endsWith(".ts")) {
      out.push({
        path: relative(root, full).replaceAll("\\", "/"),
        content: readFileSync(full, "utf8"),
      });
    }
  }
  return out;
}

const file = (path: string, content: string): SourceFile => ({ path, content });

const SPEC = [
  'import { randomBytes } from "node:crypto";',
  'import { removeE2eDemoPayments, removeE2eOrders } from "../packages/core/test/e2e-support";',
  'const tag = randomBytes(3).toString("hex");',
  "test.afterAll(async () => {",
  "  await removeE2eDemoPayments({ tag });",
  "  await removeE2eOrders({ tag });",
  "});",
].join("\n");

const SETUP = [
  "export default async function globalSetup() {",
  "  await removeAllE2eDemoPayments();",
  "  await removeAllE2eOrders();",
  "}",
].join("\n");

const TEARDOWN = SETUP.replace("globalSetup", "globalTeardown");

const GLOBALS = [file("e2e/global-setup.ts", SETUP), file("e2e/global-teardown.ts", TEARDOWN)];

/** Un spec care seedează integrarea DEMO: trebuie să-i șteargă starea în `afterAll` (`removeE2eDemoProvider`). */
const SEED_SPEC = [
  'import { randomBytes } from "node:crypto";',
  "import {",
  "  removeE2eDemoPayments,",
  "  removeE2eDemoProvider,",
  "  removeE2eOrders,",
  "  seedE2eDemoPayments,",
  '} from "../packages/core/test/e2e-support";',
  'const tag = randomBytes(3).toString("hex");',
  "test.beforeAll(async () => {",
  "  await seedE2eDemoPayments();",
  "});",
  "test.afterAll(async () => {",
  "  await removeE2eDemoProvider();",
  "  await removeE2eDemoPayments({ tag });",
  "  await removeE2eOrders({ tag });",
  "});",
].join("\n");

/** O stricare a unei reguli: ce se schimbă în text și ce trebuie să spună mesajul. */
interface Mutant {
  name: string;
  mutate: (content: string) => string;
  expects: string;
}

/** Mutanții aplicați unui SPEC (sintetic sau real): fiecare trebuie să producă o problemă. */
const SPEC_MUTANTS: readonly Mutant[] = [
  {
    name: "removeE2eOrders fără tag",
    mutate: (c) => c.replace("removeE2eOrders({ tag })", "removeE2eOrders()"),
    expects: "removeE2eOrders() trebuie apelat cu `{ tag }`",
  },
  {
    name: "removeE2eOrders cu alt obiect decât tag",
    mutate: (c) => c.replace("removeE2eOrders({ tag })", "removeE2eOrders({ tag: other })"),
    expects: "trebuie apelat cu `{ tag }`",
  },
  {
    name: "removeE2eOrders cu un tipar în loc de tag",
    mutate: (c) => c.replace("removeE2eOrders({ tag })", 'removeE2eOrders({ tag: "%" })'),
    expects: "trebuie apelat cu `{ tag }`",
  },
  {
    name: "removeE2eDemoPayments fără tag",
    mutate: (c) => c.replace("removeE2eDemoPayments({ tag })", "removeE2eDemoPayments()"),
    expects: "removeE2eDemoPayments() trebuie apelat cu `{ tag }`",
  },
  {
    name: "ștergere globală a comenzilor într-un spec",
    mutate: (c) => c.replace("removeE2eOrders({ tag })", "removeAllE2eOrders()"),
    expects: "`removeAllE2eOrders` e curățare GLOBALĂ",
  },
  {
    name: "ștergere globală a plăților DEMO într-un spec",
    mutate: (c) => c.replace("removeE2eDemoPayments({ tag })", "removeAllE2eDemoPayments()"),
    expects: "`removeAllE2eDemoPayments` e curățare GLOBALĂ",
  },
  {
    name: "ștergere globală doar importată",
    mutate: (c) => `import { removeAllE2eOrders } from "../packages/core/test/e2e-support";\n${c}`,
    expects: "`removeAllE2eOrders` e curățare GLOBALĂ",
  },
  {
    name: "tag fix (literal) în loc de randomBytes",
    mutate: (c) =>
      c.replace(/const tag = randomBytes\(\d+\)\.toString\("hex"\);/, 'const tag = "abc123";'),
    expects: "tag fix («abc123»)",
  },
  {
    name: "tag nedeclarat în fișier",
    mutate: (c) => c.replace(/^\s*const tag = randomBytes\(\d+\)\.toString\("hex"\);$/m, ""),
    expects: "trebuie să declare exact un `const tag",
  },
  {
    name: "tag declarat de două ori",
    mutate: (c) => `${c}\nconst tag2 = 1;\nconst tag = randomBytes(3).toString("hex");`,
    expects: "găsite 2",
  },
  {
    name: "tag prea scurt (un singur octet)",
    mutate: (c) => c.replace("randomBytes(3)", "randomBytes(1)"),
    expects: "găsite 0",
  },
];

const PROVIDER_CALL = /^[ \t]*await removeE2eDemoProvider\(\);\r?\n/m;
const PROVIDER_MISSING = "seedează integrarea DEMO";

/** Mutanți ai regulii «cine seedează DEMO îi șterge starea în afterAll»: aplicați specurilor care seedează. */
const PROVIDER_MUTANTS: readonly Mutant[] = [
  {
    name: "fără ștergerea stării DEMO",
    mutate: (c) => c.replace(PROVIDER_CALL, ""),
    expects: PROVIDER_MISSING,
  },
  {
    name: "ștergerea stării DEMO mutată din afterAll în beforeAll",
    mutate: (c) =>
      c
        .replace(PROVIDER_CALL, "")
        .replace(/(test\.beforeAll\([^\n]*\{\r?\n)/, "$1  await removeE2eDemoProvider();\n"),
    expects: PROVIDER_MISSING,
  },
  {
    name: "ștergerea stării DEMO doar într-un comentariu",
    mutate: (c) => c.replace(PROVIDER_CALL, "  // await removeE2eDemoProvider();\n"),
    expects: PROVIDER_MISSING,
  },
  {
    name: "ștergerea stării DEMO înlocuită cu cea globală",
    mutate: (c) => c.replace("removeE2eDemoProvider();", "removeAllE2eDemoPayments();"),
    expects: "`removeAllE2eDemoPayments` e curățare GLOBALĂ",
  },
];

/** Elimină liniile care apelează `name(`. */
const dropCalls = (content: string, name: string): string =>
  content
    .split("\n")
    .filter((line) => !line.includes(`${name}(`))
    .join("\n");

/** Mută linia care apelează `first(` DUPĂ cea care apelează `second(`. */
function swapCalls(content: string, first: string, second: string): string {
  const lines = content.split("\n");
  const from = lines.findIndex((line) => line.includes(`${first}(`));
  const to = lines.findIndex((line) => line.includes(`${second}(`));
  if (from < 0 || to < 0) return content;
  const [moved] = lines.splice(from, 1);
  lines.splice(from < to ? to : to + 1, 0, moved as string);
  return lines.join("\n");
}

/** Mutanți ai fișierelor globale (aplicați fiecăruia, setup și teardown): lipsa curățării sau ordinea greșită. */
const GLOBAL_MUTANTS: readonly Mutant[] = [
  {
    name: "fără ștergerea comenzilor",
    mutate: (c) => dropCalls(c, "removeAllE2eOrders"),
    expects: "lipsește curățarea globală `removeAllE2eOrders()`",
  },
  {
    name: "fără ștergerea plăților",
    mutate: (c) => dropCalls(c, "removeAllE2eDemoPayments"),
    expects: "lipsește curățarea globală `removeAllE2eDemoPayments()`",
  },
  {
    name: "comenzile înaintea plăților",
    mutate: (c) => swapCalls(c, "removeAllE2eDemoPayments", "removeAllE2eOrders"),
    expects: "ÎNAINTE de `removeAllE2eOrders`",
  },
];

describe("curățarea comenzilor în specurile E2E (cazuri sintetice)", () => {
  it("acceptă un spec corect și fișierele globale corecte; ignoră apelurile din comentarii", () => {
    expect(findOrdersCleanupViolations([file("e2e/a.spec.ts", SPEC), ...GLOBALS])).toEqual([]);
    const commented = `// removeAllE2eOrders() ar fi greșit aici\n/* removeE2eOrders() */\n${SPEC}`;
    expect(findOrdersCleanupViolations([file("e2e/a.spec.ts", commented), ...GLOBALS])).toEqual([]);
  });

  it("acceptă `{ tag: tag }`, un apel multi-linie (prettier) și un fișier fără apeluri de curățare", () => {
    const explicit = SPEC.replace("({ tag })", "({ tag: tag })");
    expect(findOrdersCleanupViolations([file("e2e/a.spec.ts", explicit), ...GLOBALS])).toEqual([]);
    const multiline = SPEC.replace("removeE2eOrders({ tag })", "removeE2eOrders({\n    tag,\n  })");
    expect(findOrdersCleanupViolations([file("e2e/a.spec.ts", multiline), ...GLOBALS])).toEqual([]);
    expect(
      findOrdersCleanupViolations([file("e2e/b.spec.ts", "test('x', () => {});"), ...GLOBALS]),
    ).toEqual([]);
  });

  it("două fișiere cu tag-uri aleatorii diferite sunt în regulă; același tag fix în două fișiere se prinde de două ori", () => {
    expect(
      findOrdersCleanupViolations([
        file("e2e/a.spec.ts", SPEC),
        file("e2e/b.spec.ts", SPEC),
        ...GLOBALS,
      ]),
    ).toEqual([]);
    const fixed = SPEC.replace(
      /const tag = randomBytes\(3\)\.toString\("hex"\);/,
      'const tag = "abc123";',
    );
    const problems = findOrdersCleanupViolations([
      file("e2e/a.spec.ts", fixed),
      file("e2e/b.spec.ts", fixed),
      ...GLOBALS,
    ]);
    expect(problems.join("\n")).toContain(
      "e2e/b.spec.ts: tag-ul fix «abc123» e folosit și de e2e/a.spec.ts",
    );
  });

  it("un spec care seedează DEMO și îi șterge starea în afterAll e corect; fără seed nu se cere ștergerea", () => {
    expect(findOrdersCleanupViolations([file("e2e/a.spec.ts", SEED_SPEC), ...GLOBALS])).toEqual([]);
    expect(findOrdersCleanupViolations([file("e2e/a.spec.ts", SPEC), ...GLOBALS])).toEqual([]);
  });

  it("starea DEMO e ștearsă DOAR printr-un apel real, în afterAll (nu în comentariu, nu în beforeAll)", () => {
    const withBoth = SEED_SPEC.replace(
      "  await seedE2eDemoPayments();",
      "  await seedE2eDemoPayments('manual_required');",
    );
    expect(findOrdersCleanupViolations([file("e2e/a.spec.ts", withBoth), ...GLOBALS])).toEqual([]);
  });

  it.each(PROVIDER_MUTANTS)("mutant (spec sintetic cu seed): $name", ({ mutate, expects }) => {
    const mutated = mutate(SEED_SPEC);
    expect(mutated).not.toBe(SEED_SPEC);
    const problems = findOrdersCleanupViolations([file("e2e/a.spec.ts", mutated), ...GLOBALS]);
    expect(problems.join("\n")).toContain(expects);
  });

  it.each(SPEC_MUTANTS)("mutant: $name", ({ mutate, expects }) => {
    const mutated = mutate(SPEC);
    expect(mutated).not.toBe(SPEC);
    const problems = findOrdersCleanupViolations([file("e2e/a.spec.ts", mutated), ...GLOBALS]);
    expect(problems.join("\n")).toContain(expects);
  });

  for (const path of ["e2e/global-setup.ts", "e2e/global-teardown.ts"]) {
    it.each(GLOBAL_MUTANTS)(`mutant pe ${path}: $name`, ({ mutate, expects }) => {
      const files = GLOBALS.map((entry) =>
        entry.path === path ? file(entry.path, mutate(entry.content)) : entry,
      );
      expect(files.map((entry) => entry.content)).not.toEqual(
        GLOBALS.map((entry) => entry.content),
      );
      const problems = findOrdersCleanupViolations([file("e2e/a.spec.ts", SPEC), ...files]);
      expect(problems.join("\n")).toContain(expects);
    });
  }
});

describe("specurile E2E reale", () => {
  const files = listE2e(join(root, "e2e"));
  const real = (name: string): SourceFile => {
    const found = files.find((entry) => entry.path === `e2e/${name}`);
    if (!found) throw new Error(`e2e/${name} lipsește`);
    return found;
  };

  it("niciun spec nu apelează o ștergere globală, fiecare apel pe tag primește { tag }, iar global-setup/teardown fac curățarea globală", () => {
    expect(findOrdersCleanupViolations(files)).toEqual([]);
  });

  it("plasă de siguranță: apelanții cunoscuți chiar apelează curățarea pe tag (garda nu trece pe gol)", () => {
    const callers = files.filter((entry) =>
      /\bremoveE2eOrders\(/.test(stripComments(entry.content)),
    );
    expect(callers.map((entry) => entry.path).sort()).toEqual(
      [
        "e2e/account.spec.ts",
        "e2e/card-payments.spec.ts",
        "e2e/checkout-pickup.spec.ts",
        "e2e/checkout.spec.ts",
        "e2e/digital.spec.ts",
        "e2e/faza10-capturi.spec.ts",
        "e2e/faza11-capturi.spec.ts",
        "e2e/faza13-capturi.spec.ts",
        "e2e/faza9-capturi.spec.ts",
        "e2e/invoicing.spec.ts",
        "e2e/orders-offers.spec.ts",
        "e2e/payments-admin.spec.ts",
        "e2e/ridicare-capturi.spec.ts",
        "e2e/shipping.spec.ts",
      ].sort(),
    );
    const withPayments = files.filter((entry) =>
      /\bremoveE2eDemoPayments\(/.test(stripComments(entry.content)),
    );
    expect(withPayments.length).toBeGreaterThanOrEqual(5);
  });

  const MUTATED_SPECS = ["card-payments.spec.ts", "payments-admin.spec.ts", "checkout.spec.ts"];
  for (const spec of MUTATED_SPECS) {
    const content = files.find((entry) => entry.path === `e2e/${spec}`)?.content ?? "";
    for (const mutant of SPEC_MUTANTS) {
      // mutantul trebuie să aibă ce strica în fișierul real (altfel nu ar dovedi nimic)
      const mutated = mutant.mutate(content);
      if (mutated === content) continue;
      it(`mutant pe ${spec}: ${mutant.name}`, () => {
        const others = files.filter((entry) => entry.path !== `e2e/${spec}`);
        const problems = findOrdersCleanupViolations([file(`e2e/${spec}`, mutated), ...others]);
        expect(problems.join("\n")).toContain(mutant.expects);
      });
    }
  }

  const SEEDING_SPECS = [
    "card-payments.spec.ts",
    "faza10-capturi.spec.ts",
    "faza11-capturi.spec.ts",
    "orders-offers.spec.ts",
    "payments-admin.spec.ts",
  ];

  it("exact specurile cunoscute seedează DEMO, iar fiecare apelează removeE2eDemoProvider() în afterAll (garda nu trece pe gol)", () => {
    const seeding = files.filter((entry) =>
      /\bseedE2eDemoPayments\(/.test(stripComments(entry.content)),
    );
    expect(seeding.map((entry) => entry.path).sort()).toEqual(
      SEEDING_SPECS.map((name) => `e2e/${name}`).sort(),
    );
    for (const entry of seeding) {
      expect(afterAllCalls(stripComments(entry.content), "removeE2eDemoProvider"), entry.path).toBe(
        true,
      );
    }
  });

  for (const spec of SEEDING_SPECS) {
    for (const mutant of PROVIDER_MUTANTS) {
      it(`mutant pe ${spec} real: ${mutant.name}`, () => {
        const original = real(spec).content;
        const mutated = mutant.mutate(original);
        expect(mutated).not.toBe(original);
        const others = files.filter((entry) => entry.path !== `e2e/${spec}`);
        const problems = findOrdersCleanupViolations([file(`e2e/${spec}`, mutated), ...others]);
        expect(problems.join("\n")).toContain(mutant.expects);
      });
    }
  }

  it("mutanții se aplică într-adevăr pe specurile reale (cel puțin zece combinații)", () => {
    let applied = 0;
    for (const spec of MUTATED_SPECS) {
      const content = real(spec).content;
      for (const mutant of SPEC_MUTANTS) if (mutant.mutate(content) !== content) applied += 1;
    }
    expect(applied).toBeGreaterThanOrEqual(10);
  });

  for (const path of ["e2e/global-setup.ts", "e2e/global-teardown.ts"]) {
    for (const mutant of GLOBAL_MUTANTS) {
      it(`mutant pe ${path} real: ${mutant.name}`, () => {
        const original = real(path.replace("e2e/", ""));
        const mutated = mutant.mutate(original.content);
        expect(mutated).not.toBe(original.content);
        const rewritten = files.map((entry) =>
          entry.path === path ? file(entry.path, mutated) : entry,
        );
        expect(findOrdersCleanupViolations(rewritten).join("\n")).toContain(mutant.expects);
      });
    }
  }
});
