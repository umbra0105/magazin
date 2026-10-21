import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { purgeStaleAuthRecords } from "./retention";

/**
 * Blocul C, C-02, pe Postgres real: conturile neverificate și rândurile `verification` expirate nu se strâng la nesfârșit
 * (înregistrări în masă cu emailuri inventate). Se șterg DOAR conturile neverificate, fără roluri, mai vechi decât termenul,
 * și doar dacă verificarea emailului e cerută (altfel conturile neverificate sunt conturi obișnuite).
 */

const db = getDb();
const RUN = randomBytes(4).toString("hex");
const DAY = 24 * 3600 * 1000;
const now = new Date("2026-10-21T10:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

afterAll(async () => {
  await db.user.deleteMany({ where: { email: { startsWith: `ret-${RUN}` } } });
  await db.verification.deleteMany({ where: { identifier: { startsWith: `ret-${RUN}` } } });
  await db.$disconnect();
});

async function user(name: string, over: { emailVerified?: boolean; createdAt?: Date } = {}) {
  return db.user.create({
    data: {
      id: `ret-${RUN}-${name}`,
      name,
      email: `ret-${RUN}-${name}@test.invalid`,
      emailVerified: over.emailVerified ?? false,
      createdAt: over.createdAt ?? ago(30),
    },
  });
}
const exists = async (name: string) =>
  (await db.user.count({ where: { id: `ret-${RUN}-${name}` } })) === 1;

const defaults = {
  now,
  requireEmailVerification: true,
  unverifiedAccountDays: 7,
  emailVerificationHours: 24,
};

describe("purgeStaleAuthRecords (Postgres real)", () => {
  it("șterge conturile neverificate vechi, fără roluri; păstrează restul", async () => {
    await user("vechi-neverificat");
    await user("recent-neverificat", { createdAt: ago(2) });
    await user("vechi-verificat", { emailVerified: true });
    const staff = await user("vechi-cu-rol");
    const role = await db.role.findFirst();
    if (role) await db.userRole.create({ data: { userId: staff.id, roleId: role.id } });

    const result = await purgeStaleAuthRecords(db, defaults);

    expect(result.users).toBeGreaterThanOrEqual(1);
    expect(await exists("vechi-neverificat")).toBe(false);
    expect(await exists("recent-neverificat")).toBe(true);
    expect(await exists("vechi-verificat")).toBe(true);
    // un cont cu rol nu se șterge niciodată (dacă baza de test nu are roluri, contul nu are rol)
    if (role) expect(await exists("vechi-cu-rol")).toBe(true);
  });

  it("fără verificarea emailului cerută, conturile neverificate sunt conturi obișnuite: nu se șterge niciunul", async () => {
    await user("fara-verificare-vechi");
    const result = await purgeStaleAuthRecords(db, {
      ...defaults,
      requireEmailVerification: false,
    });
    expect(result.users).toBe(0);
    expect(await exists("fara-verificare-vechi")).toBe(true);
  });

  it("termenul efectiv nu e mai scurt decât valabilitatea linkului de verificare plus 24 h", async () => {
    await user("link-inca-valabil", { createdAt: new Date(now.getTime() - 2 * DAY - 3600_000) });
    await purgeStaleAuthRecords(db, {
      ...defaults,
      unverifiedAccountDays: 2, // 48 h, dar linkul e valabil 72 h: se așteaptă 96 h
      emailVerificationHours: 72,
    });
    expect(await exists("link-inca-valabil")).toBe(true);
  });

  it("șterge rândurile verification expirate de mai mult de o zi; păstrează cele valabile sau recent expirate", async () => {
    const mk = (id: string, expiresAt: Date) =>
      db.verification.create({
        data: { id: `ret-${RUN}-${id}`, identifier: `ret-${RUN}-${id}`, value: "x", expiresAt },
      });
    await mk("expirat-demult", ago(3));
    await mk("expirat-recent", new Date(now.getTime() - 3600_000));
    await mk("valabil", new Date(now.getTime() + 3600_000));
    const result = await purgeStaleAuthRecords(db, defaults);
    expect(result.verifications).toBeGreaterThanOrEqual(1);
    const left = (
      await db.verification.findMany({ where: { identifier: { startsWith: `ret-${RUN}` } } })
    )
      .map((v) => v.id.replace(`ret-${RUN}-`, ""))
      .sort();
    expect(left).toEqual(["expirat-recent", "valabil"]);
  });
});
