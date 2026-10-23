import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { parseQuantity, type Quantity } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { runBaseSeed } from "../seed/base-seed";
import { MemoryAudit } from "../test-utils/memory-audit";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  addStockProduct,
  createStockContext,
  type ProductSpec,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { StockMaintenance } from "./stock-maintenance";
import { StockService } from "./stock-service";
import { reservationExpiresAt } from "./workdays";

/**
 * Faza 5, punctul 7: mentenanța stocului (expirarea rezervărilor, prospețimea pozei, curățarea cererilor «Anunță-mă»).
 * Logica deterministă rulează pe baza reală în tranzacție anulată; idempotența la instanțe simultane, pe date comise.
 * Testul nu presupune seed: depozitul implicit îl creează `runBaseSeed`, restul testul.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const q = (text: string): Quantity => parseQuantity(text);
const T0 = new Date("2026-10-22T10:00:00Z");
const minutes = (base: Date, n: number): Date => new Date(base.getTime() + n * 60_000);
const hours = (base: Date, n: number): Date => new Date(base.getTime() + n * 3_600_000);
const days = (base: Date, n: number): Date => new Date(base.getTime() + n * 86_400_000);

interface Harness {
  tx: TestTx;
  ctx: StockContext;
  stock: StockService;
  maintenance: StockMaintenance;
  audit: MemoryAudit;
  setClock: (date: Date) => void;
  product: (physical: string | null, spec?: ProductSpec) => Promise<{ id: string; sku: string }>;
  ref: (name: string) => { refType: string; refId: string };
  reserveUntil: (
    variantId: string,
    quantity: string,
    name: string,
    expiresAt: Date,
  ) => Promise<void>;
  item: (variantId: string) => Promise<{ physical: bigint; committed: bigint; reserved: bigint }>;
  statuses: (variantId: string) => Promise<string[]>;
  snapshot: (takenAt: Date) => Promise<string>;
}

async function withStock<T>(
  fn: (h: Harness) => Promise<T>,
  options: { batchSize?: number } = {},
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const ctx = await createStockContext(tx, { useDefaultWarehouse: true });
    let clock = T0;
    const audit = new MemoryAudit();
    audit.clock = () => clock;
    const stock = new StockService({ db: tx, now: () => clock });
    const maintenance = new StockMaintenance({
      db: tx,
      audit: new AuditService(audit),
      now: () => clock,
      ...(options.batchSize !== undefined && { batchSize: options.batchSize }),
    });
    const h: Harness = {
      tx,
      ctx,
      stock,
      maintenance,
      audit,
      setClock: (date) => {
        clock = date;
      },
      product: async (physical, spec = {}) => {
        const created = await addStockProduct(tx, ctx, { ...spec, variants: [{ physical }] });
        return created.variants[0]!;
      },
      ref: (name) => ({ refType: "order", refId: `${ctx.tag}-${name}` }),
      reserveUntil: async (variantId, quantity, name, expiresAt) => {
        await stock.reserve(h.ref(name), [{ variantId, quantity: q(quantity) }], expiresAt);
      },
      item: async (variantId) =>
        tx.inventoryItem.findUniqueOrThrow({
          where: { variantId_warehouseId: { variantId, warehouseId: ctx.warehouseId } },
          select: { physical: true, committed: true, reserved: true },
        }),
      statuses: async (variantId) =>
        (
          await tx.stockReservation.findMany({ where: { variantId }, orderBy: { refId: "asc" } })
        ).map((r) => r.status),
      snapshot: async (takenAt) => {
        const row = await tx.stockSnapshot.create({
          data: { warehouseId: ctx.warehouseId, takenAt, source: "import" },
        });
        return row.id;
      },
    };
    return fn(h);
  });
}

describe("expirarea rezervărilor", () => {
  it("o rezervare cu termenul trecut se eliberează singură; disponibilitatea revine (proba din plan: 1 minut)", async () => {
    await withStock(async (h) => {
      const p = await h.product("5");
      await h.reserveUntil(p.id, "2", "a", minutes(T0, 1));
      expect((await h.item(p.id)).reserved).toBe(q("2"));
      h.setClock(minutes(T0, 2));
      const result = await h.maintenance.expireReservations();
      expect(result).toEqual({ expired: 1, batches: 1, complete: true });
      expect((await h.item(p.id)).reserved).toBe(0n);
      expect(await h.statuses(p.id)).toEqual(["expired"]);
      expect((await h.stock.checkConsistency(p.id)).ok).toBe(true);
    });
  });

  it("nu atinge ce nu a expirat: rezervări viitoare, confirmate sau deja eliberate", async () => {
    await withStock(async (h) => {
      const p = await h.product("10");
      await h.reserveUntil(p.id, "1", "1-viitor", minutes(T0, 15));
      await h.reserveUntil(p.id, "1", "2-platita", minutes(T0, 1));
      await h.stock.confirmReservation(h.ref("2-platita"));
      await h.reserveUntil(p.id, "1", "3-anulata", minutes(T0, 1));
      await h.stock.release(h.ref("3-anulata"));
      h.setClock(minutes(T0, 5));
      expect(await h.maintenance.expireReservations()).toMatchObject({ expired: 0 });
      expect(await h.statuses(p.id)).toEqual(["active", "confirmed", "released"]);
      expect(await h.item(p.id)).toMatchObject({ reserved: q("1"), committed: q("1") });
    });
  });

  it("idempotent: a doua rulare, imediat după prima, nu face nimic", async () => {
    await withStock(async (h) => {
      const p = await h.product("5");
      await h.reserveUntil(p.id, "2", "a", minutes(T0, 1));
      h.setClock(minutes(T0, 2));
      expect((await h.maintenance.expireReservations()).expired).toBe(1);
      expect(await h.maintenance.expireReservations()).toEqual({
        expired: 0,
        batches: 1,
        complete: true,
      });
      expect((await h.item(p.id)).reserved).toBe(0n);
    });
  });

  it("în loturi: 5 rânduri de stoc cu rezervări expirate, lot de 2 → 3 loturi, toate eliberate", async () => {
    await withStock(
      async (h) => {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          const p = await h.product("3");
          await h.reserveUntil(p.id, "1", `r${i}`, minutes(T0, 1));
          ids.push(p.id);
        }
        h.setClock(minutes(T0, 2));
        const result = await h.maintenance.expireReservations();
        expect(result).toEqual({ expired: 5, batches: 3, complete: true });
        for (const id of ids) expect((await h.item(id)).reserved).toBe(0n);
      },
      { batchSize: 2 },
    );
  });

  it("plafonul pe rulare: se oprește cu complete = false, iar următoarea rulare continuă de unde a rămas", async () => {
    await withStock(
      async (h) => {
        for (let i = 0; i < 5; i++) {
          const p = await h.product("3");
          await h.reserveUntil(p.id, "1", `r${i}`, minutes(T0, 1));
        }
        h.setClock(minutes(T0, 2));
        const first = await h.maintenance.expireReservations({ maxBatches: 2 });
        expect(first).toEqual({ expired: 4, batches: 2, complete: false });
        const second = await h.maintenance.expireReservations({ maxBatches: 2 });
        expect(second).toMatchObject({ expired: 1, complete: true });
        const third = await h.maintenance.expireReservations();
        expect(third.expired).toBe(0);
      },
      { batchSize: 2 },
    );
  });

  it("eșec la mijloc: loturile făcute rămân făcute, eroarea iese la iveală, reluarea termină restul fără dublură", async () => {
    await withStock(
      async (h) => {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          const p = await h.product("3");
          await h.reserveUntil(p.id, "1", `r${i}`, minutes(T0, 1));
          ids.push(p.id);
        }
        h.setClock(minutes(T0, 2));
        let calls = 0;
        const flaky = new StockMaintenance({
          db: h.tx,
          audit: new AuditService(h.audit),
          now: () => minutes(T0, 2),
          batchSize: 2,
          stock: {
            async expireDue(options) {
              calls++;
              if (calls === 2) throw new Error("conexiunea s-a pierdut");
              return h.stock.expireDue(options);
            },
          },
        });
        await expect(flaky.expireReservations()).rejects.toThrow("conexiunea s-a pierdut");
        let released = 0;
        for (const id of ids) if ((await h.item(id)).reserved === 0n) released++;
        expect(released).toBe(2); // primul lot (2 rânduri de stoc) a rămas făcut
        const resumed = await h.maintenance.expireReservations();
        expect(resumed.expired).toBe(3);
        for (const id of ids) {
          expect((await h.item(id)).reserved).toBe(0n);
          expect((await h.stock.checkConsistency(id)).ok).toBe(true);
        }
      },
      { batchSize: 2 },
    );
  });

  it("două rezervări expirate pe același rând de stoc se eliberează împreună, o singură dată fiecare", async () => {
    await withStock(async (h) => {
      const p = await h.product("5");
      await h.reserveUntil(p.id, "1", "a", minutes(T0, 1));
      await h.reserveUntil(p.id, "2", "b", minutes(T0, 2));
      h.setClock(minutes(T0, 3));
      expect((await h.maintenance.expireReservations()).expired).toBe(2);
      expect((await h.item(p.id)).reserved).toBe(0n);
      expect(await h.statuses(p.id)).toEqual(["expired", "expired"]);
    });
  });

  it("transfer bancar: rezervarea ține peste weekend și expiră abia după sfârșitul celei de-a treia zile lucrătoare", async () => {
    await withStock(async (h) => {
      const p = await h.product("5");
      // vineri 2026-10-23, 15:00 ora locală (12:00 UTC)
      const friday = new Date("2026-10-23T12:00:00Z");
      h.setClock(friday);
      const expiresAt = reservationExpiresAt("transfer", friday, {
        reservationMinutes: 15,
        transferReservationWorkdays: 3,
        timeZone: "Europe/Bucharest",
      });
      await h.reserveUntil(p.id, "1", "transfer", expiresAt);
      // miercuri 2026-10-28, 23:00 locală = 21:00 UTC (după trecerea la ora de iarnă): încă ține
      h.setClock(new Date("2026-10-28T21:00:00Z"));
      expect((await h.maintenance.expireReservations()).expired).toBe(0);
      expect((await h.item(p.id)).reserved).toBe(q("1"));
      // joi 00:01 locală = miercuri 22:01 UTC: a expirat
      h.setClock(new Date("2026-10-28T22:01:00Z"));
      expect((await h.maintenance.expireReservations()).expired).toBe(1);
      expect((await h.item(p.id)).reserved).toBe(0n);
    });
  });
});

describe("prospețimea pozei SmartBill", () => {
  async function alertRows(h: Harness) {
    return h.audit.for(h.ctx.warehouseId);
  }
  const mine = (
    h: Harness,
    result: Awaited<ReturnType<StockMaintenance["checkSnapshotFreshness"]>>,
  ) => result.warehouses.find((w) => w.warehouseId === h.ctx.warehouseId);

  it("depozit cu stoc și FĂRĂ nicio poză → o alertă «never», o singură dată (a doua rulare nu o repetă)", async () => {
    await withStock(async (h) => {
      await h.product("5");
      const first = await h.maintenance.checkSnapshotFreshness({ staleHours: 24 });
      expect(mine(h, first)).toMatchObject({ status: "never", alerted: true });
      const rows = await alertRows(h);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "stock.snapshot.stale",
        entity: "warehouse",
        actorId: null,
        actorLabel: "sistem",
        outcome: "success",
        after: { status: "never", staleHours: 24, reminder: false },
      });
      const second = await h.maintenance.checkSnapshotFreshness({ staleHours: 24 });
      expect(mine(h, second)).toMatchObject({ status: "never", alerted: false });
      expect(await alertRows(h)).toHaveLength(1);
    });
  });

  it("proaspătă nu alertează; veche abia STRICT peste prag (la exact 24 h e încă proaspătă)", async () => {
    await withStock(async (h) => {
      await h.product("5");
      await h.snapshot(hours(T0, -3));
      expect(mine(h, await h.maintenance.checkSnapshotFreshness({ staleHours: 24 }))).toMatchObject(
        {
          status: "fresh",
          alerted: false,
        },
      );
      expect(await alertRows(h)).toHaveLength(0);

      h.setClock(hours(T0, 21)); // poza are exact 24 h
      expect(mine(h, await h.maintenance.checkSnapshotFreshness({ staleHours: 24 }))?.status).toBe(
        "fresh",
      );
      expect(await alertRows(h)).toHaveLength(0);

      h.setClock(new Date(hours(T0, 21).getTime() + 1)); // 24 h și o milisecundă
      expect(mine(h, await h.maintenance.checkSnapshotFreshness({ staleHours: 24 }))).toMatchObject(
        {
          status: "stale",
          alerted: true,
        },
      );
      const [row] = await alertRows(h);
      expect(row?.after).toMatchObject({ status: "stale", takenAt: hours(T0, -3).toISOString() });
    });
  });

  it("folosește cea mai recentă poză a depozitului, nu prima găsită", async () => {
    await withStock(async (h) => {
      await h.product("5");
      await h.snapshot(days(T0, -10));
      await h.snapshot(hours(T0, -1));
      await h.snapshot(days(T0, -5));
      expect(mine(h, await h.maintenance.checkSnapshotFreshness({ staleHours: 24 }))?.status).toBe(
        "fresh",
      );
    });
  });

  it("refacerea: după o alertă, o poză nouă produce o singură înregistrare «recovered»; apoi liniște", async () => {
    await withStock(async (h) => {
      await h.product("5");
      await h.maintenance.checkSnapshotFreshness({ staleHours: 24 });
      h.setClock(hours(T0, 2));
      await h.snapshot(hours(T0, 1));
      const recovered = await h.maintenance.checkSnapshotFreshness({ staleHours: 24 });
      expect(mine(h, recovered)).toMatchObject({ status: "fresh", recovered: true });
      const rows = await alertRows(h);
      expect(rows.map((r) => r.action).sort()).toEqual([
        "stock.snapshot.recovered",
        "stock.snapshot.stale",
      ]);
      await h.maintenance.checkSnapshotFreshness({ staleHours: 24 });
      expect(await alertRows(h)).toHaveLength(2);
      // se strică din nou mai târziu → alertă nouă (episod nou)
      h.setClock(days(T0, 3));
      expect(mine(h, await h.maintenance.checkSnapshotFreshness({ staleHours: 24 }))).toMatchObject(
        {
          status: "stale",
          alerted: true,
        },
      );
      expect(await alertRows(h)).toHaveLength(3);
    });
  });

  it("memento: cât timp rămâne veche, la fiecare 24 h se mai scrie o înregistrare (reminder: true), nu la fiecare rulare", async () => {
    await withStock(async (h) => {
      await h.product("5");
      await h.maintenance.checkSnapshotFreshness({ staleHours: 24 });
      h.setClock(hours(T0, 23));
      expect(mine(h, await h.maintenance.checkSnapshotFreshness({ staleHours: 24 }))).toMatchObject(
        {
          alerted: false,
          reminded: false,
        },
      );
      expect(await alertRows(h)).toHaveLength(1);
      h.setClock(hours(T0, 24));
      expect(mine(h, await h.maintenance.checkSnapshotFreshness({ staleHours: 24 }))).toMatchObject(
        {
          alerted: false,
          reminded: true,
        },
      );
      const rows = await alertRows(h);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.after).toMatchObject({ reminder: true });
      h.setClock(hours(T0, 30));
      await h.maintenance.checkSnapshotFreshness({ staleHours: 24 });
      expect(await alertRows(h)).toHaveLength(2);
    });
  });

  it("depozit fără rânduri de stoc sau inactiv nu alertează (un magazin fără stoc gestionat nu primește alerte)", async () => {
    await withStock(async (h) => {
      // niciun produs gestionat în depozitul testului
      const empty = mine(h, await h.maintenance.checkSnapshotFreshness({ staleHours: 24 }));
      expect(empty).toBeUndefined();
      expect(await alertRows(h)).toHaveLength(0);

      const p = await h.product("5");
      const inactive = await h.tx.warehouse.create({
        data: { code: `w_${h.ctx.tag}i`, name: "Depozit oprit", isActive: false },
      });
      await h.tx.inventoryItem.create({
        data: { variantId: p.id, warehouseId: inactive.id, physical: q("3") },
      });
      const result = await h.maintenance.checkSnapshotFreshness({ staleHours: 24 });
      expect(result.warehouses.find((w) => w.warehouseId === inactive.id)).toBeUndefined();
      expect(h.audit.for(inactive.id)).toHaveLength(0);
    });
  });

  it("citirea pentru banner (getSnapshotFreshness) nu scrie nimic în jurnal", async () => {
    await withStock(async (h) => {
      await h.product("5");
      await h.snapshot(hours(T0, -30));
      const view = (await h.maintenance.getSnapshotFreshness({ staleHours: 24 })).find(
        (w) => w.warehouseId === h.ctx.warehouseId,
      );
      expect(view).toMatchObject({ status: "stale", takenAt: hours(T0, -30), ageHours: 30 });
      expect(await alertRows(h)).toHaveLength(0);
    });
  });

  it("dacă scrierea în audit eșuează, nu rămâne nicio urmă falsă și rularea următoare alertează", async () => {
    await withStock(async (h) => {
      await h.product("5");
      h.audit.failNext = true;
      await expect(h.maintenance.checkSnapshotFreshness({ staleHours: 24 })).rejects.toThrow(
        "indisponibil",
      );
      expect(await alertRows(h)).toHaveLength(0);
      expect(mine(h, await h.maintenance.checkSnapshotFreshness({ staleHours: 24 }))).toMatchObject(
        {
          status: "never",
          alerted: true,
        },
      );
      expect(await alertRows(h)).toHaveLength(1);
    });
  });

  it("pragul nevalid (0) se refuză zgomotos", async () => {
    await withStock(async (h) => {
      await expect(h.maintenance.checkSnapshotFreshness({ staleHours: 0 })).rejects.toThrow(
        RangeError,
      );
    });
  });

  it("cu jurnalul real de audit (Prisma): alerta ajunge în audit_log, o singură dată", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await runBaseSeed(tx);
      const ctx = await createStockContext(tx, { useDefaultWarehouse: true });
      await addStockProduct(tx, ctx, { variants: [{ physical: "5" }] });
      const maintenance = new StockMaintenance({
        db: tx,
        audit: new AuditService(createPrismaAuditStore(tx)),
      });
      await maintenance.checkSnapshotFreshness({ staleHours: 24 });
      await maintenance.checkSnapshotFreshness({ staleHours: 24 });
      const rows = await tx.auditLog.findMany({
        where: { entity: "warehouse", entityId: ctx.warehouseId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: "stock.snapshot.stale", outcome: "success" });
    });
  });
});

describe("curățarea cererilor «Anunță-mă când revine»", () => {
  async function alert(
    h: Harness,
    variantId: string,
    email: string,
    createdAt: Date,
    notifiedAt: Date | null = null,
  ) {
    return h.tx.backInStockAlert.create({ data: { variantId, email, createdAt, notifiedAt } });
  }
  const remaining = (h: Harness, variantId: string) =>
    h.tx.backInStockAlert.count({ where: { variantId } });

  it("șterge cererile netrimise mai vechi de retenție; marginea: exact la 90 de zile se păstrează", async () => {
    await withStock(async (h) => {
      const p = await h.product("0");
      await alert(h, p.id, "vechi@exemplu.test", days(T0, -91));
      await alert(h, p.id, "margine@exemplu.test", days(T0, -90));
      await alert(h, p.id, "recent@exemplu.test", days(T0, -10));
      const result = await h.maintenance.purgeBackInStockAlerts({ retentionDays: 90 });
      expect(result).toEqual({ unsent: 1, sent: 0 });
      const left = await h.tx.backInStockAlert.findMany({
        where: { variantId: p.id },
        orderBy: { email: "asc" },
      });
      expect(left.map((a) => a.email)).toEqual(["margine@exemplu.test", "recent@exemplu.test"]);
    });
  });

  it("cererile deja trimise (adresa nu mai trebuie ținută) se șterg după 1 zi, indiferent de vechimea cererii", async () => {
    await withStock(async (h) => {
      const p = await h.product("0");
      await alert(h, p.id, "trimis-ieri@exemplu.test", days(T0, -5), hours(T0, -30));
      await alert(h, p.id, "trimis-azi@exemplu.test", days(T0, -5), hours(T0, -2));
      await alert(h, p.id, "trimis-marginea@exemplu.test", days(T0, -5), hours(T0, -24));
      const result = await h.maintenance.purgeBackInStockAlerts({ retentionDays: 90 });
      expect(result).toEqual({ unsent: 0, sent: 1 });
      expect(
        (
          await h.tx.backInStockAlert.findMany({
            where: { variantId: p.id },
            orderBy: { email: "asc" },
          })
        ).map((a) => a.email),
      ).toEqual(["trimis-azi@exemplu.test", "trimis-marginea@exemplu.test"]);
    });
  });

  it("idempotent: a doua rulare nu mai găsește nimic", async () => {
    await withStock(async (h) => {
      const p = await h.product("0");
      await alert(h, p.id, "vechi@exemplu.test", days(T0, -200));
      expect(await h.maintenance.purgeBackInStockAlerts({ retentionDays: 90 })).toEqual({
        unsent: 1,
        sent: 0,
      });
      expect(await h.maintenance.purgeBackInStockAlerts({ retentionDays: 90 })).toEqual({
        unsent: 0,
        sent: 0,
      });
    });
  });

  it("în loturi: 7 cereri vechi, lot de 3 → toate șterse", async () => {
    await withStock(
      async (h) => {
        const p = await h.product("0");
        for (let i = 0; i < 7; i++) await alert(h, p.id, `v${i}@exemplu.test`, days(T0, -100 - i));
        expect(await h.maintenance.purgeBackInStockAlerts({ retentionDays: 90 })).toEqual({
          unsent: 7,
          sent: 0,
        });
        expect(await remaining(h, p.id)).toBe(0);
      },
      { batchSize: 3 },
    );
  });

  it("retenția se citește din setare: 30 de zile șterge mai mult decât 90", async () => {
    await withStock(async (h) => {
      const p = await h.product("0");
      await alert(h, p.id, "a@exemplu.test", days(T0, -40));
      expect(await h.maintenance.purgeBackInStockAlerts({ retentionDays: 90 })).toEqual({
        unsent: 0,
        sent: 0,
      });
      expect(await h.maintenance.purgeBackInStockAlerts({ retentionDays: 30 })).toEqual({
        unsent: 1,
        sent: 0,
      });
    });
  });

  it("rezultatul conține doar numere (nicio adresă de email nu ajunge în loguri)", async () => {
    await withStock(async (h) => {
      const p = await h.product("0");
      await alert(h, p.id, "secret@exemplu.test", days(T0, -200));
      const result = await h.maintenance.purgeBackInStockAlerts({ retentionDays: 90 });
      expect(JSON.stringify(result)).not.toContain("@");
    });
  });

  it("retenție nevalidă → RangeError", async () => {
    await withStock(async (h) => {
      for (const bad of [0, -1, 1.5, 366, Number.NaN]) {
        await expect(
          h.maintenance.purgeBackInStockAlerts({ retentionDays: bad }),
          String(bad),
        ).rejects.toThrow(RangeError);
      }
    });
  });
});
