import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură pentru produsele digitale (Faza 14b). Reguli, pe codul de producție (testele, e2e și scripturile sunt scutite):
 *  1. `storageKey` (cheia de stocare) NU iese din server: nu apare în `apps/web` (componente, pagini, rute, acțiuni), în `packages/emails`
 *     sau în `packages/ui`. Pe server, doar serviciile din `packages/core/src/digital` și driverele din `packages/integrations` o citesc.
 *  2. Drepturile de acces (`digitalEntitlement`) se creează, se modifică și se șterg DOAR în `packages/core/src/digital`, care e și
 *     singurul loc care decide CÂND se acordă accesul (`digital-rules.ts`); nicio altă cale nu scrie un drept.
 *  3. Linkurile de acces se emit într-un singur loc (`digital-access.ts`): doar acolo se apelează `createAccess(`.
 *  4. Contorul de descărcări crește doar în `digital-access.ts` și se resetează doar în `digital-admin.ts`: nicio altă scriere a lui
 *     `downloadCount`.
 *  5. Jurnalul de accesări (`digitalAccessLog`) se scrie doar în `digital-access.ts`; IP-ul și user-agent-ul se golesc doar în
 *     `digital-privacy.ts`.
 *  6. Jetonul de acces (`accessToken`) nu ajunge în emailuri, în șabloane sau în contextul lor.
 *  7. Șirurile `private/digital` (spațiul de stocare al conținutului) nu apar în afara driverelor și a serviciului de conținut.
 *  8. Pe client nu se cere niciun link de conținut prin metode GET cu efect: linkul se cere prin POST (`/api/cont/digital/acces`).
 *
 * Funcțiile `find…` sunt pure și testate pe cazuri sintetice, ca testul să nu poată trece «în gol».
 */
const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
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
  /(^|\/)scripts\//.test(path);

const isCode = (path: string): boolean => /\.[cm]?tsx?$/.test(path) && !isTestPath(path);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function walk(dir: string, out: SourceFile[]): void {
  for (const name of readdirSync(join(root, dir))) {
    if (name === "node_modules" || name.startsWith(".") || name === "generated") continue;
    const rel = `${dir}/${name}`;
    const full = join(root, rel);
    if (statSync(full).isDirectory()) walk(rel, out);
    else if (isCode(rel.split(sep).join("/"))) {
      out.push({
        path: relative(root, full).split(sep).join("/"),
        content: readFileSync(full, "utf8"),
      });
    }
  }
}

const load = (dirs: string[]): SourceFile[] => {
  const out: SourceFile[] = [];
  for (const dir of dirs) walk(dir, out);
  return out;
};

const DIGITAL_CORE = "packages/core/src/digital/";
const MEDIA_DRIVERS = "packages/integrations/src/media-delivery/";

/** 1. `storageKey` în afara serverului (aplicație, emailuri, design system). */
export function findStorageKeyLeaks(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    // «Descărcări» ale produsului (documente de produs, Faza 7): propria cheie de stocare, rută de server proprie, fără legătură cu conținutul digital
    if (file.path === "apps/web/src/app/(storefront)/descarca/[id]/route.ts") continue;
    if (
      !file.path.startsWith("apps/web/src/") &&
      !file.path.startsWith("packages/emails/src/") &&
      !file.path.startsWith("packages/ui/src/")
    ) {
      continue;
    }
    if (/\bstorageKey\b/.test(stripComments(file.content))) {
      problems.push(`${file.path}: «storageKey» nu are voie în afara serverului de livrare`);
    }
  }
  return problems;
}

/** 2. Scrieri pe `digitalEntitlement` în afara `digital/`. */
export function findEntitlementWrites(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  const pattern =
    /\bdigitalEntitlement\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b/;
  for (const file of files) {
    if (file.path.startsWith(DIGITAL_CORE)) continue;
    const match = pattern.exec(stripComments(file.content));
    if (match) {
      problems.push(
        `${file.path}: scrie un drept de acces digital (digitalEntitlement.${match[1]})`,
      );
    }
  }
  return problems;
}

/** 3. `createAccess(` doar în `digital-access.ts` (și în drivere, unde e definit). */
export function findAccessLinkIssuers(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (file.path === `${DIGITAL_CORE}digital-access.ts` || file.path.startsWith(MEDIA_DRIVERS)) {
      continue;
    }
    if (/\.\s*createAccess\s*\(/.test(stripComments(file.content))) {
      problems.push(`${file.path}: emite un link de acces în afara digital-access.ts`);
    }
  }
  return problems;
}

/** 4. Scrieri pe `downloadCount`. */
export function findCounterWrites(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const content = stripComments(file.content);
    // scriere = `data: { downloadCount: … }`, `downloadCount: { increment … }` sau `SET "downloadCount"`; un câmp citit sau afișat nu e scriere
    const writes =
      /\bdata\s*:\s*\{[^}]*\bdownloadCount\s*:/.test(content) ||
      /\bdownloadCount\s*:\s*\{\s*(increment|decrement|set)\b/.test(content) ||
      /SET\s+"downloadCount"/i.test(content);
    if (!writes) continue;
    const allowed =
      file.path === `${DIGITAL_CORE}digital-access.ts` ||
      file.path === `${DIGITAL_CORE}digital-admin.ts`;
    if (!allowed) problems.push(`${file.path}: scrie contorul de descărcări`);
  }
  return problems;
}

/** 5. Jurnalul de accesări: scriere doar în `digital-access.ts`, curățare doar în `digital-privacy.ts`. */
export function findAccessLogWrites(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const content = stripComments(file.content);
    if (/\bdigitalAccessLog\s*\.\s*(create|createMany|upsert)\b/.test(content)) {
      if (file.path !== `${DIGITAL_CORE}digital-access.ts`) {
        problems.push(`${file.path}: scrie în jurnalul de accesări în afara digital-access.ts`);
      }
    }
    if (/\bdigitalAccessLog\s*\.\s*(update|updateMany|delete|deleteMany)\b/.test(content)) {
      if (file.path !== `${DIGITAL_CORE}digital-privacy.ts`) {
        problems.push(`${file.path}: modifică jurnalul de accesări în afara digital-privacy.ts`);
      }
    }
  }
  return problems;
}

/** 6. Jetonul de acces în emailuri și în contextul lor. */
export function findTokenInEmails(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const inEmails =
      file.path.startsWith("packages/emails/src/") ||
      file.path === "packages/jobs/src/order-email-context.ts" ||
      file.path.startsWith("packages/core/src/email/");
    if (!inEmails) continue;
    if (/\baccessToken\b/.test(stripComments(file.content))) {
      problems.push(`${file.path}: «accessToken» nu are voie în emailuri`);
    }
  }
  return problems;
}

/** 7. Spațiul de stocare al conținutului digital. */
export function findDigitalKeyPrefix(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (file.path.startsWith(MEDIA_DRIVERS) || file.path === `${DIGITAL_CORE}digital-content.ts`) {
      continue;
    }
    if (/private\/digital/.test(stripComments(file.content))) {
      problems.push(`${file.path}: pomenește spațiul «private/digital»`);
    }
  }
  return problems;
}

const files = load(["apps/web/src", "packages"]).filter(
  (f) => !f.path.startsWith("packages/db/") && !f.path.includes("/generated/"),
);

describe("produse digitale: reguli de arhitectură (sursa reală)", () => {
  it("scanează codul real (nu trece în gol)", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.path === `${DIGITAL_CORE}digital-access.ts`)).toBe(true);
    expect(files.some((f) => f.path === `${DIGITAL_CORE}digital-grant.ts`)).toBe(true);
  });

  it("1. cheia de stocare nu iese din server", () => {
    expect(findStorageKeyLeaks(files)).toEqual([]);
  });

  it("2. drepturile de acces se scriu doar în digital/", () => {
    expect(findEntitlementWrites(files)).toEqual([]);
  });

  it("3. linkurile de acces se emit doar în digital-access.ts", () => {
    expect(findAccessLinkIssuers(files)).toEqual([]);
  });

  it("4. contorul de descărcări se scrie doar unde trebuie", () => {
    expect(findCounterWrites(files)).toEqual([]);
  });

  it("5. jurnalul de accesări se scrie și se curăță doar unde trebuie", () => {
    expect(findAccessLogWrites(files)).toEqual([]);
  });

  it("6. jetonul de acces nu ajunge în emailuri", () => {
    expect(findTokenInEmails(files)).toEqual([]);
  });

  it("7. spațiul private/digital rămâne în drivere și în serviciul de conținut", () => {
    expect(findDigitalKeyPrefix(files)).toEqual([]);
  });

  it("8. linkul de acces se cere prin POST: ruta clientului nu exportă GET", () => {
    const route = files.find((f) => f.path === "apps/web/src/app/api/cont/digital/acces/route.ts");
    expect(route).toBeDefined();
    const content = stripComments(route?.content ?? "");
    expect(content).toMatch(/export\s+async\s+function\s+POST\b/);
    expect(content).not.toMatch(/export\s+(async\s+)?(function|const)\s+GET\b/);
  });
});

describe("funcțiile de verificare prind încălcările (cazuri sintetice)", () => {
  const f = (path: string, content: string): SourceFile => ({ path, content });

  it("storageKey în componentă sau în email", () => {
    expect(
      findStorageKeyLeaks([f("apps/web/src/components/x.tsx", "const k = asset.storageKey;")]),
    ).toHaveLength(1);
    expect(
      findStorageKeyLeaks([f("packages/emails/src/catalog.ts", "vars.storageKey = 1")]),
    ).toHaveLength(1);
    expect(
      findStorageKeyLeaks([f("apps/web/src/components/x.tsx", "// storageKey e secret")]),
    ).toHaveLength(0);
    expect(
      findStorageKeyLeaks([f("packages/core/src/digital/digital-access.ts", "storageKey")]),
    ).toHaveLength(0);
  });

  it("scrieri de drepturi în afara digital/", () => {
    expect(
      findEntitlementWrites([
        f("packages/core/src/orders/x.ts", "await tx.digitalEntitlement.create({})"),
      ]),
    ).toHaveLength(1);
    expect(
      findEntitlementWrites([
        f("apps/web/src/app/x.ts", "db.digitalEntitlement.updateMany({ where: {} })"),
      ]),
    ).toHaveLength(1);
    expect(
      findEntitlementWrites([
        f("packages/core/src/digital/digital-grant.ts", "tx.digitalEntitlement.createMany({})"),
      ]),
    ).toHaveLength(0);
    expect(
      findEntitlementWrites([f("apps/web/src/app/x.ts", "db.digitalEntitlement.findMany({})")]),
    ).toHaveLength(0);
  });

  it("emitere de linkuri în afara digital-access.ts", () => {
    expect(
      findAccessLinkIssuers([f("apps/web/src/app/x.ts", "await provider.createAccess({})")]),
    ).toHaveLength(1);
    expect(
      findAccessLinkIssuers([
        f("packages/core/src/digital/digital-access.ts", "await provider.createAccess({})"),
      ]),
    ).toHaveLength(0);
    expect(
      findAccessLinkIssuers([
        f("packages/integrations/src/media-delivery/bunny.ts", "async createAccess(r) {"),
      ]),
    ).toHaveLength(0);
  });

  it("scrieri ale contorului", () => {
    expect(
      findCounterWrites([f("apps/web/src/app/x.ts", "data: { downloadCount: 0 }")]),
    ).toHaveLength(1);
    expect(
      findCounterWrites([
        f("packages/core/src/digital/digital-grant.ts", 'SET "downloadCount" = 0'),
      ]),
    ).toHaveLength(1);
    expect(
      findCounterWrites([
        f("packages/core/src/digital/digital-admin.ts", "data: { downloadCount: 0 }"),
      ]),
    ).toHaveLength(0);
    expect(findCounterWrites([f("apps/web/src/app/x.ts", "row.downloadCount")])).toHaveLength(0);
  });

  it("jurnalul de accesări", () => {
    expect(
      findAccessLogWrites([f("apps/web/src/a.ts", "db.digitalAccessLog.create({})")]),
    ).toHaveLength(1);
    expect(
      findAccessLogWrites([
        f("packages/core/src/digital/digital-admin.ts", "x.digitalAccessLog.updateMany({})"),
      ]),
    ).toHaveLength(1);
    expect(
      findAccessLogWrites([
        f("packages/core/src/digital/digital-privacy.ts", "db.digitalAccessLog.updateMany({})"),
      ]),
    ).toHaveLength(0);
  });

  it("jeton în email și prefix de stocare", () => {
    expect(
      findTokenInEmails([f("packages/jobs/src/order-email-context.ts", "vars.t = e.accessToken")]),
    ).toHaveLength(1);
    expect(findTokenInEmails([f("apps/web/src/a.tsx", "accessToken")])).toHaveLength(0);
    expect(
      findDigitalKeyPrefix([f("apps/web/src/a.ts", 'const k = "private/digital/x"')]),
    ).toHaveLength(1);
    expect(
      findDigitalKeyPrefix([
        f("packages/integrations/src/media-delivery/storage-delivery.ts", '"private/digital/"'),
      ]),
    ).toHaveLength(0);
  });
});
