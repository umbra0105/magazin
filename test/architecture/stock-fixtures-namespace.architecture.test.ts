import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Fișierele de teste cu date COMISE de stoc au fiecare spațiul lor de nume (15e, incidentul #2).
 *
 * `purgeStockLeftovers` era o curățare GLOBALĂ (toate produsele `st-…`, depozitele `w_…`, unitățile `u_…`), apelată la
 * începutul și la finalul a 8 fișiere. Rulate în paralel de workeri diferiți, curățarea unuia ștergea datele aflate în lucru ale
 * altuia (încălcare de cheie străină la `inventoryItem.create` / `warehouse.deleteMany`, eșecuri false). Acum
 * `purgeStockLeftovers(db, namespace)` șterge doar prefixul dat, deci regula este: orice fișier care o apelează declară UN
 * singur `const STOCK_NAMESPACE = "…"`, îl trece la fiecare curățare și la fiecare `createStockContext`, iar două fișiere nu
 * împart același spațiu. Fișierele proprii ale fixture-ului (`test-utils/`) simulează două spații și sunt scutite.
 *
 * Citește sursa ca text; `findNamespaceViolations` e pură și testată pe fișiere sintetice.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const EXEMPT = /(^|\/)test-utils\//;
const DECLARATION = /^const STOCK_NAMESPACE = "([a-z]{2,12})";$/gm;

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
    const open = match.index + name.length;
    found.push({
      args: callArguments(content, open),
      line: content.slice(0, match.index).split("\n").length,
    });
  }
  return found;
}

export function findNamespaceViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  const owners = new Map<string, string>();
  for (const file of files) {
    if (EXEMPT.test(file.path)) continue;
    // apelurile din comentarii nu contează: se caută doar în cod
    const code = file.content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const purges = calls(code, "purgeStockLeftovers");
    if (purges.length === 0) continue;
    const declared = [...code.matchAll(DECLARATION)].map((m) => m[1] as string);
    if (declared.length !== 1) {
      problems.push(
        `${file.path}: trebuie să declare exact un \`const STOCK_NAMESPACE = "<2–12 litere mici>";\` (găsite ${declared.length})`,
      );
      continue;
    }
    const namespace = declared[0] as string;
    const owner = owners.get(namespace);
    if (owner) {
      problems.push(`${file.path}: spațiul de nume «${namespace}» e folosit și de ${owner}`);
    } else {
      owners.set(namespace, file.path);
    }
    for (const call of purges) {
      if (!/^\s*[\w.]+\s*,\s*STOCK_NAMESPACE\s*,?\s*$/.test(call.args)) {
        problems.push(
          `${file.path}:${call.line}: purgeStockLeftovers trebuie apelat cu STOCK_NAMESPACE (curățarea ar fi globală)`,
        );
      }
    }
    for (const call of calls(code, "createStockContext")) {
      if (!/\bnamespace\s*:\s*STOCK_NAMESPACE\b/.test(call.args)) {
        problems.push(
          `${file.path}:${call.line}: createStockContext fără \`namespace: STOCK_NAMESPACE\` (datele lui nu ar fi curățate de fișierul lui)`,
        );
      }
    }
  }
  return problems;
}

function listTests(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listTests(full, out);
    else if (name.endsWith(".test.ts")) {
      out.push({
        path: relative(root, full).replaceAll("\\", "/"),
        content: readFileSync(full, "utf8"),
      });
    }
  }
  return out;
}

const file = (path: string, content: string): SourceFile => ({ path, content });
const GOOD = (ns: string): string =>
  [
    `const STOCK_NAMESPACE = "${ns}";`,
    "beforeAll(async () => { await purgeStockLeftovers(db, STOCK_NAMESPACE); });",
    "const ctx = await createStockContext(db, { namespace: STOCK_NAMESPACE });",
  ].join("\n");

describe("spațiile de nume ale fixture-urilor de stoc (cazuri sintetice)", () => {
  it("acceptă fișiere corecte, cu spații diferite", () => {
    expect(
      findNamespaceViolations([file("a.test.ts", GOOD("aaa")), file("b.test.ts", GOOD("bbb"))]),
    ).toEqual([]);
  });

  it("prinde curățarea globală (un singur argument)", () => {
    const content = GOOD("aaa").replace(
      "purgeStockLeftovers(db, STOCK_NAMESPACE)",
      "purgeStockLeftovers(db)",
    );
    expect(findNamespaceViolations([file("a.test.ts", content)]).join("\n")).toContain(
      "curățarea ar fi globală",
    );
  });

  it("prinde un spațiu de nume dat ca literal sau ca alt nume în loc de STOCK_NAMESPACE", () => {
    const literal = GOOD("aaa").replace(
      "purgeStockLeftovers(db, STOCK_NAMESPACE)",
      'purgeStockLeftovers(db, "aaa")',
    );
    expect(findNamespaceViolations([file("a.test.ts", literal)])).toHaveLength(1);
  });

  it("prinde createStockContext fără spațiu de nume", () => {
    const content = GOOD("aaa").replace("{ namespace: STOCK_NAMESPACE }", "{}");
    expect(findNamespaceViolations([file("a.test.ts", content)]).join("\n")).toContain(
      "createStockContext fără",
    );
    const bare = GOOD("aaa").replace(
      "createStockContext(db, { namespace: STOCK_NAMESPACE })",
      "createStockContext(db)",
    );
    expect(findNamespaceViolations([file("a.test.ts", bare)])).toHaveLength(1);
  });

  it("prinde lipsa declarației, declarația dublă și o valoare invalidă", () => {
    const none = GOOD("aaa").replace(/^const STOCK_NAMESPACE.*\n/m, "");
    expect(findNamespaceViolations([file("a.test.ts", none)]).join("\n")).toContain("găsite 0");
    const twice = `${GOOD("aaa")}\nconst STOCK_NAMESPACE = "bbb";`;
    expect(findNamespaceViolations([file("a.test.ts", twice)]).join("\n")).toContain("găsite 2");
    const invalid = GOOD("aaa").replace('"aaa"', '"Aaa_1"');
    expect(findNamespaceViolations([file("a.test.ts", invalid)]).join("\n")).toContain("găsite 0");
  });

  it("prinde două fișiere cu același spațiu de nume", () => {
    const problems = findNamespaceViolations([
      file("a.test.ts", GOOD("aaa")),
      file("b.test.ts", GOOD("aaa")),
    ]);
    expect(problems.join("\n")).toContain("e folosit și de a.test.ts");
  });

  it("ignoră apelurile din comentarii și fișierele fără curățare; scutește fișierele din test-utils/", () => {
    const comment =
      "// vezi purgeStockLeftovers(db) înainte\n/* purgeStockLeftovers(db) */\nconst x = 1;";
    expect(findNamespaceViolations([file("a.test.ts", comment)])).toEqual([]);
    expect(
      findNamespaceViolations([
        file("packages/core/src/test-utils/x.test.ts", "purgeStockLeftovers(db, A)"),
      ]),
    ).toEqual([]);
  });

  it("apelul multi-linie (prettier) se citește întreg", () => {
    const content = GOOD("aaa").replace(
      "purgeStockLeftovers(db, STOCK_NAMESPACE)",
      "purgeStockLeftovers(\n    db,\n    STOCK_NAMESPACE,\n  )",
    );
    expect(findNamespaceViolations([file("a.test.ts", content)])).toEqual([]);
  });
});

describe("testele reale", () => {
  it("fiecare fișier cu date comise de stoc are spațiul lui de nume, folosit la creare și la curățare", () => {
    const files = [join(root, "packages")].flatMap((dir) => listTests(dir));
    expect(findNamespaceViolations(files)).toEqual([]);
    // plasă de siguranță: cele 8 fișiere de concurență cunoscute chiar apelează curățarea
    const callers = files.filter(
      (f) => !EXEMPT.test(f.path) && /\bpurgeStockLeftovers\(/.test(f.content),
    );
    expect(callers.length).toBeGreaterThanOrEqual(8);
  });
});
