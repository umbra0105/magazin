import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Paginile-harness ale testelor E2E (`apps/web/src/app/(admin)/admin/e2e-harness/…`) există DOAR pentru dezvoltare și teste și nu
 * ajung în build-ul de producție, la fel ca pagina de exemplu a componentelor:
 *   1. toate fișierele din folder sunt `*.e2e.tsx`, singura extensie pe care `pageExtensionsFor` o include doar în dezvoltare sau
 *      cu `E2E_HARNESS=1`; un `page.tsx` obișnuit ar deveni rută și în producție;
 *   2. fiecare `page.e2e.tsx` are a doua barieră: în producție fără `E2E_HARNESS=1`, `notFound()` (accesibilă deci doar în
 *      dezvoltare sau cu variabila, ca `/admin/galerie-componente`), și cere o sesiune de administrare (`requireAdmin`);
 *   3. niciun fișier obișnuit nu importă din folderul harness-urilor (ar târî o pagină de test în bundle-ul de producție).
 * Logica extensiilor e testată pe valori în `apps/web/src/lib/page-extensions.test.ts`, iar `next.config.ts` o folosește
 * (verificat în `design-gallery.architecture.test.ts`).
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const HARNESS_DIR = "apps/web/src/app/(admin)/admin/e2e-harness";

export interface SourceFile {
  path: string;
  content: string;
}

function listFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** Condiția exactă a barierei: producție fără `E2E_HARNESS=1` → 404 (în dezvoltare pagina se vede fără variabilă). */
const BARRIER =
  /process\.env\.NODE_ENV\s*===\s*"production"\s*&&\s*process\.env\["E2E_HARNESS"\]\s*!==\s*"1"/;

export function findHarnessViolations(files: readonly SourceFile[], harnessDir: string): string[] {
  const problems: string[] = [];
  const inside = files.filter((f) => f.path.startsWith(`${harnessDir}/`));
  for (const file of inside) {
    if (!file.path.endsWith(".e2e.tsx")) {
      problems.push(`${file.path}: în folderul harness-urilor sunt permise doar fișiere *.e2e.tsx`);
    }
  }
  for (const page of inside.filter((f) => f.path.endsWith("/page.e2e.tsx"))) {
    if (!BARRIER.test(page.content) || !/notFound\(\)/.test(page.content)) {
      problems.push(
        `${page.path}: lipsește bariera (NODE_ENV production fără E2E_HARNESS=1 → notFound())`,
      );
    }
    if (!/requireAdmin\(/.test(page.content)) {
      problems.push(`${page.path}: pagina-harness trebuie să ceară o sesiune de administrare`);
    }
  }
  for (const file of files) {
    if (file.path.startsWith(`${harnessDir}/`) || file.path.endsWith(".e2e.tsx")) continue;
    if (/\bfrom\s+["'][^"']*e2e-harness/.test(file.content)) {
      problems.push(`${file.path}: importă din e2e-harness (ar intra în bundle-ul de producție)`);
    }
  }
  return problems;
}

const file = (path: string, content: string): SourceFile => ({ path, content });
const GOOD =
  'import { requireAdmin } from "x"; export default async function P() { if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound(); await requireAdmin({ permission: "a" }); }';

describe("paginile-harness (cazuri sintetice)", () => {
  const dir = "app/e2e-harness";

  it("acceptă varianta corectă", () => {
    expect(
      findHarnessViolations(
        [file(`${dir}/x/page.e2e.tsx`, GOOD), file(`${dir}/x/h.e2e.tsx`, "x")],
        dir,
      ),
    ).toEqual([]);
  });

  it("prinde un page.tsx obișnuit în folder", () => {
    expect(
      findHarnessViolations(
        [file(`${dir}/x/page.e2e.tsx`, GOOD), file(`${dir}/x/page.tsx`, "x")],
        dir,
      ).join("\n"),
    ).toContain("doar fișiere *.e2e.tsx");
  });

  it("prinde lipsa barierei sau o barieră care blochează și dezvoltarea (doar variabila)", () => {
    const none = findHarnessViolations(
      [file(`${dir}/x/page.e2e.tsx`, "export default () => null;")],
      dir,
    ).join("\n");
    expect(none).toContain("lipsește bariera");
    const varOnly = GOOD.replace('process.env.NODE_ENV === "production" && ', "");
    expect(
      findHarnessViolations([file(`${dir}/x/page.e2e.tsx`, varOnly)], dir).join("\n"),
    ).toContain("lipsește bariera");
  });

  it("prinde o pagină fără sesiune de administrare", () => {
    const noAuth = GOOD.replace('await requireAdmin({ permission: "a" });', "");
    expect(
      findHarnessViolations([file(`${dir}/x/page.e2e.tsx`, noAuth)], dir).join("\n"),
    ).toContain("sesiune de administrare");
  });

  it("prinde un import din harness într-un fișier obișnuit", () => {
    const problems = findHarnessViolations(
      [
        file(`${dir}/x/page.e2e.tsx`, GOOD),
        file("app/y/page.tsx", 'import { H } from "../e2e-harness/x/h.e2e";'),
      ],
      dir,
    );
    expect(problems.join("\n")).toContain("importă din e2e-harness");
  });
});

describe("codul real", () => {
  it("paginile-harness: doar *.e2e.tsx, cu bariera producție → 404 și cu sesiune de administrare; nimeni nu le importă", () => {
    const files = [...listFiles(join(root, "apps/web/src")), ...listFiles(join(root, "packages"))]
      .filter((path) => /\.(tsx?|css)$/.test(path) && !/node_modules/.test(path))
      .map((path) => file(relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8")));
    expect(files.some((f) => f.path.startsWith(`${HARNESS_DIR}/`))).toBe(true);
    expect(findHarnessViolations(files, HARNESS_DIR)).toEqual([]);
  });
});
