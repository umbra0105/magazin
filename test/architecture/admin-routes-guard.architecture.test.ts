import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură: ORICE rută API din `api/admin/**` (GET sau POST) verifică permisiunea. Testul rutelor
 * care scriu (`upload-route`) acoperă doar POST/PUT/PATCH/DELETE; o rută de CITIRE (un raport, o listă, o
 * descărcare) scoate date la fel de bine, deci are aceeași obligație. O rută trece dacă
 *  - cheamă un handler `handle*` din `@ecom/core` al cărui fișier conține `can(` sau `assertCan(`, sau
 *  - conține ea însăși `can(`, `assertCan(` sau `withPermission(`.
 *
 * Citește sursa ca text; `findAdminRouteViolations` e pură și testată pe fișiere sintetice.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const ADMIN_ROUTE = /^apps\/web\/src\/app\/api\/admin\/.*route\.tsx?$/;
const HTTP_METHOD =
  /export\s+(?:async\s+)?(?:function|const)\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD)\b/;
const PERMISSION_CHECK = /\b(?:can|assertCan|withPermission)\s*\(/;
const HANDLER = /\b(handle[A-Z]\w*)\b/g;

const strip = (content: string): string =>
  content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

export function findAdminRouteViolations(
  routes: readonly SourceFile[],
  coreFiles: readonly SourceFile[],
): string[] {
  const problems: string[] = [];
  for (const route of routes) {
    if (!ADMIN_ROUTE.test(route.path)) continue;
    const code = strip(route.content);
    if (!HTTP_METHOD.test(code)) continue;
    if (PERMISSION_CHECK.test(code)) continue;
    const handlers = [...new Set([...code.matchAll(HANDLER)].map((m) => m[1]))];
    const files = handlers
      .map((name) =>
        coreFiles.find((f) =>
          new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(f.content),
        ),
      )
      .filter((f): f is SourceFile => f !== undefined);
    if (files.length === 0) {
      problems.push(
        `${route.path}: rută de admin fără verificarea permisiunii și fără handler din core`,
      );
      continue;
    }
    for (const file of files) {
      if (!PERMISSION_CHECK.test(strip(file.content))) {
        problems.push(
          `${route.path}: handlerul din ${file.path} nu verifică permisiunea (can/assertCan)`,
        );
      }
    }
  }
  return problems;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated" || name.startsWith(".next")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(full);
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

describe("rutele API din admin verifică permisiunea, și cele de citire (sursa reală)", () => {
  const routes = load("apps/web/src/app/api/admin");
  const core = load("packages/core/src");

  it("scanează rutele existente (nu trece în gol), inclusiv raportul de import (GET)", () => {
    const paths = routes.map((r) => r.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "apps/web/src/app/api/admin/product-imports/[id]/report/route.ts",
        "apps/web/src/app/api/admin/product-imports/template/route.ts",
        "apps/web/src/app/api/admin/product-exports/route.ts",
      ]),
    );
    expect(routes.filter((r) => HTTP_METHOD.test(r.content)).length).toBeGreaterThanOrEqual(6);
  });

  it("nicio rută de admin nu lipsește de verificarea permisiunii", () => {
    expect(findAdminRouteViolations(routes, core)).toEqual([]);
  });
});

describe("findAdminRouteViolations pe fișiere sintetice (testul pică când trebuie)", () => {
  const route = (content: string, path = "apps/web/src/app/api/admin/x/route.ts"): SourceFile => ({
    path,
    content,
  });
  const handler = (body: string): SourceFile => ({
    path: "packages/core/src/x/handler.ts",
    content: `export async function handleX(request: Request) {\n${body}\n}`,
  });

  it("prinde o rută GET care citește fără nicio verificare", () => {
    expect(
      findAdminRouteViolations(
        [route("export async function GET() { return Response.json(await listEverything()); }")],
        [],
      ),
    ).toEqual([expect.stringContaining("fără verificarea permisiunii")]);
  });

  it("prinde un handler din core care nu verifică permisiunea", () => {
    expect(
      findAdminRouteViolations(
        [
          route(
            'import { handleX } from "@ecom/core";\nexport async function GET(r: Request) { return handleX(r); }',
          ),
        ],
        [handler("return new Response('ok');")],
      ),
    ).toEqual([expect.stringContaining("nu verifică permisiunea")]);
  });

  it("acceptă un handler cu verificare, o rută cu verificare proprie, și ignoră rutele din afara admin-ului", () => {
    expect(
      findAdminRouteViolations(
        [
          route(
            'import { handleX } from "@ecom/core";\nexport async function GET(r: Request) { return handleX(r); }',
          ),
          route(
            'export async function GET() { if (!can(s, "x")) return a(); return b(); }',
            "apps/web/src/app/api/admin/y/route.ts",
          ),
          route(
            "export async function GET() { return new Response('public'); }",
            "apps/web/src/app/api/media/route.ts",
          ),
        ],
        [handler('if (!can(subject, "products.write")) return forbidden();')],
      ),
    ).toEqual([]);
  });
});
