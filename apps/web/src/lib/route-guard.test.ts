import { describe, expect, it } from "vitest";
import { guardDecision, isProtectedApi, isProtectedPage, safeNextPath } from "./route-guard";

const anon = (pathname: string, search = "") =>
  guardDecision({ pathname, search, hasSessionCookie: false });

describe("guardDecision", () => {
  it("vizitator fără cookie pe /admin și /cont => redirect la autentificare cu ?next", () => {
    expect(anon("/admin")).toEqual({
      action: "redirect",
      location: "/autentificare?next=%2Fadmin",
    });
    expect(anon("/admin/produse", "?pagina=2")).toEqual({
      action: "redirect",
      location: "/autentificare?next=%2Fadmin%2Fproduse%3Fpagina%3D2",
    });
    expect(anon("/cont/comenzi").action).toBe("redirect");
  });

  it("API-ul de admin fără cookie => 401, nu redirect", () => {
    expect(anon("/api/admin/export")).toEqual({ action: "unauthorized" });
  });

  it("cu cookie de sesiune lasă cererea să treacă (verificarea reală e pe server)", () => {
    for (const p of ["/admin", "/admin/x", "/cont", "/api/admin/x"]) {
      expect(guardDecision({ pathname: p, search: "", hasSessionCookie: true })).toEqual({
        action: "next",
      });
    }
  });

  it("paginile publice nu sunt afectate", () => {
    for (const p of [
      "/",
      "/autentificare",
      "/inregistrare",
      "/api/health",
      "/api/auth/sign-in/email",
    ]) {
      expect(anon(p)).toEqual({ action: "next" });
    }
  });

  it("nu confundă prefixe: /administrare, /contact, /conturi, /api/administrator", () => {
    for (const p of ["/administrare", "/contact", "/conturi", "/api/administrator"]) {
      expect(isProtectedPage(p), p).toBe(false);
      expect(isProtectedApi(p), p).toBe(false);
      expect(anon(p)).toEqual({ action: "next" });
    }
  });
});

describe("safeNextPath", () => {
  it("acceptă căi relative din același site", () => {
    expect(safeNextPath("/admin/produse?x=1")).toBe("/admin/produse?x=1");
    expect(safeNextPath("/cont")).toBe("/cont");
  });

  it("respinge redirecturi către alte site-uri sau forme ambigue", () => {
    for (const bad of [
      "https://evil.example/",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "admin",
      "",
      null,
      undefined,
      "/admin\r\nSet-Cookie: x=1",
      "/a\\b",
    ]) {
      expect(safeNextPath(bad), String(bad)).toBeNull();
    }
  });

  it("nu face buclă înapoi la pagina de autentificare", () => {
    expect(safeNextPath("/autentificare")).toBeNull();
    expect(safeNextPath("/autentificare?next=/admin")).toBeNull();
  });
});
