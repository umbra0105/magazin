import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { MAX_QUANTITY, parseQuantity, parseSignedDelta, type Quantity } from "@ecom/shared";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  addStockProduct,
  createStockContext,
  type ProductSpec,
  type StockContext,
} from "../test-utils/stock-fixtures";
import type { AdjustmentReason } from "./constants";
import { StockService } from "./stock-service";

/**
 * Faza 5, punctul 6: ajustările fizice cu ora efectivă, pe baza reală (tranzacție anulată). Concurența e în
 * `stock-concurrency.integration.test.ts`. Testul nu presupune date de seed: depozitul implicit îl creează `runBaseSeed`
 * în propria tranzacție, iar unitățile de care e nevoie le creează testul.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const q = (text: string): Quantity => parseQuantity(text);
const T0 = new Date("2026-10-22T10:00:00Z");
const minutes = (base: Date, n: number): Date => new Date(base.getTime() + n * 60_000);
const at = (hhmm: string): Date => new Date(`2026-10-22T${hhmm}:00Z`);

interface AdjustOptions {
  reason?: AdjustmentReason;
  note?: string;
  effectiveAt?: Date;
  warehouseId?: string;
}

interface Harness {
  tx: TestTx;
  ctx: StockContext;
  service: StockService;
  setClock: (date: Date) => void;
  product: (physical: string | null, spec?: ProductSpec) => Promise<{ id: string; sku: string }>;
  adjust: (
    variantId: string,
    delta: string,
    options?: AdjustOptions,
  ) => ReturnType<StockService["adjustPhysical"]>;
  photo: (variantId: string, takenAt: Date, quantity: string) => Promise<unknown>;
  item: (
    variantId: string,
    warehouseId?: string,
  ) => Promise<{
    physical: bigint;
    committed: bigint;
    reserved: bigint;
    physicalAsOf: Date | null;
  }>;
  movements: (
    variantId: string,
    kind?: string,
  ) => Promise<
    Array<{
      kind: string;
      reason: string | null;
      note: string | null;
      deltaPhysical: bigint;
      deltaCommitted: bigint;
      physicalAfter: bigint;
      committedAfter: bigint;
      effectiveAt: Date;
      actorId: string | null;
      actorLabel: string | null;
      snapshotId: string | null;
    }>
  >;
  /** Suma variațiilor din registru = stocul fizic (doar pentru variantele fără stoc inițial «din fixture») */
  ledgerBalances: (variantId: string) => Promise<void>;
}

async function withStock<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const ctx = await createStockContext(tx, { useDefaultWarehouse: true });
    let clock = T0;
    const service = new StockService({ db: tx, now: () => clock });
    const h: Harness = {
      tx,
      ctx,
      service,
      setClock: (date) => {
        clock = date;
      },
      product: async (physical, spec = {}) => {
        const created = await addStockProduct(tx, ctx, { ...spec, variants: [{ physical }] });
        return created.variants[0]!;
      },
      adjust: (variantId, delta, options = {}) =>
        service.adjustPhysical({
          variantId,
          delta: parseSignedDelta(delta),
          reason: options.reason ?? "inventory_correction",
          note: options.note ?? "Probă",
          ...(options.effectiveAt && { effectiveAt: options.effectiveAt }),
          ...(options.warehouseId && { warehouseId: options.warehouseId }),
          actor: { id: "u-test", label: "test@magazin.test" },
        }),
      photo: async (variantId, takenAt, quantity) => {
        const snapshot = await tx.stockSnapshot.create({
          data: { warehouseId: ctx.warehouseId, takenAt, source: "import" },
        });
        return service.applySnapshot({
          variantId,
          snapshotId: snapshot.id,
          quantity: q(quantity),
          takenAt,
          safetyWindowMinutes: 30,
        });
      },
      item: async (variantId, warehouseId) =>
        tx.inventoryItem.findUniqueOrThrow({
          where: {
            variantId_warehouseId: { variantId, warehouseId: warehouseId ?? ctx.warehouseId },
          },
          select: { physical: true, committed: true, reserved: true, physicalAsOf: true },
        }),
      movements: async (variantId, kind) =>
        tx.stockMovement.findMany({
          where: { variantId, ...(kind && { kind }) },
          orderBy: [{ effectiveAt: "asc" }, { kind: "asc" }],
        }),
      ledgerBalances: async (variantId) => {
        const all = await tx.stockMovement.findMany({ where: { variantId } });
        const sum = all.reduce((total, m) => total + m.deltaPhysical, 0n);
        expect(sum).toBe((await h.item(variantId)).physical);
        const check = await service.checkConsistency(variantId);
        expect(check.ok).toBe(true);
      },
    };
    return fn(h);
  });
}

async function failure(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; message: string; details?: Record<string, unknown> } | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as { code?: string; message: string; details?: Record<string, unknown> };
  }
}

describe("ajustarea fizică: efectul și registrul", () => {
  it("scade stocul, scrie o mișcare imuabilă cu motiv, text, autor și ora efectivă; nu atinge «valabil la»", async () => {
    await withStock(async (h) => {
      const p = await h.product("10");
      const result = await h.adjust(p.id, "-3", {
        reason: "sale_in_store",
        note: "  Vândut la tejghea, bon 123  ",
      });
      expect(result).toMatchObject({
        variantId: p.id,
        warehouseId: h.ctx.warehouseId,
        delta: -q("3"),
        physicalBefore: q("10"),
        physicalAfter: q("7"),
        effectiveAt: T0,
        warnings: [],
      });
      expect(await h.item(p.id)).toMatchObject({
        physical: q("7"),
        committed: 0n,
        reserved: 0n,
        physicalAsOf: null,
      });
      const [movement, ...rest] = await h.movements(p.id);
      expect(rest).toEqual([]);
      expect(movement).toMatchObject({
        kind: "adjustment",
        reason: "sale_in_store",
        note: "Vândut la tejghea, bon 123",
        deltaPhysical: -q("3"),
        deltaCommitted: 0n,
        physicalAfter: q("7"),
        committedAfter: 0n,
        effectiveAt: T0,
        actorId: "u-test",
        actorLabel: "test@magazin.test",
        snapshotId: null,
      });
      const row = await h.tx.stockMovement.findFirstOrThrow({ where: { variantId: p.id } });
      expect(row.id).toBe(result.movementId);
    });
  });

  it("o recepție adaugă; ajustarea poate duce stocul exact la zero", async () => {
    await withStock(async (h) => {
      const p = await h.product("2");
      await h.adjust(p.id, "+5", { reason: "receipt" });
      expect((await h.item(p.id)).physical).toBe(q("7"));
      await h.adjust(p.id, "-7", { reason: "lost_stolen" });
      expect((await h.item(p.id)).physical).toBe(0n);
    });
  });

  it("o variantă gestionată fără rând de stoc primește rândul la prima ajustare (prima intrare în gestiune)", async () => {
    await withStock(async (h) => {
      const p = await h.product(null);
      expect(await h.tx.inventoryItem.count({ where: { variantId: p.id } })).toBe(0);
      await h.adjust(p.id, "+5", { reason: "inventory_correction", note: "Prima numărătoare" });
      expect(await h.item(p.id)).toMatchObject({ physical: q("5"), physicalAsOf: null });
      await h.ledgerBalances(p.id);
    });
  });

  it("depozitul implicit e cel folosit când nu se spune altul; altul se alege explicit și celălalt rămâne neatins", async () => {
    await withStock(async (h) => {
      const p = await h.product("10");
      const other = await h.tx.warehouse.create({
        data: { code: `w_${h.ctx.tag}x`, name: "Alt depozit" },
      });
      await h.tx.inventoryItem.create({
        data: { variantId: p.id, warehouseId: other.id, physical: q("4") },
      });
      await h.adjust(p.id, "-1", { warehouseId: other.id });
      expect((await h.item(p.id, other.id)).physical).toBe(q("3"));
      expect((await h.item(p.id)).physical).toBe(q("10"));
      await h.adjust(p.id, "-2");
      expect((await h.item(p.id)).physical).toBe(q("8"));
      expect((await h.item(p.id, other.id)).physical).toBe(q("3"));
    });
  });
});

describe("refuz sub zero și peste plafon", () => {
  it("nu lasă stocul sub 0: nimic nu se schimbă, nu apare nicio mișcare, spune cât există", async () => {
    await withStock(async (h) => {
      const p = await h.product("2");
      const error = await failure(() => h.adjust(p.id, "-3", { reason: "damaged" }));
      expect(error?.code).toBe("STOCK_ADJUSTMENT_BELOW_ZERO");
      expect(error?.details).toMatchObject({ available: q("2").toString() });
      expect((await h.item(p.id)).physical).toBe(q("2"));
      expect(await h.movements(p.id)).toEqual([]);
    });
  });

  it("pe o variantă fără rând de stoc, o scădere se refuză și NU lasă un rând gol în urmă", async () => {
    await withStock(async (h) => {
      const p = await h.product(null);
      const error = await failure(() => h.adjust(p.id, "-1", { reason: "damaged" }));
      expect(error?.code).toBe("STOCK_ADJUSTMENT_BELOW_ZERO");
      expect(await h.tx.inventoryItem.count({ where: { variantId: p.id } })).toBe(0);
      expect(await h.movements(p.id)).toEqual([]);
    });
  });

  it("nu trece de plafonul cantităților", async () => {
    await withStock(async (h) => {
      // unitate cu 4 zecimale (cea a fixture-ului, prin pas): altfel precizia ar refuza mai devreme
      const p = await h.product("0", { step: "1" });
      await h.tx.inventoryItem.update({
        where: {
          variantId_warehouseId: { variantId: p.id, warehouseId: h.ctx.warehouseId },
        },
        data: { physical: MAX_QUANTITY - 1n },
      });
      const error = await failure(() => h.adjust(p.id, "+0,0002", { reason: "receipt" }));
      expect(error?.code).toBe("STOCK_ADJUSTMENT_OVERFLOW");
      expect((await h.item(p.id)).physical).toBe(MAX_QUANTITY - 1n);
      await h.adjust(p.id, "+0,0001", { reason: "receipt" });
      expect((await h.item(p.id)).physical).toBe(MAX_QUANTITY);
    });
  });
});

describe("precizia unității; pasul de vânzare nu se aplică la ajustări fizice", () => {
  async function unit(h: Harness, decimals: number) {
    return h.tx.measureUnit.create({
      data: {
        code: `u_${h.ctx.tag}d${decimals}`,
        name: `Unitate ${decimals}`,
        symbol: "u",
        decimals,
      },
    });
  }

  it("fără unitate (= «buc», 0 zecimale): 2 da, 0,5 nu", async () => {
    await withStock(async (h) => {
      const p = await h.product("5");
      await h.adjust(p.id, "+2", { reason: "receipt" });
      const error = await failure(() => h.adjust(p.id, "+0,5", { reason: "receipt" }));
      expect(error?.code).toBe("STOCK_ADJUSTMENT_PRECISION");
      expect(error?.details).toMatchObject({ decimals: 0 });
      expect((await h.item(p.id)).physical).toBe(q("7"));
    });
  });

  it("unitate cu 2 zecimale pe produs: 0,25 da, 0,255 nu", async () => {
    await withStock(async (h) => {
      const p = await h.product("10");
      const mp = await unit(h, 2);
      await h.tx.product.updateMany({
        where: { variants: { some: { id: p.id } } },
        data: { measureUnitId: mp.id },
      });
      await h.adjust(p.id, "-0,25");
      expect((await h.item(p.id)).physical).toBe(q("9,75"));
      const error = await failure(() => h.adjust(p.id, "-0,255"));
      expect(error?.code).toBe("STOCK_ADJUSTMENT_PRECISION");
      expect(error?.details).toMatchObject({ decimals: 2 });
    });
  });

  it("unitatea variantei bate unitatea produsului", async () => {
    await withStock(async (h) => {
      const p = await h.product("10");
      const mp = await unit(h, 2);
      const strict = await unit(h, 0);
      await h.tx.product.updateMany({
        where: { variants: { some: { id: p.id } } },
        data: { measureUnitId: mp.id },
      });
      await h.tx.productVariant.update({ where: { id: p.id }, data: { measureUnitId: strict.id } });
      const error = await failure(() => h.adjust(p.id, "-0,25"));
      expect(error?.code).toBe("STOCK_ADJUSTMENT_PRECISION");
      await h.adjust(p.id, "-1");
      expect((await h.item(p.id)).physical).toBe(q("9"));
    });
  });

  it("pasul de vânzare nu limitează ajustarea: rola de 41,25 mp se poate scădea cu 1 mp sau cu 0,0001", async () => {
    await withStock(async (h) => {
      const p = await h.product("100", { step: "41,25" });
      await h.adjust(p.id, "-1", { reason: "damaged" });
      await h.adjust(p.id, "-0,0001", { reason: "damaged" });
      expect((await h.item(p.id)).physical).toBe(q("98,9999"));
    });
  });
});

describe("validări: motiv, text, semn, ora efectivă", () => {
  it("motiv necunoscut, text lipsă sau doar spații, text prea lung, variație zero", async () => {
    await withStock(async (h) => {
      const p = await h.product("10");
      const base = { variantId: p.id, delta: parseSignedDelta("-1") };
      const call = (override: Record<string, unknown>) =>
        failure(() =>
          h.service.adjustPhysical({
            ...base,
            reason: "other",
            note: "ok",
            ...override,
          } as Parameters<StockService["adjustPhysical"]>[0]),
        );
      expect((await call({ reason: "altceva" }))?.code).toBe("STOCK_ADJUSTMENT_INVALID_REASON");
      expect((await call({ note: "" }))?.code).toBe("STOCK_ADJUSTMENT_NOTE_REQUIRED");
      expect((await call({ note: "   \n " }))?.code).toBe("STOCK_ADJUSTMENT_NOTE_REQUIRED");
      expect((await call({ note: "x".repeat(501) }))?.code).toBe("STOCK_ADJUSTMENT_NOTE_TOO_LONG");
      expect((await call({ delta: parseSignedDelta("0") }))?.code).toBe("STOCK_ADJUSTMENT_ZERO");
      expect((await call({ note: "x".repeat(500) })) === null).toBe(true);
      expect((await h.item(p.id)).physical).toBe(q("9"));
      expect(await h.movements(p.id)).toHaveLength(1);
    });
  });

  it("semnul trebuie să fie cel al motivului: vânzarea/deteriorarea/furtul scad, recepția adaugă, restul oricum", async () => {
    await withStock(async (h) => {
      const p = await h.product("10");
      const sign = async (delta: string, reason: AdjustmentReason) =>
        (await failure(() => h.adjust(p.id, delta, { reason })))?.code ?? "ok";
      expect(await sign("+1", "sale_in_store")).toBe("STOCK_ADJUSTMENT_WRONG_SIGN");
      expect(await sign("+1", "damaged")).toBe("STOCK_ADJUSTMENT_WRONG_SIGN");
      expect(await sign("+1", "lost_stolen")).toBe("STOCK_ADJUSTMENT_WRONG_SIGN");
      expect(await sign("-1", "receipt")).toBe("STOCK_ADJUSTMENT_WRONG_SIGN");
      expect(await sign("-1", "sale_in_store")).toBe("ok");
      expect(await sign("+1", "receipt")).toBe("ok");
      expect(await sign("-1", "return")).toBe("ok");
      expect(await sign("+1", "return")).toBe("ok");
      expect(await sign("-1", "inventory_correction")).toBe("ok");
      expect(await sign("+1", "other")).toBe("ok");
    });
  });

  it("ora efectivă: implicit acum; trecutul se acceptă; viitorul peste un minut nu", async () => {
    await withStock(async (h) => {
      const p = await h.product("20");
      expect((await h.adjust(p.id, "-1")).effectiveAt).toEqual(T0);
      expect(
        (await h.adjust(p.id, "-1", { effectiveAt: minutes(T0, -3 * 24 * 60) })).effectiveAt,
      ).toEqual(minutes(T0, -3 * 24 * 60));
      expect((await h.adjust(p.id, "-1", { effectiveAt: minutes(T0, 1) })).effectiveAt).toEqual(
        minutes(T0, 1),
      );
      const future = await failure(() =>
        h.adjust(p.id, "-1", { effectiveAt: new Date(T0.getTime() + 60_001) }),
      );
      expect(future?.code).toBe("STOCK_ADJUSTMENT_FUTURE");
      const invalid = await failure(() => h.adjust(p.id, "-1", { effectiveAt: new Date("x") }));
      expect(invalid?.code).toBe("STOCK_ADJUSTMENT_INVALID_TIME");
      expect((await h.item(p.id)).physical).toBe(q("17"));
    });
  });
});

describe("ce produse au stoc de ajustat", () => {
  it("negestionat și digital: refuz clar, fără rând de stoc și fără mișcare", async () => {
    await withStock(async (h) => {
      const unmanaged = await h.product(null, { manageStock: false });
      const digital = await h.product(null, { type: "digital" });
      for (const p of [unmanaged, digital]) {
        const error = await failure(() => h.adjust(p.id, "+5", { reason: "receipt" }));
        expect(error?.code).toBe("STOCK_NOT_MANAGED");
        expect(await h.tx.inventoryItem.count({ where: { variantId: p.id } })).toBe(0);
        expect(await h.movements(p.id)).toEqual([]);
      }
    });
  });

  it("bifa de pe variantă bate bifa produsului, în ambele sensuri", async () => {
    await withStock(async (h) => {
      const managedProduct = await h.product("5");
      await h.tx.productVariant.update({
        where: { id: managedProduct.id },
        data: { manageStock: false },
      });
      expect((await failure(() => h.adjust(managedProduct.id, "-1")))?.code).toBe(
        "STOCK_NOT_MANAGED",
      );

      const unmanagedProduct = await h.product(null, { manageStock: false });
      await h.tx.productVariant.update({
        where: { id: unmanagedProduct.id },
        data: { manageStock: true },
      });
      await h.adjust(unmanagedProduct.id, "+3", { reason: "receipt" });
      expect((await h.item(unmanagedProduct.id)).physical).toBe(q("3"));
    });
  });

  it("variantă inexistentă", async () => {
    await withStock(async (h) => {
      const error = await failure(() => h.adjust("nu-exista", "+1", { reason: "receipt" }));
      expect(error?.code).toBe("STOCK_VARIANT_NOT_FOUND");
    });
  });
});

describe("avertismente (ajustarea se aplică, dar utilizatorul trebuie să știe)", () => {
  it("ora efectivă dinaintea (sau la ora) pozei deja aplicate: posibilă dublă scădere până la poza următoare", async () => {
    await withStock(async (h) => {
      const p = await h.product(null);
      h.setClock(at("10:10"));
      await h.photo(p.id, at("10:00"), "4");
      expect(
        (await h.adjust(p.id, "-1", { reason: "sale_in_store", effectiveAt: at("09:50") }))
          .warnings,
      ).toEqual(["effective_before_snapshot"]);
      expect(
        (await h.adjust(p.id, "-1", { reason: "sale_in_store", effectiveAt: at("10:00") }))
          .warnings,
      ).toEqual(["effective_before_snapshot"]);
      expect(
        (await h.adjust(p.id, "+1", { reason: "receipt", effectiveAt: at("10:05") })).warnings,
      ).toEqual([]);
      expect((await h.item(p.id)).physical).toBe(q("3"));
    });
  });

  it("fără nicio poză aplicată nu există avertisment de poză", async () => {
    await withStock(async (h) => {
      const p = await h.product("5");
      expect((await h.adjust(p.id, "-1", { effectiveAt: minutes(T0, -600) })).warnings).toEqual([]);
    });
  });

  it("stocul scade sub ce e angajat sau rezervat: se permite (marfa lipsește pe bune), dar cu avertisment", async () => {
    await withStock(async (h) => {
      const p = await h.product("5");
      await h.service.commitDirect({ refType: "order", refId: `${h.ctx.tag}-o1` }, [
        { variantId: p.id, quantity: q("4") },
      ]);
      // 5 → 4: fizicul egalează angajatul, fără avertisment
      expect((await h.adjust(p.id, "-1", { reason: "damaged" })).warnings).toEqual([]);
      // 4 → 1: sub angajat
      const result = await h.adjust(p.id, "-3", { reason: "damaged" });
      expect(result.warnings).toEqual(["below_commitments"]);
      expect(await h.item(p.id)).toMatchObject({ physical: q("1"), committed: q("4") });
      expect((await h.service.checkConsistency(p.id)).ok).toBe(true);
    });
  });
});

describe("poza SmartBill înlocuiește ajustările dinainte, le păstrează pe cele de după (D1.4)", () => {
  it("cronologia din plan: vânzarea din magazin de la 11:00 trăiește până la poza care o conține", async () => {
    await withStock(async (h) => {
      const p = await h.product(null);
      h.setClock(at("10:05"));
      await h.photo(p.id, at("10:00"), "4");
      expect((await h.item(p.id)).physical).toBe(q("4"));

      // 11:05: notez vânzarea de la 11:00 (SmartBill încă nu o știe)
      h.setClock(at("11:05"));
      const sale = await h.adjust(p.id, "-1", {
        reason: "sale_in_store",
        effectiveAt: at("11:00"),
      });
      expect(sale.warnings).toEqual([]);
      expect((await h.item(p.id)).physical).toBe(q("3"));

      // o poză de la 10:30 (SmartBill: 4) apare după aceea: vânzarea e după ea, deci rămâne
      h.setClock(at("11:10"));
      await h.photo(p.id, at("10:30"), "4");
      expect((await h.item(p.id)).physical).toBe(q("3"));

      // poza de la 12:00 (SmartBill: 3) conține vânzarea: o înlocuiește, nu se scade a doua oară
      h.setClock(at("12:05"));
      await h.photo(p.id, at("12:00"), "3");
      expect((await h.item(p.id)).physical).toBe(q("3"));
      await h.ledgerBalances(p.id);
    });
  });

  it("ora efectivă corectată înaintea pozei deja aplicate: scade acum (risc acceptat), dar poza următoare o înlocuiește", async () => {
    await withStock(async (h) => {
      const p = await h.product(null);
      h.setClock(at("10:10"));
      await h.photo(p.id, at("10:00"), "4");
      const late = await h.adjust(p.id, "-1", {
        reason: "sale_in_store",
        effectiveAt: at("09:50"),
      });
      expect(late.warnings).toEqual(["effective_before_snapshot"]);
      expect((await h.item(p.id)).physical).toBe(q("3"));
      h.setClock(at("11:05"));
      await h.photo(p.id, at("11:00"), "4");
      expect((await h.item(p.id)).physical).toBe(q("4"));
    });
  });

  it("marginea: ajustarea LA ora pozei e înlocuită, cea cu o milisecundă după rămâne", async () => {
    await withStock(async (h) => {
      const exact = await h.product(null);
      h.setClock(at("10:05"));
      await h.photo(exact.id, at("10:00"), "5");
      h.setClock(at("11:00"));
      await h.adjust(exact.id, "-1", { effectiveAt: at("10:30") });
      await h.photo(exact.id, at("10:30"), "5");
      expect((await h.item(exact.id)).physical).toBe(q("5"));

      const after = await h.product(null);
      h.setClock(at("10:05"));
      await h.photo(after.id, at("10:00"), "5");
      h.setClock(at("11:00"));
      await h.adjust(after.id, "-1", { effectiveAt: new Date(at("10:30").getTime() + 1) });
      await h.photo(after.id, at("10:30"), "5");
      expect((await h.item(after.id)).physical).toBe(q("4"));
    });
  });

  it("recepții și vânzări amestecate: la poza de 10:30 rămân doar cele de după ea", async () => {
    await withStock(async (h) => {
      const p = await h.product(null);
      h.setClock(at("10:05"));
      await h.photo(p.id, at("10:00"), "10");
      h.setClock(at("11:00"));
      await h.adjust(p.id, "+5", { reason: "receipt", effectiveAt: at("10:20") });
      await h.adjust(p.id, "-2", { reason: "sale_in_store", effectiveAt: at("10:40") });
      expect((await h.item(p.id)).physical).toBe(q("13"));
      await h.photo(p.id, at("10:30"), "10");
      // recepția de la 10:20 e în poză (înlocuită); vânzarea de la 10:40 rămâne
      expect((await h.item(p.id)).physical).toBe(q("8"));
      await h.ledgerBalances(p.id);
    });
  });

  it("mișcarea pozei și cea de ajustare au fiecare ora ei efectivă; ajustarea înlocuită rămâne în istoric", async () => {
    await withStock(async (h) => {
      const p = await h.product(null);
      h.setClock(at("10:05"));
      await h.photo(p.id, at("10:00"), "4");
      h.setClock(at("11:05"));
      await h.adjust(p.id, "-1", { reason: "sale_in_store", effectiveAt: at("11:00") });
      h.setClock(at("12:05"));
      await h.photo(p.id, at("12:00"), "3");
      // poza de la 12:00 (3) coincide cu stocul de după ajustare: nu mai produce mișcare, iar ajustarea înlocuită
      // rămâne în istoric, neatinsă (istoricul e imuabil: registrul nu șterge, doar adaugă)
      const kinds = (await h.movements(p.id)).map(
        (m) => `${m.kind}:${m.effectiveAt.toISOString().slice(11, 16)}`,
      );
      expect(kinds).toEqual(["snapshot:10:00", "adjustment:11:00"]);
      const [adjustment] = await h.movements(p.id, "adjustment");
      expect(adjustment).toMatchObject({ deltaPhysical: -q("1"), reason: "sale_in_store" });
      await h.ledgerBalances(p.id);
    });
  });
});
