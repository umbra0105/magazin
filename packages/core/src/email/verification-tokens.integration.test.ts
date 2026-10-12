import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { EmailVerificationService } from "./verification-tokens";

const db = getDb();
const RUN = randomBytes(4).toString("hex");
const userIds: string[] = [];

async function newUser(verified = false) {
  const id = `ev-${RUN}-${userIds.length}`;
  userIds.push(id);
  await db.user.create({
    data: { id, name: "Test", email: `${id}@test.invalid`, emailVerified: verified },
  });
  return id;
}

const isVerified = async (id: string) =>
  (await db.user.findUniqueOrThrow({ where: { id } })).emailVerified;

describe("EmailVerificationService (baza de test)", () => {
  afterAll(async () => {
    await db.verification.deleteMany({
      where: { identifier: { in: userIds.map((i) => `ecom:verify-email:${i}`) } },
    });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  });

  it("tokenul verifică emailul, o singură dată: a doua folosire e respinsă", async () => {
    const id = await newUser();
    const service = new EmailVerificationService(db);
    const token = await service.issue(id, 24);

    expect(await isVerified(id)).toBe(false);
    expect(await service.consume(token)).toEqual({ status: "verified", userId: id });
    expect(await isVerified(id)).toBe(true);
    expect(await service.consume(token)).toEqual({ status: "invalid" });
  });

  it("valabil 24 de ore: expiră la termen, după care e respins (și șters)", async () => {
    const id = await newUser();
    const service = new EmailVerificationService(db);
    const issuedAt = new Date("2026-10-12T10:00:00Z");
    const token = await service.issue(id, 24, issuedAt);

    const row = await db.verification.findFirstOrThrow({
      where: { identifier: `ecom:verify-email:${id}` },
    });
    expect(row.expiresAt.toISOString()).toBe("2026-10-13T10:00:00.000Z");

    // Cu o secundă înainte de termen ar fi valid; la termen e expirat.
    const expired = await service.consume(token, new Date("2026-10-13T10:00:00Z"));
    expect(expired).toEqual({ status: "invalid" });
    expect(await isVerified(id)).toBe(false);
    expect(await service.consume(token)).toEqual({ status: "invalid" });
  });

  it("chiar înainte de expirare tokenul e valid", async () => {
    const id = await newUser();
    const service = new EmailVerificationService(db);
    const token = await service.issue(id, 24, new Date("2026-10-12T10:00:00Z"));
    const result = await service.consume(token, new Date("2026-10-13T09:59:59Z"));
    expect(result).toEqual({ status: "verified", userId: id });
  });

  it("în baza de date stă doar hash-ul, nu tokenul", async () => {
    const id = await newUser();
    const token = await new EmailVerificationService(db).issue(id, 24);
    const row = await db.verification.findFirstOrThrow({
      where: { identifier: `ecom:verify-email:${id}` },
    });
    expect(row.value).not.toBe(token);
    expect(row.value).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("un token nou îl invalidează pe cel vechi", async () => {
    const id = await newUser();
    const service = new EmailVerificationService(db);
    const first = await service.issue(id, 24);
    const second = await service.issue(id, 24);
    expect(await service.consume(first)).toEqual({ status: "invalid" });
    expect(await service.consume(second)).toEqual({ status: "verified", userId: id });
  });

  it("două cereri simultane cu același token: exact una reușește", async () => {
    const id = await newUser();
    const service = new EmailVerificationService(db);
    const token = await service.issue(id, 24);
    const results = await Promise.all([service.consume(token), service.consume(token)]);
    expect(results.filter((r) => r.status === "verified")).toHaveLength(1);
    expect(results.filter((r) => r.status === "invalid")).toHaveLength(1);
  });

  it("tokenuri inventate sau malformate => invalid, fără erori", async () => {
    const service = new EmailVerificationService(db);
    for (const bad of ["", "scurt", "x".repeat(600), randomBytes(32).toString("base64url")]) {
      expect(await service.consume(bad)).toEqual({ status: "invalid" });
    }
  });

  it("un token de resetare (alt prefix în `verification`) nu verifică emailul", async () => {
    const id = await newUser();
    const resetToken = randomBytes(32).toString("base64url");
    await db.verification.create({
      data: {
        id: randomBytes(8).toString("hex"),
        identifier: `reset-password:${resetToken}`,
        value: id,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    expect(await new EmailVerificationService(db).consume(resetToken)).toEqual({
      status: "invalid",
    });
    expect(await isVerified(id)).toBe(false);
    await db.verification.deleteMany({ where: { identifier: `reset-password:${resetToken}` } });
  });
});
