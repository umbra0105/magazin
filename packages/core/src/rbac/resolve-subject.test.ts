import { describe, expect, it } from "vitest";
import { isAdminSessionExpired } from "../auth/session-policy";
import type { PermissionSubject } from "./can";
import { resolveSubject } from "./resolve-subject";

const NOW = new Date("2026-10-09T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const admin: PermissionSubject = {
  userId: "a",
  email: "a@test.invalid",
  roles: ["support"],
  permissions: new Set(["admin.access", "orders.read"]),
};
const customer: PermissionSubject = { ...admin, userId: "c", roles: [], permissions: new Set() };

const deps = (subject: PermissionSubject | null, adminSessionHours = 8) => ({
  permissions: { loadSubject: async () => subject },
  adminSessionHours,
  now: NOW,
});

describe("isAdminSessionExpired", () => {
  it("expiră exact la limită, nu înainte", () => {
    expect(isAdminSessionExpired(hoursAgo(7.99), 8, NOW)).toBe(false);
    expect(isAdminSessionExpired(hoursAgo(8), 8, NOW)).toBe(true);
    expect(isAdminSessionExpired(hoursAgo(30), 8, NOW)).toBe(true);
  });
});

describe("resolveSubject", () => {
  it("sesiune de admin mai veche decât adminSessionHours => refuzată", async () => {
    const r = await resolveSubject(deps(admin), { userId: "a", createdAt: hoursAgo(9) });
    expect(r).toEqual({ status: "admin-session-expired" });
  });

  it("sesiune de admin mai nouă decât limita => acceptată", async () => {
    const r = await resolveSubject(deps(admin), { userId: "a", createdAt: hoursAgo(7) });
    expect(r).toEqual({ status: "ok", subject: admin });
  });

  it("limita vine din setare: cu 24h, o sesiune de 9h e încă bună", async () => {
    const r = await resolveSubject(deps(admin, 24), { userId: "a", createdAt: hoursAgo(9) });
    expect(r.status).toBe("ok");
  });

  it("un client (fără roluri) NU e afectat de limita de admin", async () => {
    const r = await resolveSubject(deps(customer), { userId: "c", createdAt: hoursAgo(200) });
    expect(r.status).toBe("ok");
  });

  it("un rol fără admin.access nu e cont de admin: limita scurtă nu i se aplică", async () => {
    const noAccess: PermissionSubject = { ...admin, permissions: new Set(["orders.read"]) };
    const r = await resolveSubject(deps(noAccess), { userId: "a", createdAt: hoursAgo(200) });
    expect(r.status).toBe("ok");
  });

  it("fără sesiune sau cu utilizator șters => no-session", async () => {
    expect(await resolveSubject(deps(admin), null)).toEqual({ status: "no-session" });
    expect(await resolveSubject(deps(null), { userId: "x", createdAt: hoursAgo(1) })).toEqual({
      status: "no-session",
    });
  });
});
