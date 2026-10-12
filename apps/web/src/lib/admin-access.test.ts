import { describe, expect, it } from "vitest";
import { isAdminSessionExpired, resolveSubject, type PermissionSubject } from "@ecom/core";
import { decideAdminAccess } from "./admin-access";

const owner: PermissionSubject = {
  userId: "o",
  email: "o@test.invalid",
  roles: ["owner"],
  permissions: new Set(),
};
const support: PermissionSubject = {
  userId: "s",
  email: "s@test.invalid",
  roles: ["support"],
  permissions: new Set(["admin.access", "orders.read"]),
};
const customer: PermissionSubject = {
  userId: "c",
  email: "c@test.invalid",
  roles: [],
  permissions: new Set(),
};
const roleWithoutAccess: PermissionSubject = {
  userId: "r",
  email: "r@test.invalid",
  roles: ["rol-personalizat"],
  permissions: new Set(["orders.read", "orders.write"]),
};

describe("decideAdminAccess", () => {
  it("fără sesiune → autentificare cu ?next", () => {
    expect(decideAdminAccess({ status: "no-session" }, "/admin/comenzi?pagina=2")).toEqual({
      kind: "redirect",
      reason: "no-session",
      location: "/autentificare?next=%2Fadmin%2Fcomenzi%3Fpagina%3D2",
    });
  });

  it("sesiune de admin expirată → autentificare cu marcajul „Sesiunea a expirat” și ?next", () => {
    expect(decideAdminAccess({ status: "admin-session-expired" }, "/admin/produse")).toEqual({
      kind: "redirect",
      reason: "session-expired",
      location: "/autentificare?sesiune=expirata&next=%2Fadmin%2Fprodus%65".replace("%65", "e"),
    });
  });

  it("un ?next nesigur sau lipsă nu ajunge în adresă", () => {
    for (const bad of ["https://evil.example/", "//evil.example", null, ""]) {
      const d = decideAdminAccess({ status: "no-session" }, bad);
      expect(d).toMatchObject({ kind: "redirect", location: "/autentificare" });
    }
  });

  it("Owner și rolurile cu admin.access intră", () => {
    expect(decideAdminAccess({ status: "ok", subject: owner }, "/admin")).toMatchObject({
      kind: "allow",
    });
    expect(decideAdminAccess({ status: "ok", subject: support }, "/admin")).toMatchObject({
      kind: "allow",
    });
  });

  it("clientul fără roluri NU intră", () => {
    expect(decideAdminAccess({ status: "ok", subject: customer }, "/admin")).toEqual({
      kind: "denied",
      reason: "no-admin-access",
    });
  });

  it("un utilizator cu un rol fără admin.access NU intră, deși are alte permisiuni", () => {
    expect(decideAdminAccess({ status: "ok", subject: roleWithoutAccess }, "/admin")).toEqual({
      kind: "denied",
      reason: "no-admin-access",
    });
  });
});

describe("adminSessionHours: sesiunea mai veche decât limita e refuzată și duce la autentificare", () => {
  const NOW = new Date("2026-10-12T12:00:00Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  const run = async (subject: PermissionSubject, ageHours: number, limit = 8) => {
    const resolution = await resolveSubject(
      { permissions: { loadSubject: async () => subject }, adminSessionHours: limit, now: NOW },
      { userId: subject.userId, createdAt: hoursAgo(ageHours) },
    );
    return decideAdminAccess(resolution, "/admin/comenzi");
  };

  it("admin cu sesiune de 9h (limita 8h) → redirect la autentificare cu „expirata”", async () => {
    const d = await run(support, 9);
    expect(d).toMatchObject({ kind: "redirect", reason: "session-expired" });
    expect((d as { location: string }).location).toBe(
      "/autentificare?sesiune=expirata&next=%2Fadmin%2Fcomenzi",
    );
  });

  it("aceeași sesiune la 7h este acceptată", async () => {
    expect((await run(support, 7)).kind).toBe("allow");
  });

  it("Owner e supus aceleiași limite", async () => {
    expect(await run(owner, 8.5)).toMatchObject({ kind: "redirect", reason: "session-expired" });
  });

  it("un client cu sesiune veche nu e „expirat” (limita scurtă e doar pentru admin) dar nu intră", async () => {
    expect(await run(customer, 300)).toEqual({ kind: "denied", reason: "no-admin-access" });
    expect(isAdminSessionExpired(hoursAgo(300), 8, NOW)).toBe(true); // pentru contrast
  });
});
