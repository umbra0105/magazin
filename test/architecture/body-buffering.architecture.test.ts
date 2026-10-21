import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Cu middleware, Next memorează în memorie corpul fiecărei cereri (până la `middlewareClientMaxBodySize`) ÎNAINTE de
 * orice verificare de origine, sesiune sau permisiune. Cu limita ridicată la 51 MB pentru încărcări, ORICE rută (inclusiv
 * `/api/auth/*`) putea fi hrănită de un anonim cu corpuri de 50 MB (Blocul C, C-07). Regula: rutele de încărcare, care
 * își citesc singure corpul pe flux, sunt scoase din middleware (nu se memorează nimic), iar limita de memorare rămâne
 * mică pentru restul. Citește sursa ca text; verificările sunt pure.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

/** Rutele de încărcare: handlerele lor citesc corpul pe flux, cu limită proprie, și își fac singure autorizarea. */
export const UPLOAD_ROUTES = [
  "/api/media",
  "/api/admin/product-imports",
  "/api/admin/products/abc123/documents",
] as const;

/** Rute obișnuite, care trec prin middleware (au nevoie de requestId, de redirectul de autentificare). */
export const MIDDLEWARE_ROUTES = [
  "/",
  "/admin/produse",
  "/api/auth/sign-in/email",
  "/api/admin/product-exports",
  "/api/admin/products/abc123/documents/def456",
  "/api/media/cm123",
  "/api/health",
] as const;

/** Matcher-ul `"/((?!...).*)"` ca expresie regulată (forma folosită de proiect). */
export function matcherToRegExp(matcher: string): RegExp {
  return new RegExp(`^${matcher}$`);
}

export function parseBodyLimitMb(config: string): number | null {
  const match = /middlewareClientMaxBodySize:\s*"(\d+)mb"/.exec(config);
  return match ? Number(match[1]) : null;
}

describe("memorarea corpurilor de către middleware", () => {
  const middleware = read("apps/web/src/middleware.ts");
  const matcher = /matcher:\s*\[\s*"([^"]+)",?\s*\]/.exec(middleware)?.[1] ?? "";
  const regexp = matcherToRegExp(matcher);

  it("rutele de încărcare sunt în afara middleware-ului", () => {
    for (const path of UPLOAD_ROUTES) expect(regexp.test(path), path).toBe(false);
  });

  it("restul rutelor rămân în middleware (requestId, redirect de autentificare)", () => {
    for (const path of MIDDLEWARE_ROUTES) expect(regexp.test(path), path).toBe(true);
  });

  it("limita de memorare a corpurilor pentru rutele rămase e mică (cel mult 2 MB)", () => {
    const limit = parseBodyLimitMb(read("apps/web/next.config.ts"));
    expect(limit).not.toBeNull();
    expect(limit as number).toBeLessThanOrEqual(2);
  });
});
