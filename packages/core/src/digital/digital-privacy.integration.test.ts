import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { anonymizeAccount } from "../account/account-delete";
import { buildAccountExport } from "../account/account-export";
import { transitionOrder } from "../orders/order-service";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { createFile, digitalFixture } from "../test-utils/digital-fixtures";
import {
  anonymizeAccessLogs,
  buildDigitalExport,
  purgeExpiredAccessLogData,
} from "./digital-privacy";

/**
 * Faza 14b, datele personale ale produselor digitale: IP-ul și user-agent-ul din jurnal se anonimizează la ștergerea contului,
 * se curăță după termenul din setare (cu ceas injectat) și nu apar în exportul GDPR; exportul include achizițiile și accesările
 * proprii, fără cheie de stocare, fără jeton și fără datele altor clienți.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const NOW = new Date(Date.now() + 5_000);
const DAY = 86_400_000;

async function withLogs(tx: TestTx, ageDays = 0) {
  const f = await digitalFixture(tx);
  await transitionOrder(
    tx,
    f.orderId,
    { status: "confirmed", paymentStatus: "paid" },
    { type: "payment.confirmed", message: "plătită" },
    NOW,
  );
  const ent = await tx.digitalEntitlement.findFirstOrThrow({ where: { orderId: f.orderId } });
  const file = await createFile(tx, f.digitalProductIds[0] as string, { title: "Lecția 1" });
  const log = await tx.digitalAccessLog.create({
    data: {
      entitlementId: ent.id,
      assetId: file.id,
      action: "download",
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0 (test)",
      createdAt: new Date(NOW.getTime() - ageDays * DAY),
    },
  });
  return { f, ent, file, log };
}

describe("anonimizarea jurnalului la ștergerea contului", () => {
  it("anonymizeAccessLogs golește IP și user-agent DOAR pentru clientul dat; rândul rămâne", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await withLogs(tx);
      const b = await withLogs(tx);
      expect(await anonymizeAccessLogs(tx, a.f.userId)).toBe(1);
      const logA = await tx.digitalAccessLog.findUniqueOrThrow({ where: { id: a.log.id } });
      const logB = await tx.digitalAccessLog.findUniqueOrThrow({ where: { id: b.log.id } });
      expect(logA).toMatchObject({ ip: null, userAgent: null, action: "download" });
      expect(logB).toMatchObject({ ip: "203.0.113.7", userAgent: "Mozilla/5.0 (test)" });
      // a doua rulare nu mai are ce curăța
      expect(await anonymizeAccessLogs(tx, a.f.userId)).toBe(0);
    });
  });

  it("ștergerea contului (anonymizeAccount) anonimizează jurnalul clientului", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, log } = await withLogs(tx);
      // contul nu se poate șterge cât are comenzi nefinalizate: comanda se încheie întâi
      await transitionOrder(
        tx,
        f.orderId,
        { status: "processing" },
        { type: "order.processing", message: "în procesare" },
        NOW,
      );
      await transitionOrder(
        tx,
        f.orderId,
        { status: "completed" },
        { type: "order.completed", message: "încheiată" },
        NOW,
      );
      await anonymizeAccount(tx, { id: f.userId, email: f.userEmail, emailVerified: true }, NOW);
      const after = await tx.digitalAccessLog.findUniqueOrThrow({ where: { id: log.id } });
      expect(after).toMatchObject({ ip: null, userAgent: null });
      // dreptul și comanda rămân (obligație fiscală), dar IP-ul nu mai există nicăieri în jurnal
      expect(await tx.digitalEntitlement.count({ where: { orderId: f.orderId } })).toBe(1);
      expect(
        await tx.digitalAccessLog.count({
          where: { ip: { not: null }, entitlement: { customerId: f.userId } },
        }),
      ).toBe(0);
    });
  });
});

describe("termenul de păstrare (setare, ceas injectat)", () => {
  it("rândurile mai vechi decât termenul își pierd IP-ul și user-agent-ul; cele mai noi rămân", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await tx.setting.upsert({
        where: { key: "digital.accessLogRetentionDays" },
        update: { value: 30 },
        create: { key: "digital.accessLogRetentionDays", group: "digital", value: 30 },
      });
      const old = await withLogs(tx, 31);
      const recent = await withLogs(tx, 29);
      const purged = await purgeExpiredAccessLogData(tx, NOW);
      expect(purged).toBeGreaterThanOrEqual(1);
      expect(
        await tx.digitalAccessLog.findUniqueOrThrow({ where: { id: old.log.id } }),
      ).toMatchObject({ ip: null, userAgent: null });
      expect(
        await tx.digitalAccessLog.findUniqueOrThrow({ where: { id: recent.log.id } }),
      ).toMatchObject({ ip: "203.0.113.7" });
    });
  });

  it("fără setare, termenul implicit (180 de zile) se aplică", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await tx.setting.deleteMany({ where: { key: "digital.accessLogRetentionDays" } });
      const old = await withLogs(tx, 181);
      const recent = await withLogs(tx, 179);
      await purgeExpiredAccessLogData(tx, NOW);
      expect(
        (await tx.digitalAccessLog.findUniqueOrThrow({ where: { id: old.log.id } })).ip,
      ).toBeNull();
      expect(
        (await tx.digitalAccessLog.findUniqueOrThrow({ where: { id: recent.log.id } })).ip,
      ).toBe("203.0.113.7");
    });
  });

  it("o setare stricată cade pe valoarea implicită, nu blochează curățarea", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await tx.setting.upsert({
        where: { key: "digital.accessLogRetentionDays" },
        update: { value: "nu-e-numar" },
        create: { key: "digital.accessLogRetentionDays", group: "digital", value: "nu-e-numar" },
      });
      const old = await withLogs(tx, 200);
      await purgeExpiredAccessLogData(tx, NOW);
      expect(
        (await tx.digitalAccessLog.findUniqueOrThrow({ where: { id: old.log.id } })).ip,
      ).toBeNull();
    });
  });
});

describe("exportul GDPR", () => {
  it("include achizițiile și accesările proprii, fără cheie de stocare, jeton, IP sau user-agent", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const mine = await withLogs(tx);
      const other = await withLogs(tx);
      const digital = await buildDigitalExport(tx, mine.f.userId);
      expect(digital.purchases).toHaveLength(1);
      expect(digital.purchases[0]).toMatchObject({
        orderNumber: mine.f.orderNumber,
        status: "activ",
        accesses: [{ action: "descărcare", module: "Lecția 1" }],
      });
      const json = JSON.stringify(digital);
      expect(json).not.toContain(mine.file.storageKey ?? "x");
      expect(json).not.toContain("private/digital");
      expect(json).not.toContain(mine.ent.accessToken);
      expect(json).not.toContain("203.0.113.7");
      expect(json).not.toContain("Mozilla");
      expect(json).not.toContain(other.f.orderNumber);
      expect(json).not.toContain(other.ent.accessToken);
    });
  });

  it("exportul complet al contului conține achizițiile digitale", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f } = await withLogs(tx);
      const everything = await buildAccountExport(
        tx,
        { id: f.userId, email: f.userEmail, emailVerified: true },
        NOW,
      );
      const purchases = everything["digitalPurchases"] as Array<{ orderNumber: string }>;
      expect(purchases.map((p) => p.orderNumber)).toEqual([f.orderNumber]);
      expect(JSON.stringify(everything)).not.toContain("private/digital");
    });
  });

  it("un drept retras apare ca «retras», cu motivul", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await withLogs(tx);
      await tx.digitalEntitlement.update({
        where: { id: ent.id },
        data: { revokedAt: NOW, revokedReason: "Rambursat" },
      });
      const digital = await buildDigitalExport(tx, f.userId);
      expect(digital.purchases[0]).toMatchObject({ status: "retras", revokedReason: "Rambursat" });
    });
  });
});
