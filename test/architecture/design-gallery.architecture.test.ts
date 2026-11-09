import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pagina de exemplu a componentelor (docs/17 §7) există DOAR pentru dezvoltare și nu ajunge în build-ul de producție:
 *   1. toate fișierele ei sunt `*.e2e.tsx`, singura extensie pe care `pageExtensionsFor` o include doar în dezvoltare sau cu
 *      `E2E_HARNESS=1`; un `page.tsx` obișnuit în folder ar deveni rută și în producție;
 *   2. `next.config.ts` ia extensiile din `pageExtensionsFor` (nu o listă proprie care ar putea include `e2e.tsx` mereu);
 *   3. pagina are a doua barieră: în producție fără `E2E_HARNESS=1`, `notFound()`;
 *   4. niciun fișier obișnuit nu importă din folderul galeriei (ar târî-o în bundle-ul de producție);
 *   5. rutele ei nu apar în sitemap sau în meniul adminului (nu e un ecran al produsului).
 * Logica extensiilor e testată pe valori în `apps/web/src/lib/page-extensions.test.ts`.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const GALLERY_DIR = "apps/web/src/app/(admin)/admin/galerie-componente";

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

export function findGalleryViolations(
  files: readonly SourceFile[],
  galleryDir: string,
  nextConfig: string,
): string[] {
  const problems: string[] = [];
  const inGallery = files.filter((f) => f.path.startsWith(`${galleryDir}/`));
  if (inGallery.length === 0) problems.push(`${galleryDir}: pagina de exemplu lipsește`);
  for (const file of inGallery) {
    if (!file.path.endsWith(".e2e.tsx")) {
      problems.push(`${file.path}: în folderul galeriei sunt permise doar fișiere *.e2e.tsx`);
    }
  }
  const page = inGallery.find((f) => f.path === `${galleryDir}/page.e2e.tsx`);
  if (!page) {
    problems.push(`${galleryDir}/page.e2e.tsx lipsește`);
  } else if (
    !/process\.env\.NODE_ENV === "production"/.test(page.content) ||
    !/E2E_HARNESS/.test(page.content) ||
    !/notFound\(\)/.test(page.content)
  ) {
    problems.push(
      `${page.path}: lipsește bariera a doua (NODE_ENV production fără E2E_HARNESS → notFound())`,
    );
  }
  if (!/pageExtensionsFor\(/.test(nextConfig)) {
    problems.push(
      "apps/web/next.config.ts: pageExtensions trebuie să vină din pageExtensionsFor()",
    );
  }
  if (/["']e2e\.tsx["']/.test(nextConfig)) {
    problems.push(
      "apps/web/next.config.ts: `e2e.tsx` nu se scrie aici (doar în page-extensions.ts)",
    );
  }
  for (const file of files) {
    if (file.path.startsWith(`${galleryDir}/`) || file.path.endsWith(".e2e.tsx")) continue;
    if (
      /galerie-componente/.test(file.content) &&
      /\bfrom\s+["'][^"']*galerie-componente/.test(file.content)
    ) {
      problems.push(
        `${file.path}: importă din galeria de componente (ar intra în bundle-ul de producție)`,
      );
    }
    if (file.path === "apps/web/src/lib/admin-nav.ts" && /galerie-componente/.test(file.content)) {
      problems.push(`${file.path}: galeria nu face parte din meniul adminului`);
    }
  }
  return problems;
}

const file = (path: string, content: string): SourceFile => ({ path, content });
const GOOD_PAGE =
  'if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound();';
const GOOD_CONFIG = "pageExtensions: pageExtensionsFor({ NODE_ENV: process.env.NODE_ENV }),";

describe("pagina de exemplu a componentelor (cazuri sintetice)", () => {
  const dir = "app/galerie-componente";

  it("acceptă varianta corectă", () => {
    expect(
      findGalleryViolations(
        [file(`${dir}/page.e2e.tsx`, GOOD_PAGE), file(`${dir}/gallery.e2e.tsx`, "x")],
        dir,
        GOOD_CONFIG,
      ),
    ).toEqual([]);
  });

  it("prinde un page.tsx obișnuit în folderul galeriei", () => {
    const problems = findGalleryViolations(
      [file(`${dir}/page.e2e.tsx`, GOOD_PAGE), file(`${dir}/page.tsx`, "x")],
      dir,
      GOOD_CONFIG,
    );
    expect(problems.join("\n")).toContain("doar fișiere *.e2e.tsx");
  });

  it("prinde lipsa barierei a doua din pagină", () => {
    expect(
      findGalleryViolations(
        [file(`${dir}/page.e2e.tsx`, "export default () => null;")],
        dir,
        GOOD_CONFIG,
      ).join("\n"),
    ).toContain("bariera a doua");
  });

  it("prinde next.config care nu folosește pageExtensionsFor sau scrie e2e.tsx direct", () => {
    const page = [file(`${dir}/page.e2e.tsx`, GOOD_PAGE)];
    expect(findGalleryViolations(page, dir, 'pageExtensions: ["tsx"],').join("\n")).toContain(
      "pageExtensionsFor",
    );
    expect(
      findGalleryViolations(page, dir, `${GOOD_CONFIG} const x = ["tsx", "e2e.tsx"];`).join("\n"),
    ).toContain("nu se scrie aici");
  });

  it("prinde un import din galerie într-un fișier obișnuit și galeria pusă în meniu", () => {
    const page = [file(`${dir}/page.e2e.tsx`, GOOD_PAGE)];
    expect(
      findGalleryViolations(
        [
          ...page,
          file("app/x/page.tsx", 'import { Gallery } from "../galerie-componente/gallery.e2e";'),
        ],
        dir,
        GOOD_CONFIG,
      ).join("\n"),
    ).toContain("bundle-ul de producție");
    expect(
      findGalleryViolations(
        [...page, file("apps/web/src/lib/admin-nav.ts", 'href: "/admin/galerie-componente"')],
        dir,
        GOOD_CONFIG,
      ).join("\n"),
    ).toContain("meniul adminului");
  });

  it("prinde dispariția paginii", () => {
    expect(findGalleryViolations([], dir, GOOD_CONFIG).join("\n")).toContain("lipsește");
  });
});

describe("codul real", () => {
  it("galeria există doar ca *.e2e.tsx, cu bariere, și nimic obișnuit nu o importă", () => {
    const files = listFiles(join(root, "apps/web/src"))
      .filter((p) => /\.(ts|tsx)$/.test(p))
      .map((p) => file(relative(root, p).replaceAll("\\", "/"), readFileSync(p, "utf8")));
    const nextConfig = readFileSync(join(root, "apps/web/next.config.ts"), "utf8");
    expect(findGalleryViolations(files, GALLERY_DIR, nextConfig)).toEqual([]);
  });
});
