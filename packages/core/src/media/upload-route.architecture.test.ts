import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură pentru rutele API care SCRIU (POST/PUT/PATCH/DELETE), în special cele de
 * încărcare de fișiere. Nu au `withPermission` (nu sunt server actions), deci își fac singure
 * verificările: orice rută care scrie trebuie să
 *   (a) delege unui handler `handle*` din `@ecom/core` al cărui fișier conține verificarea de
 *       ORIGINE (`isSameOriginRequest(`) și una de PERMISIUNE (`can(` / `assertCan(`), sau
 *   (b) conțină ea însăși ambele verificări, sau
 *   (c) să fie pe lista explicită de excepții de mai jos, cu motivul scris.
 * Pică dacă o rută nouă de upload nu are verificarea de origine sau cea de permisiune.
 *
 * Citește sursa ca text; `findUploadRouteViolations` e pură și testată pe fișiere sintetice, ca testul
 * să nu poată trece „în gol”.
 */

const root = fileURLToPath(new URL("../../../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

/** Rute care scriu și NU trec prin regula de mai sus, fiecare cu motivul. */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  "apps/web/src/app/api/auth/[...all]/route.ts":
    "Better Auth: își validează singură originea (trustedOrigins), sesiunea și limitele; testat la autentificare",
  "apps/web/src/app/api/verify-email/route.ts":
    "confirmare de email cu token unic, fără sesiune și fără fișiere; are rate limit pe IP",
  "apps/web/src/app/api/back-in-stock/route.ts":
    "«Anunță-mă când revine»: public (fără sesiune), verifică originea cererii, are capcană pentru roboți, limită pe IP și plafoane în serviciu; fără fișiere",
  "apps/web/src/app/api/webhooks/payments/[provider]/route.ts":
    "webhook de plată (Faza 10): server-la-server, fără sesiune și fără origine de browser; singura autentificare e semnătura procesatorului, verificată în timp constant pe corpul brut (fără semnătură validă: respins, înregistrat fără conținut și fără niciun efect); corp limitat; fără fișiere. Păzit de testul de arhitectură `payments`",
  "apps/web/src/app/api/cont/digital/acces/route.ts":
    "linkuri de acces la produse digitale (Faza 14b), pentru CLIENTUL autentificat (nu admin): verifică originea, sesiunea clientului (`getCustomer`) și limita de cereri pe client; proprietatea dreptului se verifică în aceeași interogare care îl caută (`requestAccess`), nu printr-o permisiune de admin; fără fișiere, corp mic (două câmpuri)",
  "apps/web/src/app/api/internal/revalidate/route.ts":
    "invalidare de cache cerută de worker: nu are sesiune, ci semnătură HMAC cu marcă de timp (cheie derivată din APP_KEY) și etichete dintr-o listă strictă; fără fișiere",
};

const MUTATING = /export\s+(?:async\s+)?(?:function|const)\s+(?:POST|PUT|PATCH|DELETE)\b/;
const ORIGIN_CHECK = /\bisSameOriginRequest\s*\(/;
const PERMISSION_CHECK = /\b(?:can|assertCan|withPermission)\s*\(/;
const HANDLER_IMPORT = /\b(handle[A-Z]\w*)\b/g;

const isRoute = (path: string): boolean => /\/app\/api\/.*route\.tsx?$/.test(path);

function hasBoth(content: string): { origin: boolean; permission: boolean } {
  return { origin: ORIGIN_CHECK.test(content), permission: PERMISSION_CHECK.test(content) };
}

export function findUploadRouteViolations(
  routes: readonly SourceFile[],
  coreFiles: readonly SourceFile[],
): string[] {
  const problems: string[] = [];
  for (const route of routes) {
    if (!isRoute(route.path) || !MUTATING.test(route.content)) continue;
    if (Object.hasOwn(EXCEPTIONS, route.path)) continue;

    // (a) delegare la un handler din core
    const handlers = [...new Set([...route.content.matchAll(HANDLER_IMPORT)].map((m) => m[1]))];
    const delegated = handlers.filter((name) =>
      coreFiles.some((f) =>
        new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(f.content),
      ),
    );
    if (delegated.length > 0) {
      for (const name of delegated) {
        const file = coreFiles.find((f) =>
          new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(f.content),
        ) as SourceFile;
        const { origin, permission } = hasBoth(file.content);
        if (!origin) {
          problems.push(
            `${route.path}: handlerul «${name}» (${file.path}) nu verifică originea (isSameOriginRequest)`,
          );
        }
        if (!permission) {
          problems.push(
            `${route.path}: handlerul «${name}» (${file.path}) nu verifică permisiunea (can/assertCan)`,
          );
        }
      }
      continue;
    }

    // (b) verificările în rută
    const { origin, permission } = hasBoth(route.content);
    if (!origin)
      problems.push(`${route.path}: ruta scrie fără verificarea originii (isSameOriginRequest)`);
    if (!permission)
      problems.push(`${route.path}: ruta scrie fără verificarea permisiunii (can/assertCan)`);
  }
  return problems;
}

const SKIP_DIRS = new Set(["node_modules", "generated", ".next", ".turbo", "dist", "coverage"]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".next")) continue;
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

describe("rutele API care scriu verifică originea și permisiunea (sursa reală)", () => {
  const routes = load("apps/web/src/app/api");
  const core = load("packages/core/src");

  it("scanează rutele existente (nu trece în gol) și le recunoaște pe cele de upload", () => {
    const mutating = routes.filter((r) => isRoute(r.path) && MUTATING.test(r.content));
    expect(mutating.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        "apps/web/src/app/api/media/route.ts",
        "apps/web/src/app/api/admin/products/[id]/documents/route.ts",
        "apps/web/src/app/api/admin/product-exports/route.ts",
      ]),
    );
    // excepțiile enumerate există și chiar scriu (altfel lista ar putea îmbătrâni în tăcere)
    for (const path of Object.keys(EXCEPTIONS)) {
      const file = routes.find((r) => r.path === path);
      expect(file, path).toBeDefined();
      expect(MUTATING.test(file?.content ?? ""), path).toBe(true);
    }
  });

  it("handlerele de upload, import și export conțin verificarea de origine și cea de permisiune", () => {
    for (const name of [
      "handleMediaUpload",
      "handleProductDocumentUpload",
      "handleProductImportUpload",
      "handleProductExport",
    ]) {
      const file = core.find((f) =>
        new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(f.content),
      );
      expect(file, name).toBeDefined();
      expect(hasBoth(file?.content ?? ""), name).toEqual({ origin: true, permission: true });
    }
  });

  it("nicio rută care scrie nu lipsește de verificările de origine și permisiune", () => {
    expect(findUploadRouteViolations(routes, core)).toEqual([]);
  });
});

describe("findUploadRouteViolations pe fișiere sintetice (testul pică când trebuie)", () => {
  const handler = (body: string): SourceFile => ({
    path: "packages/core/src/x/upload-handler.ts",
    content: `export async function handleXUpload(request: Request) {\n${body}\n}`,
  });
  const route = (content: string): SourceFile => ({
    path: "apps/web/src/app/api/x/route.ts",
    content,
  });
  const delegating = route(
    `import { handleXUpload } from "@ecom/core";\nexport async function POST(r: Request) { return handleXUpload(r); }`,
  );

  it("prinde o rută de upload fără verificarea originii", () => {
    const problems = findUploadRouteViolations(
      [
        route(
          `export async function POST(request: Request) {\n  if (!can(subject, "media.write")) return new Response(null, { status: 403 });\n  return new Response(await request.arrayBuffer());\n}`,
        ),
      ],
      [],
    );
    expect(problems).toEqual([expect.stringContaining("fără verificarea originii")]);
  });

  it("prinde o rută de upload fără verificarea permisiunii", () => {
    const problems = findUploadRouteViolations(
      [
        route(
          `export async function POST(request: Request) {\n  if (!isSameOriginRequest(request.headers, APP)) return new Response(null, { status: 403 });\n  return new Response(await request.arrayBuffer());\n}`,
        ),
      ],
      [],
    );
    expect(problems).toEqual([expect.stringContaining("fără verificarea permisiunii")]);
  });

  it("prinde un handler din core căruia îi lipsește originea sau permisiunea", () => {
    const noOrigin = findUploadRouteViolations(
      [delegating],
      [handler(`if (!can(subject, "x")) return forbidden();`)],
    );
    expect(noOrigin).toEqual([expect.stringContaining("nu verifică originea")]);
    const noPermission = findUploadRouteViolations(
      [delegating],
      [handler(`if (!isSameOriginRequest(request.headers, app)) return forbidden();`)],
    );
    expect(noPermission).toEqual([expect.stringContaining("nu verifică permisiunea")]);
  });

  it("acceptă un handler complet și o rută care își face singură verificările", () => {
    expect(
      findUploadRouteViolations(
        [delegating],
        [
          handler(
            `if (!isSameOriginRequest(request.headers, app)) return a();\nif (!can(subject, "x")) return b();`,
          ),
        ],
      ),
    ).toEqual([]);
    expect(
      findUploadRouteViolations(
        [
          route(
            `export async function POST(request: Request) {\n  if (!isSameOriginRequest(request.headers, APP)) return a();\n  assertCan(subject, "x");\n}`,
          ),
        ],
        [],
      ),
    ).toEqual([]);
  });

  it("nu dă fals pozitive pe rute care doar citesc (GET) și respectă lista de excepții", () => {
    expect(
      findUploadRouteViolations(
        [route(`export async function GET() { return new Response("ok"); }`)],
        [],
      ),
    ).toEqual([]);
    expect(
      findUploadRouteViolations(
        [
          {
            path: "apps/web/src/app/api/verify-email/route.ts",
            content: `export async function POST(request: Request) { return Response.json({}); }`,
          },
        ],
        [],
      ),
    ).toEqual([]);
  });
});
