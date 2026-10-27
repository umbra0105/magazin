import { describe, expect, it } from "vitest";
import type { AuditService } from "../audit/audit-service";
import { StockMaintenance, type StockMaintenanceDeps } from "./stock-maintenance";

/**
 * Decizia «lotul a fost plin» a expirării rezervărilor (Faza 5, defect din punctul 7). Lotul e plin după câte chei a CITIT
 * `expireDue` (`scanned`), nu după câte a golit instanța însăși (`items`): dacă o altă instanță golește cheile lotului între
 * citire și baleiere, `items` scade, deși mai sunt rezervări de expirat. Aici `expireDue` e fals, deci testul e determinist.
 */

type Batch = { expired: number; items: number; scanned: number };

function maintenanceWith(batches: Batch[], batchSize: number) {
  const calls: Array<{ limit?: number }> = [];
  const queue = [...batches];
  const maintenance = new StockMaintenance({
    // `expireReservations` nu atinge baza și auditul când serviciul de stoc e dat
    db: {} as unknown as StockMaintenanceDeps["db"],
    audit: {} as unknown as AuditService,
    batchSize,
    stock: {
      async expireDue(options) {
        calls.push(options ?? {});
        const next = queue.shift();
        if (!next) throw new Error("expireDue a fost apelat de mai multe ori decât se aștepta");
        return next;
      },
    },
  });
  return { maintenance, calls, left: () => queue.length };
}

describe("expireReservations: decizia «lot plin»", () => {
  it("un lot citit plin (scanned = batchSize), dar golit de altă instanță (items = 0), NU încheie rularea", async () => {
    const h = maintenanceWith(
      [
        { expired: 0, items: 0, scanned: 5 },
        { expired: 3, items: 3, scanned: 3 },
      ],
      5,
    );
    expect(await h.maintenance.expireReservations()).toEqual({
      expired: 3,
      batches: 2,
      complete: true,
    });
    expect(h.left()).toBe(0);
  });

  it("un lot parțial golit de altă instanță (items < batchSize, scanned = batchSize) continuă", async () => {
    const h = maintenanceWith(
      [
        { expired: 2, items: 2, scanned: 5 },
        { expired: 4, items: 4, scanned: 5 },
        { expired: 1, items: 1, scanned: 1 },
      ],
      5,
    );
    expect(await h.maintenance.expireReservations()).toEqual({
      expired: 7,
      batches: 3,
      complete: true,
    });
  });

  it("un lot citit incomplet (scanned < batchSize) încheie rularea, chiar dacă a golit puține chei", async () => {
    const h = maintenanceWith([{ expired: 1, items: 1, scanned: 4 }], 5);
    expect(await h.maintenance.expireReservations()).toEqual({
      expired: 1,
      batches: 1,
      complete: true,
    });
  });

  it("nimic de citit (scanned = 0) încheie rularea", async () => {
    const h = maintenanceWith([{ expired: 0, items: 0, scanned: 0 }], 5);
    expect(await h.maintenance.expireReservations()).toEqual({
      expired: 0,
      batches: 1,
      complete: true,
    });
  });

  it("plafonul de loturi rămâne: loturi pline la rând se opresc la maxBatches cu complete = false", async () => {
    const h = maintenanceWith(
      [
        { expired: 0, items: 0, scanned: 5 },
        { expired: 5, items: 5, scanned: 5 },
        { expired: 5, items: 5, scanned: 5 },
      ],
      5,
    );
    expect(await h.maintenance.expireReservations({ maxBatches: 2 })).toEqual({
      expired: 5,
      batches: 2,
      complete: false,
    });
    expect(h.left()).toBe(1);
  });

  it("cere fiecărui lot exact batchSize chei", async () => {
    const h = maintenanceWith([{ expired: 0, items: 0, scanned: 0 }], 7);
    await h.maintenance.expireReservations();
    expect(h.calls).toEqual([{ limit: 7 }]);
  });
});
