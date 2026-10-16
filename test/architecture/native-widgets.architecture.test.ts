import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură: fără widget-uri native ale browserului care vorbesc în limba browserului (nu în
 * română) în codul aplicației. Pică dacă apare:
 *  - `window.confirm` / `window.alert` / `window.prompt` (sau apel gol `alert(…)`, `prompt(…)`,
 *    `confirm(…)` către funcția globală): se folosește un dialog propriu al aplicației (`Dialog` din
 *    `@ecom/ui`), cu texte din mesaje. `beforeunload` rămâne (îl controlează browserul);
 *  - un `<form>` FĂRĂ `noValidate` care conține validare nativă (`required`, `pattern`,
 *    `type="email"`, `type="url"`): baloanele de validare ies în limba browserului. Formularele au
 *    `noValidate` și mesaje proprii în română.
 *
 * Citește sursa ca text; `findNativeWidgetViolations` e pură și testată pe fișiere sintetice.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const isTest = (path: string): boolean =>
  /\.(test|spec)\.(ts|tsx)$/.test(path) || path.includes("/test/") || path.startsWith("e2e/");

/** Elimină comentariile (documentația poate numi `window.confirm`). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Sfârșitul tag-ului de deschidere care începe la `start` (`<form`): primul `>` din afara `{…}` și a șirurilor. */
function openingTagEnd(source: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i] ?? "";
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth <= 0) return i;
  }
  return source.length;
}

const NATIVE_VALIDATION: readonly [RegExp, string][] = [
  [/(^|\s)required(?=[\s=/>]|$)/, "required"],
  [/(^|\s)pattern\s*=/, "pattern"],
  [/(^|\s)type\s*=\s*["']?\{?["']?(email|url)\b/, 'type="email"/"url"'],
];

const GLOBAL_DIALOGS = ["confirm", "alert", "prompt"] as const;

export function findNativeWidgetViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (isTest(file.path)) continue;
    const code = stripComments(file.content);

    for (const name of GLOBAL_DIALOGS) {
      const viaWindow = new RegExp(`\\b(?:window|globalThis|self)\\s*\\.\\s*${name}\\s*\\(`);
      const bare = new RegExp(`(?<![.\\w$])${name}\\s*\\(`);
      const declared = new RegExp(`\\b(?:function|const|let|var)\\s+${name}\\b`);
      if (viaWindow.test(code) || (bare.test(code) && !declared.test(code))) {
        problems.push(
          `${file.path}: window.${name} nativ; folosește un dialog propriu (Dialog din @ecom/ui)`,
        );
      }
    }

    let from = 0;
    for (;;) {
      const at = code.indexOf("<form", from);
      if (at < 0) break;
      from = at + 5;
      // `<formular>` și alte nume care încep cu «form» nu sunt tag-ul HTML
      if (/[A-Za-z0-9_-]/.test(code[at + 5] ?? "")) continue;
      const tagEnd = openingTagEnd(code, at);
      const tag = code.slice(at, tagEnd + 1);
      if (/(^|\s)noValidate(?=[\s=/>]|$)/.test(tag)) continue;
      const closing = code.indexOf("</form>", tagEnd);
      const body = code.slice(tagEnd + 1, closing < 0 ? code.length : closing);
      const found = NATIVE_VALIDATION.filter(([pattern]) => pattern.test(body)).map(
        ([, label]) => label,
      );
      if (found.length > 0) {
        problems.push(
          `${file.path}: <form> fără noValidate cu validare nativă (${found.join(", ")}); ` +
            "adaugă noValidate și mesaje proprii în română",
        );
      }
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
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(full);
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

describe("fără widget-uri native în afara limbii aplicației (sursa reală)", () => {
  const files = loadSource();

  it("scanează codul real (nu trece în gol) și găsește formularele existente", () => {
    expect(files.length).toBeGreaterThan(100);
    const forms = files.filter((f) => f.content.includes("<form")).length;
    expect(forms).toBeGreaterThan(15);
  });

  it("nicio fereastră nativă (confirm/alert/prompt) și niciun formular cu validare nativă", () => {
    expect(findNativeWidgetViolations(files)).toEqual([]);
  });

  it("dialogul propriu pentru modificări nesalvate există (înlocuiește window.confirm)", () => {
    const unsaved = files.find(
      (f) => f.path === "apps/web/src/components/admin/products/unsaved-changes.tsx",
    );
    expect(unsaved).toBeDefined();
    expect(unsaved?.content).toMatch(/<Dialog\b/);
    expect(unsaved?.content).toMatch(/beforeunload/);
  });
});

describe("findNativeWidgetViolations pe fișiere sintetice (testul pică când trebuie)", () => {
  const at = (content: string, path = "apps/web/src/components/x.tsx"): string[] =>
    findNativeWidgetViolations([{ path, content }]);

  it("prinde window.confirm / alert / prompt și apelurile goale către funcțiile globale", () => {
    expect(at(`if (!window.confirm("Sigur?")) return;`)).toHaveLength(1);
    expect(at(`window.alert("gata");`)).toHaveLength(1);
    expect(at(`const v = window.prompt("nume");`)).toHaveLength(1);
    expect(at(`globalThis.confirm("x");`)).toHaveLength(1);
    expect(at(`if (confirm("Sigur?")) go();`)).toHaveLength(1);
    expect(at(`alert("x")`)).toHaveLength(1);
  });

  it("prinde un <form> fără noValidate cu required, pattern, type=email sau url", () => {
    const form = (attrs: string, extra = ""): string =>
      `<form onSubmit={(e) => { e.preventDefault(); }}${extra}><input ${attrs} /></form>`;
    expect(at(form("required"))).toHaveLength(1);
    expect(at(form('name="a" required'))).toHaveLength(1);
    expect(at(form("required={true}"))).toHaveLength(1);
    expect(at(form('pattern="[0-9]+"'))).toHaveLength(1);
    expect(at(form('type="email"'))).toHaveLength(1);
    expect(at(form('type="url"'))).toHaveLength(1);
    // formular pe mai multe linii, cu săgeată în atribute
    expect(
      at(
        `<form\n  className="a"\n  onSubmit={(event) => {\n    event.preventDefault();\n  }}\n>\n  <Input required />\n</form>`,
      ),
    ).toHaveLength(1);
  });

  it("nu dă fals pozitive", () => {
    // cu noValidate (pe aceeași linie sau pe alta), cu required în atribute
    expect(
      at(`<form onSubmit={s} noValidate className="x"><input required type="email" /></form>`),
    ).toEqual([]);
    expect(
      at(
        `<form\n  className="x"\n  noValidate\n  onSubmit={(e) => s(e)}\n>\n<Input required />\n</form>`,
      ),
    ).toEqual([]);
    // formular fără câmpuri cu validare nativă
    expect(at(`<form onSubmit={s}><input type="text" name="q" /></form>`)).toEqual([]);
    // required în afara formularului, funcții locale numite confirm, comentarii, teste, texte
    expect(at(`<div><Input required /></div>`)).toEqual([]);
    expect(at(`async function confirm(t: string) {}\nonClick={() => void confirm(token)}`)).toEqual(
      [],
    );
    expect(at(`// nu folosi window.confirm\n/* window.alert("x") */\nconst a = 1;`)).toEqual([]);
    expect(at(`window.confirm("x")`, "apps/web/src/a.test.tsx")).toEqual([]);
    expect(at(`<p>{m.mapping.required}</p>`)).toEqual([]);
    expect(at(`m.picker.confirm(selected.length)`)).toEqual([]);
    expect(at(`<form noValidate><input required /></form><form><input name="q" /></form>`)).toEqual(
      [],
    );
  });
});
