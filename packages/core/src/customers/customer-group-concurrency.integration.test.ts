import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createPrismaCustomerGroupStore } from "./customer-group-store";

/**
 * Concurența pe Postgres REAL, cu date comise (conexiuni separate), scrisă odată cu atribuirea în masă. Nu trece prin serviciu
 * (care scrie în `audit_log`, imuabil): testează depozitul, adică exact instrucțiunile SQL care apără invariantele. Datele proprii
 * se șterg la final (utilizatorii, apoi grupurile).
 */
const db = getDb();
const store = createPrismaCustomerGroupStore(db);
const tag = randomUUID().slice(0, 8);
const userIds: string[] = [];
const groupIds: string[] = [];

const uid = (): string => randomUUID().slice(0, 8);

async function makeGroup(extra: Record<string, unknown> = {}): Promise<string> {
  const row = await db.customerGroup.create({
    data: {
      name: `Conc ${tag} ${uid()}`,
      slug: `conc-${tag}-${uid()}`,
      pricingType: "discount",
      discountBps: 500,
      ...extra,
    } as never,
  });
  groupIds.push(row.id);
  return row.id;
}

async function makeUsers(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const user = await db.user.create({
      data: {
        id: `uc_${tag}_${uid()}`,
        name: `Conc ${i}`,
        email: `conc-${tag}-${uid()}@exemplu.test`,
        emailVerified: true,
      },
    });
    ids.push(user.id);
    userIds.push(user.id);
  }
  return ids;
}

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.customerGroup.deleteMany({ where: { id: { in: groupIds } } });
  await db.$disconnect();
});

describe("atribuiri în masă simultane", () => {
  it("două atribuiri pe aceiași clienți: toți ajung în același grup, iar «grupul de dinainte» e coerent", async () => {
    for (let round = 0; round < 8; round += 1) {
      const [a, b] = [await makeGroup(), await makeGroup()];
      const users = await makeUsers(24);
      const [outA, outB] = await Promise.all([
        store.assign(users, a),
        store.assign(users.toReversed(), b),
      ]);
      if (outA === "group_inactive" || outB === "group_inactive") throw new Error("grup inactiv");
      expect(outA.moved).toHaveLength(24);
      expect(outB.moved).toHaveLength(24);
      const rows = await db.user.findMany({ where: { id: { in: users } } });
      const finals = new Set(rows.map((row) => row.customerGroupId));
      // o singură valoare finală: cea a atribuirii care a rulat ultima; niciun amestec
      expect(finals.size).toBe(1);
      const last = [...finals][0] as string;
      const first = last === a ? outB : outA;
      const second = last === a ? outA : outB;
      // cea de-a doua vede grupul pus de prima; prima vede «fără grup»
      expect(new Set(first.moved.map((m) => m.previousGroupId))).toEqual(new Set([null]));
      expect(new Set(second.moved.map((m) => m.previousGroupId))).toEqual(
        new Set([last === a ? b : a]),
      );
    }
  });

  it("ordinea diferită a id-urilor nu produce blocaje încrucișate (zeci de atribuiri deodată)", async () => {
    const group = await makeGroup();
    const users = await makeUsers(30);
    const runs = Array.from({ length: 12 }, (_, i) =>
      store.assign(i % 2 === 0 ? users : users.toReversed(), group),
    );
    const outcomes = await Promise.all(runs);
    for (const outcome of outcomes) expect(outcome).not.toBe("group_inactive");
    const rows = await db.user.findMany({ where: { id: { in: users } } });
    expect(rows.every((row) => row.customerGroupId === group)).toBe(true);
  });
});

describe("atribuire față de dezactivarea și ștergerea grupului", () => {
  it("niciodată un grup dezactivat cu clienți în el", async () => {
    for (let round = 0; round < 25; round += 1) {
      const group = await makeGroup();
      const [user] = await makeUsers(1);
      const [assigned, deactivated] = await Promise.all([
        store.assign([user as string], group),
        store.deactivateIfEmpty(group),
      ]);
      const row = await db.customerGroup.findUniqueOrThrow({ where: { id: group } });
      const members = await db.user.count({ where: { customerGroupId: group } });
      // invariant: grup dezactivat => fără clienți
      expect(!row.isActive && members > 0).toBe(false);
      if (deactivated === "deactivated")
        expect(assigned === "group_inactive" || members === 0).toBe(true);
      if (assigned !== "group_inactive") expect(members).toBe(1);
    }
  });

  it("un grup nu se șterge sub o atribuire simultană (nici un client rămas cu un grup inexistent)", async () => {
    for (let round = 0; round < 25; round += 1) {
      const group = await makeGroup();
      const [user] = await makeUsers(1);
      const [assigned, deleted] = await Promise.allSettled([
        store.assign([user as string], group),
        store.deleteUnused(group),
      ]);
      const stored = await db.user.findUniqueOrThrow({ where: { id: user as string } });
      const exists = (await db.customerGroup.count({ where: { id: group } })) === 1;
      // clientul nu poate indica un grup care nu mai există
      expect(stored.customerGroupId === null || exists).toBe(true);
      if (deleted.status === "fulfilled" && deleted.value === "deleted") {
        expect(exists).toBe(false);
        expect(stored.customerGroupId).toBeNull();
      }
      expect(assigned.status === "fulfilled" || assigned.status === "rejected").toBe(true);
    }
  });
});
