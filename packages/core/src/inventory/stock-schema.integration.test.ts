import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  ADJUSTMENT_REASONS,
  COMMITMENT_STATUSES,
  PRICE_BASES,
  RESERVATION_STATUSES,
  SMARTBILL_MODES,
  SNAPSHOT_SOURCES,
  STOCK_MOVEMENT_KINDS,
} from "./constants";

/**
 * Faza 5, punctul 1: schema stocului. Fiecare constrângere are cel puțin un test care o încalcă și
 * constatarea că baza respinge scrierea (după numele constrângerii). CHECK-urile compuse au cazul
 * „una setată, una nulă” (un CHECK cu rezultat NULL TRECE, deci fiecare coloană e comparată explicit).
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

/** Plafonul cantităților de stoc în zecimi de miime (10^12 = 100.000.000 de unități). */
const CAP = 1_000_000_000_000n;

async function base(tx: TestTx) {
  const product = await tx.product.create({ data: { slug: `p-${uid()}`, title: "Produs" } });
  const variant = await tx.productVariant.create({
    data: { productId: product.id, sku: `SKU-${uid()}`, price: 1000 },
  });
  const warehouse = await tx.warehouse.create({
    data: { code: `w_${uid()}`, name: "Depozit de test" },
  });
  return { product, variant, warehouse };
}

async function withItem(tx: TestTx) {
  const b = await base(tx);
  const item = await tx.inventoryItem.create({
    data: { variantId: b.variant.id, warehouseId: b.warehouse.id, physical: 50_000n },
  });
  return { ...b, item };
}

async function attempt<B>(
  setup: (tx: TestTx) => Promise<B>,
  act: (tx: TestTx, b: B) => Promise<unknown>,
): Promise<Error | null> {
  return inRolledBackTransaction(db, async (tx) => {
    const b = await setup(tx);
    try {
      await act(tx, b);
      return null;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  });
}

/** Baza trebuie să respingă `act`; `expected` = numele constrângerii/triggerului din eroare. */
async function rejects<B>(
  setup: (tx: TestTx) => Promise<B>,
  act: (tx: TestTx, b: B) => Promise<unknown>,
  expected: string,
): Promise<void> {
  const error = await attempt(setup, act);
  expect(error, `baza trebuia să respingă scrierea (${expected})`).not.toBeNull();
  expect(JSON.stringify(error) + String(error?.message)).toContain(expected);
}

async function accepts<B>(
  setup: (tx: TestTx) => Promise<B>,
  act: (tx: TestTx, b: B) => Promise<unknown>,
): Promise<void> {
  const error = await attempt(setup, act);
  expect(error, String(error?.message)).toBeNull();
}

describe("unități de măsură", () => {
  const unit = (tx: TestTx, over: Record<string, unknown> = {}) =>
    tx.measureUnit.create({
      data: { code: `u_${uid()}`, name: "Unitate", symbol: "u", decimals: 2, ...over },
    });

  it("acceptă 0–4 zecimale și refuză restul", async () => {
    for (const decimals of [0, 1, 2, 3, 4]) {
      await accepts(
        async () => null,
        (tx) => unit(tx, { decimals }),
      );
    }
    for (const decimals of [-1, 5, 10]) {
      await rejects(
        async () => null,
        (tx) => unit(tx, { decimals }),
        "measure_unit_decimals_check",
      );
    }
  });

  it("codul are formă stabilă și e unic", async () => {
    for (const code of ["Buc", "1ml", "m p", "", "mp-2"]) {
      await rejects(
        async () => null,
        (tx) => unit(tx, { code }),
        "measure_unit_code_check",
      );
    }
    await rejects(
      async () => null,
      async (tx) => {
        const code = `u_${uid()}`;
        await unit(tx, { code });
        await unit(tx, { code });
      },
      "measure_unit_code_key",
    );
  });

  it("simbolul și numele nu pot fi goale", async () => {
    await rejects(
      async () => null,
      (tx) => unit(tx, { symbol: " " }),
      "measure_unit_symbol_check",
    );
    await rejects(
      async () => null,
      (tx) => unit(tx, { name: "" }),
      "measure_unit_name_check",
    );
  });

  it("unitatea de sistem nu se șterge; una folosită nici atât (produs sau variantă)", async () => {
    await rejects(
      async () => null,
      async (tx) => {
        const u = await unit(tx, { isSystem: true });
        await tx.measureUnit.delete({ where: { id: u.id } });
      },
      "measure_unit_system_protected",
    );
    await rejects(
      base,
      async (tx, b) => {
        const u = await unit(tx);
        await tx.product.update({ where: { id: b.product.id }, data: { measureUnitId: u.id } });
        await tx.measureUnit.delete({ where: { id: u.id } });
      },
      "product_measureUnitId_fkey",
    );
    await rejects(
      base,
      async (tx, b) => {
        const u = await unit(tx);
        await tx.productVariant.update({
          where: { id: b.variant.id },
          data: { measureUnitId: u.id },
        });
        await tx.measureUnit.delete({ where: { id: u.id } });
      },
      "product_variant_measureUnitId_fkey",
    );
    await accepts(
      async () => null,
      async (tx) => {
        const u = await unit(tx);
        await tx.measureUnit.delete({ where: { id: u.id } });
      },
    );
  });
});

describe("unitate, pas și bază de preț pe produs și variantă", () => {
  it("pasul, minimul și baza prețului pe produs", async () => {
    await accepts(base, (tx, b) =>
      tx.product.update({
        where: { id: b.product.id },
        data: { priceBasis: "step", saleStep: 25_000, minSteps: 2, showStepPrice: true },
      }),
    );
    for (const saleStep of [0, -1]) {
      await rejects(
        base,
        (tx, b) => tx.product.update({ where: { id: b.product.id }, data: { saleStep } }),
        "product_saleStep_check",
      );
    }
    await rejects(
      base,
      (tx, b) => tx.product.update({ where: { id: b.product.id }, data: { minSteps: 0 } }),
      "product_minSteps_check",
    );
    await rejects(
      base,
      (tx, b) => tx.product.update({ where: { id: b.product.id }, data: { priceBasis: "kg" } }),
      "product_priceBasis_check",
    );
  });

  it("variantă: aceleași câmpuri, nule = moștenește", async () => {
    await accepts(base, async (tx, b) => {
      const v = await tx.productVariant.findUniqueOrThrow({ where: { id: b.variant.id } });
      expect(v.saleStep).toBeNull();
      expect(v.minSteps).toBeNull();
      expect(v.priceBasis).toBeNull();
      expect(v.measureUnitId).toBeNull();
      await tx.productVariant.update({
        where: { id: b.variant.id },
        data: { priceBasis: "unit", saleStep: 15_000, minSteps: 1 },
      });
    });
    await rejects(
      base,
      (tx, b) => tx.productVariant.update({ where: { id: b.variant.id }, data: { saleStep: 0 } }),
      "product_variant_saleStep_check",
    );
    await rejects(
      base,
      (tx, b) => tx.productVariant.update({ where: { id: b.variant.id }, data: { minSteps: -3 } }),
      "product_variant_minSteps_check",
    );
    await rejects(
      base,
      (tx, b) =>
        tx.productVariant.update({ where: { id: b.variant.id }, data: { priceBasis: "pas" } }),
      "product_variant_priceBasis_check",
    );
  });

  it("produsul nou are baza „pe unitate” și fără pas (= o unitate)", async () => {
    await accepts(base, async (tx, b) => {
      const p = await tx.product.findUniqueOrThrow({ where: { id: b.product.id } });
      expect(p.priceBasis).toBe("unit");
      expect(p.saleStep).toBeNull();
      expect(p.minSteps).toBeNull();
      expect(p.measureUnitId).toBeNull();
      expect(p.showStepPrice).toBe(false);
      expect(p.leadTimeDays).toBeNull();
    });
  });

  it("conversia SmartBill: matricea completă (una setată, una nulă)", async () => {
    const set =
      (data: Record<string, unknown>) => (tx: TestTx, b: Awaited<ReturnType<typeof base>>) =>
        tx.productVariant.update({ where: { id: b.variant.id }, data });
    const name = "product_variant_smartbill_check";

    // permise
    await accepts(base, set({ smartbillMode: null, smartbillRatio: null }));
    await accepts(base, set({ smartbillMode: "same_unit" }));
    await accepts(base, set({ smartbillMode: "steps", smartbillUnitName: "rola" }));
    await accepts(base, set({ smartbillMode: "ratio", smartbillRatio: 412_500 }));
    // „una setată, una nulă”
    await rejects(base, set({ smartbillRatio: 412_500 }), name);
    await rejects(base, set({ smartbillMode: "ratio" }), name);
    await rejects(base, set({ smartbillMode: "ratio", smartbillRatio: 0 }), name);
    await rejects(base, set({ smartbillMode: "ratio", smartbillRatio: -5 }), name);
    await rejects(base, set({ smartbillMode: "same_unit", smartbillRatio: 10_000 }), name);
    await rejects(base, set({ smartbillMode: "steps", smartbillRatio: 10_000 }), name);
    await rejects(base, set({ smartbillMode: "altceva" }), name);
    // numele unității din SmartBill nu poate fi gol
    await rejects(
      base,
      set({ smartbillMode: "same_unit", smartbillUnitName: " " }),
      "product_variant_smartbillUnitName_check",
    );
  });

  it("termenul de livrare pe produs și pe brand: 0–365 de zile sau nul", async () => {
    await accepts(base, (tx, b) =>
      tx.product.update({ where: { id: b.product.id }, data: { leadTimeDays: 0 } }),
    );
    await accepts(base, (tx, b) =>
      tx.product.update({ where: { id: b.product.id }, data: { leadTimeDays: 365 } }),
    );
    for (const leadTimeDays of [-1, 366]) {
      await rejects(
        base,
        (tx, b) => tx.product.update({ where: { id: b.product.id }, data: { leadTimeDays } }),
        "product_leadTimeDays_check",
      );
    }
    await accepts(
      async () => null,
      (tx) =>
        tx.brand.create({ data: { slug: `b-${uid()}`, name: "Brand", defaultLeadTimeDays: 14 } }),
    );
    for (const defaultLeadTimeDays of [-1, 366]) {
      await rejects(
        async () => null,
        (tx) =>
          tx.brand.create({ data: { slug: `b-${uid()}`, name: "Brand", defaultLeadTimeDays } }),
        "brand_defaultLeadTimeDays_check",
      );
    }
  });
});

describe("depozite", () => {
  it("codul e unic și are formă stabilă", async () => {
    await rejects(
      async () => null,
      async (tx) => {
        const code = `w_${uid()}`;
        await tx.warehouse.create({ data: { code, name: "A" } });
        await tx.warehouse.create({ data: { code, name: "B" } });
      },
      "warehouse_code_key",
    );
    await rejects(
      async () => null,
      (tx) => tx.warehouse.create({ data: { code: "Depozit Mare", name: "A" } }),
      "warehouse_code_check",
    );
  });

  it("exact un depozit implicit; cel implicit e activ și nu se șterge", async () => {
    // în baza de test seed-ul poate exista deja; baza garantează oricum cel mult unul
    await rejects(
      async (tx) => {
        if ((await tx.warehouse.count({ where: { isDefault: true } })) === 0) {
          await tx.warehouse.create({
            data: { code: `w_${uid()}`, name: "Implicit", isDefault: true },
          });
        }
      },
      (tx) =>
        tx.warehouse.create({
          data: { code: `w_${uid()}`, name: "Alt implicit", isDefault: true },
        }),
      "warehouse_single_default",
    );
    await rejects(
      async () => null,
      (tx) =>
        tx.warehouse.create({
          data: { code: `w_${uid()}`, name: "Inactiv", isDefault: true, isActive: false },
        }),
      "warehouse_default_active_check",
    );
    await rejects(
      async (tx) => {
        const existing = await tx.warehouse.findFirst({ where: { isDefault: true } });
        return (
          existing ??
          tx.warehouse.create({ data: { code: `w_${uid()}`, name: "Implicit", isDefault: true } })
        );
      },
      (tx, w) => tx.warehouse.delete({ where: { id: w.id } }),
      "warehouse_default_protected",
    );
  });

  it("un depozit cu stoc nu se șterge", async () => {
    await rejects(
      withItem,
      (tx, b) => tx.warehouse.delete({ where: { id: b.warehouse.id } }),
      "inventory_item_warehouseId_fkey",
    );
  });
});

describe("InventoryItem", () => {
  it("un rând per variantă și depozit", async () => {
    await rejects(
      withItem,
      (tx, b) =>
        tx.inventoryItem.create({ data: { variantId: b.variant.id, warehouseId: b.warehouse.id } }),
      "inventory_item_variantId_warehouseId_key",
    );
    await accepts(withItem, async (tx, b) => {
      const other = await tx.warehouse.create({
        data: { code: `w_${uid()}`, name: "Alt depozit" },
      });
      await tx.inventoryItem.create({ data: { variantId: b.variant.id, warehouseId: other.id } });
    });
  });

  it("valorile implicite: zero, fără „valabil la”, fără prag propriu", async () => {
    await accepts(base, async (tx, b) => {
      const item = await tx.inventoryItem.create({
        data: { variantId: b.variant.id, warehouseId: b.warehouse.id },
      });
      expect(item.physical).toBe(0n);
      expect(item.committed).toBe(0n);
      expect(item.reserved).toBe(0n);
      expect(item.safetyBuffer).toBe(0n);
      expect(item.physicalAsOf).toBeNull();
      expect(item.lowStockSteps).toBeNull();
    });
  });

  it("fără cantități negative, fără depășirea plafonului (D5)", async () => {
    for (const [column, name] of [
      ["physical", "inventory_item_physical_check"],
      ["committed", "inventory_item_committed_check"],
      ["reserved", "inventory_item_reserved_check"],
      ["safetyBuffer", "inventory_item_safetyBuffer_check"],
    ] as const) {
      await rejects(
        base,
        (tx, b) =>
          tx.inventoryItem.create({
            data: { variantId: b.variant.id, warehouseId: b.warehouse.id, [column]: -1n },
          }),
        name,
      );
      await rejects(
        base,
        (tx, b) =>
          tx.inventoryItem.create({
            data: { variantId: b.variant.id, warehouseId: b.warehouse.id, [column]: CAP + 1n },
          }),
        name,
      );
    }
    // o scădere sub zero pe un rând existent e respinsă la fel
    await rejects(
      withItem,
      (tx, b) =>
        tx.inventoryItem.update({
          where: { id: b.item.id },
          data: { physical: { decrement: 50_001n } },
        }),
      "inventory_item_physical_check",
    );
    // plafonul însuși și exactitatea BIGINT
    await accepts(base, async (tx, b) => {
      const item = await tx.inventoryItem.create({
        data: { variantId: b.variant.id, warehouseId: b.warehouse.id, physical: CAP },
      });
      expect(item.physical).toBe(CAP);
    });
  });

  it("pragul în pași nu poate fi negativ", async () => {
    await accepts(base, (tx, b) =>
      tx.inventoryItem.create({
        data: { variantId: b.variant.id, warehouseId: b.warehouse.id, lowStockSteps: 0 },
      }),
    );
    await rejects(
      base,
      (tx, b) =>
        tx.inventoryItem.create({
          data: { variantId: b.variant.id, warehouseId: b.warehouse.id, lowStockSteps: -1 },
        }),
      "inventory_item_lowStockSteps_check",
    );
  });

  it("ștergerea variantei șterge rândul de stoc, dar nu dacă are rezervări sau angajări", async () => {
    await accepts(withItem, async (tx, b) => {
      await tx.productVariant.delete({ where: { id: b.variant.id } });
      expect(await tx.inventoryItem.count({ where: { id: b.item.id } })).toBe(0);
    });
    await rejects(
      withItem,
      async (tx, b) => {
        await tx.stockReservation.create({
          data: {
            variantId: b.variant.id,
            warehouseId: b.warehouse.id,
            quantity: 10_000n,
            refType: "checkout",
            refId: uid(),
            expiresAt: new Date(Date.now() + 900_000),
          },
        });
        await tx.productVariant.delete({ where: { id: b.variant.id } });
      },
      "stock_reservation_variantId_warehouseId_fkey",
    );
  });
});

describe("StockSnapshot", () => {
  const snapshot = (tx: TestTx, warehouseId: string, over: Record<string, unknown> = {}) =>
    tx.stockSnapshot.create({
      data: { warehouseId, takenAt: new Date(), source: "import", rowCount: 3, ...over },
    });

  it("sursa și numărul de rânduri sunt validate", async () => {
    await accepts(base, (tx, b) => snapshot(tx, b.warehouse.id));
    await accepts(base, (tx, b) => snapshot(tx, b.warehouse.id, { source: "api" }));
    await rejects(
      base,
      (tx, b) => snapshot(tx, b.warehouse.id, { source: "manual" }),
      "stock_snapshot_source_check",
    );
    await rejects(
      base,
      (tx, b) => snapshot(tx, b.warehouse.id, { rowCount: -1 }),
      "stock_snapshot_rowCount_check",
    );
  });
});

describe("StockMovement (imuabil)", () => {
  const movement = (
    tx: TestTx,
    b: Awaited<ReturnType<typeof base>>,
    over: Record<string, unknown> = {},
  ) =>
    tx.stockMovement.create({
      data: {
        variantId: b.variant.id,
        warehouseId: b.warehouse.id,
        kind: "adjustment",
        reason: "receipt",
        note: "Recepție marfă",
        deltaPhysical: 20_000n,
        physicalAfter: 20_000n,
        committedAfter: 0n,
        ...over,
      },
    });

  it("se poate adăuga, dar nu modifica, șterge sau goli", async () => {
    await accepts(base, async (tx, b) => {
      const m = await movement(tx, b);
      expect(m.effectiveAt).toBeInstanceOf(Date);
      expect(m.createdAt).toBeInstanceOf(Date);
    });
    await rejects(
      async (tx) => movement(tx, await base(tx)),
      (tx, m) => tx.stockMovement.update({ where: { id: m.id }, data: { note: "altceva" } }),
      "stock_movement este doar de adaugare",
    );
    await rejects(
      async (tx) => movement(tx, await base(tx)),
      (tx, m) => tx.stockMovement.delete({ where: { id: m.id } }),
      "stock_movement este doar de adaugare",
    );
    await rejects(
      async (tx) => movement(tx, await base(tx)),
      (tx) => tx.$executeRawUnsafe('TRUNCATE "stock_movement"'),
      "stock_movement este doar de adaugare",
    );
  });

  it("o variantă cu istoric nu se poate șterge definitiv", async () => {
    await rejects(
      async (tx) => {
        const b = await base(tx);
        await movement(tx, b);
        return b;
      },
      (tx, b) => tx.productVariant.delete({ where: { id: b.variant.id } }),
      "stock_movement_variantId_fkey",
    );
  });

  it("ajustarea cere motiv fix și text liber nevid; celelalte tipuri nu cer motiv", async () => {
    const name = "stock_movement_adjustment_check";
    for (const reason of [
      "receipt",
      "sale_in_store",
      "return",
      "inventory_correction",
      "damaged",
      "lost_stolen",
      "other",
    ]) {
      await accepts(base, (tx, b) => movement(tx, b, { reason }));
    }
    await rejects(base, (tx, b) => movement(tx, b, { reason: null }), name);
    await rejects(base, (tx, b) => movement(tx, b, { note: null }), name);
    await rejects(base, (tx, b) => movement(tx, b, { note: "   " }), name);
    await rejects(
      base,
      (tx, b) => movement(tx, b, { reason: "motiv_inventat" }),
      "stock_movement_reason_check",
    );
    await accepts(base, (tx, b) =>
      movement(tx, b, {
        kind: "commit",
        reason: null,
        note: null,
        deltaPhysical: 0n,
        deltaCommitted: 10_000n,
        committedAfter: 10_000n,
      }),
    );
    await rejects(base, (tx, b) => movement(tx, b, { kind: "retur" }), "stock_movement_kind_check");
  });

  it("referința generică: tip și id împreună sau deloc", async () => {
    const name = "stock_movement_ref_check";
    await accepts(base, (tx, b) => movement(tx, b, { refType: "order", refId: uid() }));
    await accepts(base, (tx, b) => movement(tx, b, { refType: null, refId: null }));
    await rejects(base, (tx, b) => movement(tx, b, { refType: "order", refId: null }), name);
    await rejects(base, (tx, b) => movement(tx, b, { refType: null, refId: uid() }), name);
    await rejects(base, (tx, b) => movement(tx, b, { refType: "Order", refId: uid() }), name);
    await rejects(base, (tx, b) => movement(tx, b, { refType: "order", refId: "" }), name);
  });

  it("o mișcare schimbă ceva, iar soldurile de după nu sunt negative sau peste plafon", async () => {
    await rejects(
      base,
      (tx, b) => movement(tx, b, { deltaPhysical: 0n, deltaCommitted: 0n }),
      "stock_movement_nonzero_check",
    );
    await accepts(base, (tx, b) =>
      movement(tx, b, { deltaPhysical: -5_000n, physicalAfter: 15_000n }),
    );
    await rejects(
      base,
      (tx, b) => movement(tx, b, { physicalAfter: -1n }),
      "stock_movement_physicalAfter_check",
    );
    await rejects(
      base,
      (tx, b) => movement(tx, b, { committedAfter: -1n }),
      "stock_movement_committedAfter_check",
    );
    await rejects(
      base,
      (tx, b) => movement(tx, b, { deltaPhysical: CAP + 1n }),
      "stock_movement_delta_check",
    );
    await rejects(
      base,
      (tx, b) => movement(tx, b, { deltaPhysical: -CAP - 1n }),
      "stock_movement_delta_check",
    );
    await rejects(
      base,
      (tx, b) => movement(tx, b, { physicalAfter: CAP + 1n }),
      "stock_movement_physicalAfter_check",
    );
  });

  it("doar mișcarea unei poze trimite la poză", async () => {
    await rejects(
      base,
      (tx, b) => movement(tx, b, { kind: "snapshot", reason: null, note: null }),
      "stock_movement_snapshot_check",
    );
    await rejects(
      base,
      async (tx, b) => {
        const snap = await tx.stockSnapshot.create({
          data: { warehouseId: b.warehouse.id, takenAt: new Date(), source: "import" },
        });
        await movement(tx, b, { snapshotId: snap.id });
      },
      "stock_movement_snapshot_check",
    );
    await accepts(base, async (tx, b) => {
      const snap = await tx.stockSnapshot.create({
        data: { warehouseId: b.warehouse.id, takenAt: new Date(), source: "import" },
      });
      await movement(tx, b, { kind: "snapshot", reason: null, note: null, snapshotId: snap.id });
    });
    await rejects(
      base,
      async (tx, b) =>
        movement(tx, b, { kind: "snapshot", reason: null, note: null, snapshotId: "inexistent" }),
      "stock_movement_snapshotId_fkey",
    );
  });
});

describe("StockReservation", () => {
  const reservation = (
    tx: TestTx,
    b: Awaited<ReturnType<typeof withItem>>,
    over: Record<string, unknown> = {},
  ) =>
    tx.stockReservation.create({
      data: {
        variantId: b.variant.id,
        warehouseId: b.warehouse.id,
        quantity: 10_000n,
        refType: "checkout",
        refId: "ref-1",
        expiresAt: new Date(Date.now() + 900_000),
        ...over,
      },
    });

  it("cantitate strict pozitivă, doar pe un rând de stoc existent", async () => {
    await accepts(withItem, (tx, b) => reservation(tx, b));
    for (const quantity of [0n, -1n, CAP + 1n]) {
      await rejects(
        withItem,
        (tx, b) => reservation(tx, b, { quantity }),
        "stock_reservation_quantity_check",
      );
    }
    await rejects(
      base,
      (tx, b) =>
        tx.stockReservation.create({
          data: {
            variantId: b.variant.id,
            warehouseId: b.warehouse.id,
            quantity: 10_000n,
            refType: "checkout",
            refId: "x",
            expiresAt: new Date(),
          },
        }),
      "stock_reservation_variantId_warehouseId_fkey",
    );
  });

  it("o singură rezervare activă (sau confirmată) per referință și linie; după eliberare, una nouă", async () => {
    await rejects(
      withItem,
      async (tx, b) => {
        await reservation(tx, b);
        await reservation(tx, b);
      },
      "stock_reservation_ref_open_key",
    );
    await accepts(withItem, async (tx, b) => {
      const first = await reservation(tx, b);
      await tx.stockReservation.update({
        where: { id: first.id },
        data: { status: "expired", releasedAt: new Date() },
      });
      await reservation(tx, b);
    });
    await accepts(withItem, async (tx, b) => {
      await reservation(tx, b);
      await reservation(tx, b, { refId: "ref-2" });
    });
  });

  it("starea și momentele ei sunt coerente (una setată, una nulă)", async () => {
    const name = "stock_reservation_status_check";
    const now = new Date();
    await accepts(withItem, (tx, b) => reservation(tx, b, { status: "active" }));
    await accepts(withItem, (tx, b) =>
      reservation(tx, b, { status: "confirmed", confirmedAt: now }),
    );
    await accepts(withItem, (tx, b) => reservation(tx, b, { status: "released", releasedAt: now }));
    await accepts(withItem, (tx, b) => reservation(tx, b, { status: "expired", releasedAt: now }));
    await rejects(withItem, (tx, b) => reservation(tx, b, { status: "confirmed" }), name);
    await rejects(withItem, (tx, b) => reservation(tx, b, { status: "released" }), name);
    await rejects(withItem, (tx, b) => reservation(tx, b, { status: "expired" }), name);
    await rejects(
      withItem,
      (tx, b) => reservation(tx, b, { status: "active", confirmedAt: now }),
      name,
    );
    await rejects(
      withItem,
      (tx, b) => reservation(tx, b, { status: "active", releasedAt: now }),
      name,
    );
    await rejects(
      withItem,
      (tx, b) => reservation(tx, b, { status: "confirmed", confirmedAt: now, releasedAt: now }),
      name,
    );
    await rejects(withItem, (tx, b) => reservation(tx, b, { status: "pierdut" }), name);
  });

  it("referința generică are formă stabilă", async () => {
    await rejects(
      withItem,
      (tx, b) => reservation(tx, b, { refType: "Plata" }),
      "stock_reservation_ref_check",
    );
    await rejects(
      withItem,
      (tx, b) => reservation(tx, b, { refId: "" }),
      "stock_reservation_ref_check",
    );
  });
});

describe("StockCommitment (angajat, cu referință generică)", () => {
  const commitment = (
    tx: TestTx,
    b: Awaited<ReturnType<typeof withItem>>,
    over: Record<string, unknown> = {},
  ) =>
    tx.stockCommitment.create({
      data: {
        variantId: b.variant.id,
        warehouseId: b.warehouse.id,
        quantity: 10_000n,
        refType: "order",
        refId: "order-1",
        ...over,
      },
    });

  it("aceeași comandă nu poate angaja de două ori aceeași linie", async () => {
    await rejects(
      withItem,
      async (tx, b) => {
        await commitment(tx, b);
        await commitment(tx, b);
      },
      "stock_commitment_ref_key",
    );
    // altă comandă, același produs: permis
    await accepts(withItem, async (tx, b) => {
      await commitment(tx, b);
      await commitment(tx, b, { refId: "order-2" });
    });
    // aceeași comandă, altă variantă: permis
    await accepts(withItem, async (tx, b) => {
      await commitment(tx, b);
      const v2 = await tx.productVariant.create({
        data: { productId: b.product.id, sku: `SKU-${uid()}`, price: 1000 },
      });
      await tx.inventoryItem.create({ data: { variantId: v2.id, warehouseId: b.warehouse.id } });
      await commitment(tx, b, { variantId: v2.id });
    });
    // unicitatea ține chiar și după ce comanda a fost eliberată (nu se re-angajează aceeași comandă)
    await rejects(
      withItem,
      async (tx, b) => {
        const c = await commitment(tx, b);
        await tx.stockCommitment.update({
          where: { id: c.id },
          data: { status: "released", releasedAt: new Date() },
        });
        await commitment(tx, b);
      },
      "stock_commitment_ref_key",
    );
  });

  it("cantitate strict pozitivă; doar pe un rând de stoc existent", async () => {
    for (const quantity of [0n, -1n, CAP + 1n]) {
      await rejects(
        withItem,
        (tx, b) => commitment(tx, b, { quantity }),
        "stock_commitment_quantity_check",
      );
    }
    await rejects(
      base,
      (tx, b) =>
        tx.stockCommitment.create({
          data: {
            variantId: b.variant.id,
            warehouseId: b.warehouse.id,
            quantity: 10_000n,
            refType: "order",
            refId: "o",
          },
        }),
      "stock_commitment_variantId_warehouseId_fkey",
    );
  });

  it("starea și momentele ei sunt coerente (una setată, una nulă)", async () => {
    const name = "stock_commitment_status_check";
    const now = new Date();
    await accepts(withItem, (tx, b) => commitment(tx, b, { status: "open" }));
    await accepts(withItem, (tx, b) => commitment(tx, b, { status: "open", invoicedAt: now }));
    await accepts(withItem, (tx, b) =>
      commitment(tx, b, { status: "mirrored", mirroredAt: now, invoicedAt: now }),
    );
    await accepts(withItem, (tx, b) => commitment(tx, b, { status: "released", releasedAt: now }));
    await rejects(withItem, (tx, b) => commitment(tx, b, { status: "mirrored" }), name);
    await rejects(withItem, (tx, b) => commitment(tx, b, { status: "released" }), name);
    await rejects(
      withItem,
      (tx, b) => commitment(tx, b, { status: "open", mirroredAt: now }),
      name,
    );
    await rejects(
      withItem,
      (tx, b) => commitment(tx, b, { status: "open", releasedAt: now }),
      name,
    );
    await rejects(
      withItem,
      (tx, b) => commitment(tx, b, { status: "mirrored", mirroredAt: now, releasedAt: now }),
      name,
    );
    await rejects(withItem, (tx, b) => commitment(tx, b, { status: "altceva" }), name);
  });

  it("referința generică are formă stabilă", async () => {
    await rejects(
      withItem,
      (tx, b) => commitment(tx, b, { refType: "Comanda" }),
      "stock_commitment_ref_check",
    );
    await rejects(
      withItem,
      (tx, b) => commitment(tx, b, { refId: "" }),
      "stock_commitment_ref_check",
    );
  });
});

describe("BackInStockAlert", () => {
  const alert = (tx: TestTx, variantId: string, over: Record<string, unknown> = {}) =>
    tx.backInStockAlert.create({ data: { variantId, email: "client@example.test", ...over } });

  it("o cerere în așteptare per variantă și adresă (fără diferență de majuscule)", async () => {
    await rejects(
      base,
      async (tx, b) => {
        await alert(tx, b.variant.id);
        await alert(tx, b.variant.id, { email: "CLIENT@example.test" });
      },
      "back_in_stock_alert_pending_key",
    );
    await accepts(base, async (tx, b) => {
      const first = await alert(tx, b.variant.id);
      await tx.backInStockAlert.update({
        where: { id: first.id },
        data: { notifiedAt: new Date() },
      });
      await alert(tx, b.variant.id); // după trimitere, aceeași adresă poate cere din nou
    });
  });

  it("adresa are formă minimă și lungime limitată", async () => {
    for (const email of ["fara-arond", "@example.test", "a".repeat(250) + "@x.ro", ""]) {
      await rejects(
        base,
        (tx, b) => alert(tx, b.variant.id, { email }),
        "back_in_stock_alert_email_check",
      );
    }
  });

  it("dispare odată cu varianta", async () => {
    await accepts(base, async (tx, b) => {
      await alert(tx, b.variant.id);
      await tx.productVariant.delete({ where: { id: b.variant.id } });
      expect(await tx.backInStockAlert.count({ where: { variantId: b.variant.id } })).toBe(0);
    });
  });
});

describe("constantele din cod oglindesc constrângerile din bază", () => {
  it("baza de preț, modul SmartBill și sursa pozei", async () => {
    for (const priceBasis of PRICE_BASES) {
      await accepts(base, (tx, b) =>
        tx.product.update({ where: { id: b.product.id }, data: { priceBasis } }),
      );
      await accepts(base, (tx, b) =>
        tx.productVariant.update({ where: { id: b.variant.id }, data: { priceBasis } }),
      );
    }
    for (const smartbillMode of SMARTBILL_MODES) {
      await accepts(base, (tx, b) =>
        tx.productVariant.update({
          where: { id: b.variant.id },
          data: { smartbillMode, smartbillRatio: smartbillMode === "ratio" ? 10_000 : null },
        }),
      );
    }
    for (const source of SNAPSHOT_SOURCES) {
      await accepts(base, (tx, b) =>
        tx.stockSnapshot.create({
          data: { warehouseId: b.warehouse.id, takenAt: new Date(), source },
        }),
      );
    }
  });

  it("tipurile de mișcare și motivele ajustărilor", async () => {
    for (const kind of STOCK_MOVEMENT_KINDS) {
      await accepts(base, async (tx, b) => {
        const snapshot =
          kind === "snapshot"
            ? await tx.stockSnapshot.create({
                data: { warehouseId: b.warehouse.id, takenAt: new Date(), source: "import" },
              })
            : null;
        await tx.stockMovement.create({
          data: {
            variantId: b.variant.id,
            warehouseId: b.warehouse.id,
            kind,
            reason: kind === "adjustment" ? "other" : null,
            note: kind === "adjustment" ? "Corecție" : null,
            snapshotId: snapshot?.id ?? null,
            deltaPhysical: 10_000n,
            physicalAfter: 10_000n,
            committedAfter: 0n,
          },
        });
      });
    }
    for (const reason of ADJUSTMENT_REASONS) {
      await accepts(base, (tx, b) =>
        tx.stockMovement.create({
          data: {
            variantId: b.variant.id,
            warehouseId: b.warehouse.id,
            kind: "adjustment",
            reason,
            note: "Motiv de test",
            deltaPhysical: 10_000n,
            physicalAfter: 10_000n,
            committedAfter: 0n,
          },
        }),
      );
    }
  });

  it("stările rezervărilor și ale angajărilor", async () => {
    const now = new Date();
    for (const status of RESERVATION_STATUSES) {
      await accepts(withItem, (tx, b) =>
        tx.stockReservation.create({
          data: {
            variantId: b.variant.id,
            warehouseId: b.warehouse.id,
            quantity: 10_000n,
            status,
            refType: "checkout",
            refId: "r",
            expiresAt: now,
            confirmedAt: status === "confirmed" ? now : null,
            releasedAt: status === "released" || status === "expired" ? now : null,
          },
        }),
      );
    }
    for (const status of COMMITMENT_STATUSES) {
      await accepts(withItem, (tx, b) =>
        tx.stockCommitment.create({
          data: {
            variantId: b.variant.id,
            warehouseId: b.warehouse.id,
            quantity: 10_000n,
            status,
            refType: "order",
            refId: "o",
            mirroredAt: status === "mirrored" ? now : null,
            releasedAt: status === "released" ? now : null,
          },
        }),
      );
    }
  });
});
