import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Fragmente SQL în șabloane etichetate (mini-faza `prisma-join-tema`). Citește sursa ca text.
 *
 * Problema, dovedită pe build-ul de producție al aplicației web: în pachetul Next există mai multe copii ale runtime-ului Prisma,
 * iar un șablon ETICHETAT (`db.$queryRaw` urmat de un șablon, la fel `$executeRaw`) în care se interpolează un fragment SQL
 * (`Prisma.join`, `Prisma.sql`, `Prisma.empty`, `Prisma.raw` sau o funcție care întoarce `Prisma.Sql`) NU recunoaște fragmentul:
 * îl trimite ca parametru. Interogarea nu dă eroare (sau dă o eroare de sintaxă), dar nu găsește rândurile: blocarea coșurilor
 * (`FOR UPDATE`) nu bloca nimic. Testele unitare și de integrare, rulate în Node fără pachetul Next, NU văd diferența.
 *
 * Regula: într-un șablon etichetat se interpolează doar VALORI (parametri; pentru liste, `= ANY(${tablou}::tip[])`). Un fragment SQL
 * se compune cu `Prisma.sql`, iar interogarea se trimite ca `$queryRaw(Prisma.sql...)` (formă dovedită în producție, cu
 * `Prisma.join` și fragmente imbricate). Aceste forme sunt permise.
 *
 * Funcțiile `find*` sunt pure și testate pe fișiere sintetice, ca testul să nu poată trece «în gol».
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const RAW_TAGS = new Set(["$queryRaw", "$executeRaw"]);
const FRAGMENT_PRODUCERS = /\bPrisma\.(sql|join|raw|empty)\b/;
const isTestFile = (path: string): boolean => /\.(test|spec)\.tsx?$/.test(path);

function parse(file: SourceFile): ts.SourceFile {
  return ts.createSourceFile(
    file.path,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

const typeIsSql = (node: ts.TypeNode | undefined): boolean =>
  node !== undefined && /\bPrisma\.Sql\b/.test(node.getText());

interface FragmentNames {
  /** Funcții din tot codul care întorc `Prisma.Sql` (se pot importa în orice fișier). */
  functions: Set<string>;
  /** Variabile cu un fragment SQL, pe fiecare fișier (numele variabilelor nu trec dintr-un fișier în altul). */
  variables: Map<string, Set<string>>;
}

export function collectFragmentNames(files: readonly SourceFile[]): FragmentNames {
  const functions = new Set<string>();
  const variables = new Map<string, Set<string>>();
  for (const file of files) {
    // doar fișierele care pomenesc `Prisma.` pot defini fragmente SQL (parsarea întregului cod ar fi lentă)
    if (isTestFile(file.path) || !file.content.includes("Prisma.")) continue;
    const own = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && typeIsSql(node.type)) {
        functions.add(node.name.text);
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const init = node.initializer;
        const isFunction =
          init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        if (isFunction && typeIsSql(init.type)) functions.add(node.name.text);
        else if (
          !isFunction &&
          (typeIsSql(node.type) || (init && FRAGMENT_PRODUCERS.test(init.getText())))
        )
          own.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file));
    variables.set(file.path, own);
  }
  return { functions, variables };
}

function tagName(tag: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(tag)) return tag.name.text;
  if (ts.isIdentifier(tag)) return tag.text;
  return null;
}

function mentionsAny(expression: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false;
  const scan = (inner: ts.Node): void => {
    if (ts.isIdentifier(inner) && names.has(inner.text)) found = true;
    ts.forEachChild(inner, scan);
  };
  scan(expression);
  return found;
}

export function findTaggedFragmentViolations(
  files: readonly SourceFile[],
  fragmentNames: FragmentNames = collectFragmentNames(files),
): string[] {
  const problems: string[] = [];
  for (const file of files) {
    // doar fișierele cu un `$queryRaw`/`$executeRaw` pot avea șabloane etichetate de verificat
    if (isTestFile(file.path) || !/\$(queryRaw|executeRaw)\b/.test(file.content)) continue;
    const source = parse(file);
    const names = new Set([
      ...fragmentNames.functions,
      ...(fragmentNames.variables.get(file.path) ?? []),
    ]);
    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node)) {
        const name = tagName(node.tag);
        if (name !== null && RAW_TAGS.has(name) && ts.isTemplateExpression(node.template)) {
          for (const span of node.template.templateSpans) {
            const text = span.expression.getText();
            if (FRAGMENT_PRODUCERS.test(text) || mentionsAny(span.expression, names)) {
              const { line } = source.getLineAndCharacterOfPosition(span.getStart());
              problems.push(
                `${file.path}:${line + 1}: fragment SQL («${text.replace(/\s+/g, " ").slice(0, 60)}») într-un șablon etichetat ${name}: în build-ul de producție nu e recunoscut (folosește un parametru, de ex. = ANY(tablou::text[]), sau $queryRaw(Prisma.sql...))`,
              );
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return problems;
}

const SKIP = new Set(["node_modules", "generated", ".next", ".turbo", "dist", "coverage"]);
const SOURCE = /\.(ts|tsx|mts)$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".next")) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (SOURCE.test(name)) out.push(full);
  }
}

function loadSource(): SourceFile[] {
  const roots = [join(root, "apps", "web", "src")];
  for (const pkg of readdirSync(join(root, "packages"))) {
    const src = join(root, "packages", pkg, "src");
    try {
      if (statSync(src).isDirectory()) roots.push(src);
    } catch {
      // pachet fără `src`
    }
  }
  const paths: string[] = [];
  for (const dir of roots) walk(dir, paths);
  return paths.map((full) => ({
    path: relative(root, full).split(sep).join("/"),
    content: readFileSync(full, "utf8"),
  }));
}

describe("fragmente SQL în șabloane etichetate (sursa reală)", () => {
  const files = loadSource();

  it(
    "scanează codul real: blocarea coșului și fragmentele cunoscute există",
    { timeout: 60_000 },
    () => {
      expect(files.length).toBeGreaterThan(300);
      const { functions } = collectFragmentNames(files);
      for (const known of ["tupleList", "joinAnd", "searchCondition", "scopeConditions"]) {
        expect(functions.has(known), known).toBe(true);
      }
      const cart = files.find((f) => f.path === "packages/core/src/cart/cart-service.ts");
      expect(cart?.content).toContain("FOR UPDATE");
    },
  );

  it("niciun șablon etichetat `$queryRaw`/`$executeRaw` nu interpolează un fragment SQL", () => {
    expect(findTaggedFragmentViolations(files)).toEqual([]);
  }, 60_000);
});

describe("gărzile pe fișiere sintetice (testul pică când trebuie)", () => {
  const f = (path: string, content: string): SourceFile => ({ path, content });
  const violations = (...files: SourceFile[]): string[] => findTaggedFragmentViolations(files);

  it("prinde `Prisma.join` într-un `$queryRaw` etichetat (forma blocării vechi a coșului)", () => {
    const found = violations(
      f(
        "a.ts",
        "export const lock = (tx: Db, ids: string[]) => tx.$queryRaw`SELECT id FROM cart WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`;",
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("a.ts:1");
  });

  it("prinde `$executeRaw` etichetat, `Prisma.sql`, `Prisma.empty`, `Prisma.raw` și `Prisma.join`", () => {
    for (const fragment of [
      "Prisma.sql`x = 1`",
      "Prisma.empty",
      "Prisma.raw('x')",
      "Prisma.join(a)",
    ]) {
      expect(
        violations(f("a.ts", `await db.$executeRaw\`UPDATE t SET a = 1 \${${fragment}}\`;`)),
        fragment,
      ).toHaveLength(1);
    }
  });

  it("prinde o funcție sau o variabilă care e fragment SQL, definită în alt fișier sau în același", () => {
    const helper = f(
      "helper.ts",
      "export function tuples(keys: string[]): Prisma.Sql { return Prisma.join(keys); }\nexport const both = (p: Prisma.Sql[]): Prisma.Sql => Prisma.join(p, ' AND ');",
    );
    expect(
      violations(helper, f("b.ts", "await db.$queryRaw`SELECT 1 WHERE ${tuples(k)}`;")),
    ).toHaveLength(1);
    expect(
      violations(helper, f("c.ts", "await db.$queryRaw`SELECT 1 WHERE ${both(parts)}`;")),
    ).toHaveLength(1);
    expect(
      violations(
        f("d.ts", "const cond = Prisma.sql`x = 1`;\nawait db.$queryRaw`SELECT 1 WHERE ${cond}`;"),
      ),
    ).toHaveLength(1);
  });

  it("lasă formele dovedite: parametri, `ANY(tablou)` și `$queryRaw(Prisma.sql...)` cu fragmente", () => {
    expect(
      violations(
        f(
          "ok.ts",
          [
            "await tx.$queryRaw`SELECT id FROM cart WHERE id = ANY(${ids}::text[]) FOR UPDATE`;",
            "await tx.$queryRaw`SELECT 1 WHERE a = ${value} AND b = ${row.id}`;",
            "await db.$queryRaw(Prisma.sql`SELECT 1 WHERE x IN (${Prisma.join(ids)})`);",
            "await db.$executeRaw(Prisma.sql`UPDATE t SET a = 1 ${Prisma.empty}`);",
          ].join("\n"),
        ),
      ),
    ).toEqual([]);
  });

  it("ignoră fișierele de test", () => {
    expect(violations(f("x.test.ts", "await db.$queryRaw`SELECT ${Prisma.join(ids)}`;"))).toEqual(
      [],
    );
  });
});
