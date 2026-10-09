import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "./middleware";

const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie } } : undefined);

describe("middleware", () => {
  it("/admin fără cookie => 307 la /autentificare?next=/admin, cu requestId și fără cache", () => {
    const res = middleware(req("/admin/produse?x=1"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/autentificare");
    expect(location.searchParams.get("next")).toBe("/admin/produse?x=1");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("/cont fără cookie => redirect", () => {
    expect(middleware(req("/cont")).status).toBe(307);
  });

  it("/api/admin/* fără cookie => 401 JSON cu cod stabil", async () => {
    const res = middleware(req("/api/admin/export"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "AUTH_UNAUTHENTICATED", message: "Autentificarea este necesară" },
    });
  });

  it("cu cookie-ul de sesiune Better Auth (și varianta __Secure-) trece", () => {
    for (const cookie of [
      "better-auth.session_token=abc.def",
      "__Secure-better-auth.session_token=abc.def",
    ]) {
      const res = middleware(req("/admin", cookie));
      expect(res.status, cookie).toBe(200);
      expect(res.headers.get("x-request-id")).toBeTruthy();
    }
  });

  it("un cookie cu alt nume nu deschide admin-ul", () => {
    expect(middleware(req("/admin", "session=abc")).status).toBe(307);
  });

  it("păstrează requestId-ul primit și nu atinge paginile publice", () => {
    const res = middleware(
      new NextRequest("http://localhost:3000/", { headers: { "x-request-id": "req-12345678" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-12345678");
    expect(res.headers.get("cache-control")).toBeNull();
  });
});
