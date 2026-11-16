import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { createMiddleware } from "./middleware";

// fără citire reală a flagului de mentenanță (testele nu fac cereri de rețea): magazinul e deschis
const middleware = createMiddleware({ isInMaintenance: async () => false });

const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie } } : undefined);

describe("middleware", () => {
  it("/admin fără cookie => 307 la /autentificare?next=/admin, cu requestId și fără cache", async () => {
    const res = await middleware(req("/admin/produse?x=1"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/autentificare");
    expect(location.searchParams.get("next")).toBe("/admin/produse?x=1");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("/cont fără cookie => redirect", async () => {
    expect((await middleware(req("/cont"))).status).toBe(307);
  });

  it("/api/admin/* fără cookie => 401 JSON cu cod stabil", async () => {
    const res = await middleware(req("/api/admin/export"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "AUTH_UNAUTHENTICATED", message: "Autentificarea este necesară" },
    });
  });

  it("cu cookie-ul de sesiune Better Auth (și varianta __Secure-) trece", async () => {
    for (const cookie of [
      "better-auth.session_token=abc.def",
      "__Secure-better-auth.session_token=abc.def",
    ]) {
      const res = await middleware(req("/admin", cookie));
      expect(res.status, cookie).toBe(200);
      expect(res.headers.get("x-request-id")).toBeTruthy();
    }
  });

  it("un cookie cu alt nume nu deschide admin-ul", async () => {
    expect((await middleware(req("/admin", "session=abc"))).status).toBe(307);
  });

  it("păstrează requestId-ul primit și nu atinge paginile publice", async () => {
    const res = await middleware(
      new NextRequest("http://localhost:3000/", { headers: { "x-request-id": "req-12345678" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-12345678");
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("middleware: mentenanță", () => {
  const closed = createMiddleware({ isInMaintenance: async () => true });
  const probeCalls: string[] = [];
  const spy = createMiddleware({
    isInMaintenance: async (origin) => {
      probeCalls.push(origin);
      return true;
    },
  });

  it("vitrina primește pagina de mentenanță: rescriere spre /mentenanta, status 503, Retry-After, fără cache", async () => {
    for (const path of ["/", "/produs/pompa", "/categorie/a/b?x=1", "/mentenanta"]) {
      const res = await closed(req(path));
      expect(res.status, path).toBe(503);
      expect(res.headers.get("retry-after"), path).toBe("3600");
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("x-middleware-rewrite"), path).toContain("/mentenanta");
      expect(res.headers.get("x-request-id"), path).toBeTruthy();
    }
  });

  it("contul clientului (cu sesiune) e blocat în mentenanță; fără sesiune trimite la autentificare, care rămâne accesibilă", async () => {
    expect((await closed(req("/cont", "better-auth.session_token=abc.def"))).status).toBe(503);
    expect((await closed(req("/cont"))).status).toBe(307);
  });

  it("adminul, API-ul, autentificarea, tema și media rămân accesibile și nici nu declanșează citirea flagului", async () => {
    probeCalls.length = 0;
    for (const path of [
      "/admin",
      "/admin/setari/mentenanta",
      "/api/health",
      "/autentificare",
      "/theme.css",
      "/media/a.webp",
    ]) {
      const res = await spy(req(path, "better-auth.session_token=abc.def"));
      expect(res.status, path).not.toBe(503);
    }
    expect(probeCalls).toEqual([]);
  });

  it("fără sesiune, /admin tot trimite la autentificare (mentenanța nu o înlocuiește)", async () => {
    const res = await closed(req("/admin"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/autentificare");
  });

  it("citirea flagului primește originea cererii", async () => {
    probeCalls.length = 0;
    await spy(req("/"));
    expect(probeCalls).toEqual(["http://localhost:3000"]);
  });

  it("magazinul deschis: pagina publică trece neschimbată", async () => {
    const res = await middleware(req("/produs/pompa"));
    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBeNull();
  });
});
