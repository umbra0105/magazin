import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Galeria de design a vitrinei (Faza 6, `apps/web/src/app/galerie-vitrina`) există DOAR pentru dezvoltare și teste, ca pagina de
 * exemplu a adminului și harness-urile E2E, și nu ajunge în build-ul de producție:
 *   1. toate fișierele ei sunt `*.e2e.tsx` (singura extensie inclusă doar în dezvoltare sau cu `E2E_HARNESS=1`);
 *   2. `page.e2e.tsx` are bariera a doua: în producție fără `E2E_HARNESS=1`, `notFound()`;
 *   3. niciun fișier obișnuit nu importă din folderul galeriei;
 *   4. cadrul vitrinei (header, footer, carcasă, meniu) nu conține niciun `h1`: titlul paginii îl pune fiecare pagină, ca să existe
 *      exact unul (docs/19 §1, cerința SEO «un singur H1»).
 * Funcțiile sunt pure și testate pe fișiere sintetice; ultima secțiune le aplică pe sursa reală.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const GALLERY_DIR = "apps/web/src/app/galerie-vitrina";
const CHROME_DIRS = ["apps/web/src/components/storefront"];

export interface SourceFile {
  path: string;
  content: string;
}

const BARRIER =
  /process\.env\.NODE_ENV\s*===\s*"production"\s*&&\s*process\.env\["E2E_HARNESS"\]\s*!==\s*"1"/;

export function findGalleryViolations(files: readonly SourceFile[], dir: string): string[] {
  const problems: string[] = [];
  const inside = files.filter((f) => f.path.startsWith(`${dir}/`));
  if (inside.length === 0) problems.push(`${dir}: galeria lipsește`);
  for (const file of inside) {
    if (!file.path.endsWith(".e2e.tsx")) {
      problems.push(`${file.path}: în folderul galeriei sunt permise doar fișiere *.e2e.tsx`);
    }
  }
  const page = inside.find((f) => f.path === `${dir}/page.e2e.tsx`);
  if (!page) problems.push(`${dir}/page.e2e.tsx lipsește`);
  else if (!BARRIER.test(page.content) || !/notFound\(\)/.test(page.content)) {
    problems.push(
      `${page.path}: lipsește bariera (NODE_ENV production fără E2E_HARNESS=1 → notFound())`,
    );
  }
  for (const file of files) {
    if (file.path.startsWith(`${dir}/`)) continue;
    if (/\bfrom\s+["'][^"']*galerie-vitrina/.test(file.content)) {
      problems.push(
        `${file.path}: importă din galeria de design (ar intra în bundle-ul de producție)`,
      );
    }
  }
  return problems;
}

/** Un `h1` scris în cadrul vitrinei (JSX sau șir de etichetă); comentariile nu contează. */
export function findChromeH1(files: readonly SourceFile[]): string[] {
  return files
    .filter((f) =>
      /<h1[\s>]/.test(f.content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")),
    )
    .map((f) => `${f.path}: cadrul vitrinei nu are voie să conțină un h1 (titlul îl pune pagina)`);
}

const GOOD =
  'export default async function P() { if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound(); }';

describe("galeria vitrinei (cazuri sintetice)", () => {
  const dir = "app/galerie";
  const f = (path: string, content: string): SourceFile => ({ path, content });

  it("acceptă varianta corectă", () => {
    expect(findGalleryViolations([f(`${dir}/page.e2e.tsx`, GOOD)], dir)).toEqual([]);
  });

  it("prinde un page.tsx obișnuit, bariera lipsă și un import din afară", () => {
    const out = findGalleryViolations(
      [
        f(`${dir}/page.e2e.tsx`, "export default function P() {}"),
        f(`${dir}/page.tsx`, "x"),
        f("app/alt.tsx", 'import x from "@/app/galerie-vitrina/page.e2e"'),
      ],
      dir,
    ).join("\n");
    expect(out).toContain("doar fișiere *.e2e.tsx");
    expect(out).toContain("lipsește bariera");
    expect(out).toContain("importă din galeria de design");
  });

  it("prinde h1 în cadru, dar nu în comentarii", () => {
    expect(findChromeH1([f("a.tsx", "<h1>Titlu</h1>")])).toHaveLength(1);
    expect(findChromeH1([f("a.tsx", "// fără <h1> aici\n/* <h1> */ <h2>ok</h2>")])).toEqual([]);
  });
});

function listFiles(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, out);
    else if (/\.tsx?$/.test(name)) {
      out.push({
        path: relative(root, full).replaceAll("\\", "/"),
        content: readFileSync(full, "utf8"),
      });
    }
  }
  return out;
}

describe("sursa reală", () => {
  it("galeria vitrinei e doar pentru dezvoltare", () => {
    const files = listFiles(join(root, "apps/web/src"));
    expect(findGalleryViolations(files, GALLERY_DIR)).toEqual([]);
  });

  it("header-ul, footer-ul, carcasa și meniurile vitrinei nu conțin niciun h1", () => {
    const files = CHROME_DIRS.flatMap((dir) => listFiles(join(root, dir)));
    expect(files.length).toBeGreaterThan(3);
    expect(findChromeH1(files)).toEqual([]);
  });
});
