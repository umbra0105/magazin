import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { formatQuantity, parseQuantity, parseSignedDelta, type Quantity } from "@ecom/shared";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  addStockProduct,
  createStockContext,
  type ProductSpec,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { computeAvailability } from "./availability";
import { StockService } from "./stock-service";

/**
 * Faza 5, punctul 5, logica deterministă a serviciului de stoc pe baza reală (tranzacție anulată): clasificarea liniilor,
 * rezervare, eliberare, confirmare, angajare directă, oglindire, expirare, consistență. Concurența e în
 * `stock-concurrency.integration.test.ts`.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const q = (text: string): Quantity => parseQuantity(text);
const T0 = new Date("2026-10-21T10:00:00Z");
const minutes = (base: Date, n: number): Date => new Date(base.getTime() + n * 60_000);

interface Harness {
  tx: TestTx;
  ctx: StockContext;
  service: StockService;
  setClock: (date: Date) => void;
  ref: (name: string) => { refType: string; refId: string };
  /** Linie în depozitul implicit */
  line: (variantId: string, quantity: string) => { variantId: string; quantity: Quantity };
  /** Un produs gestionat cu o variantă și stocul dat */
  product: (physical: string | null, spec?: ProductSpec) => Promise<{ id: string; sku: string }>;
  item: (variantId: string) => Promise<{ physical: bigint; committed: bigint; reserved: bigint }>;
  consistent: (variantId: string) => Promise<void>;
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
      ref: (name) => ({ refType: "order", refId: `${ctx.tag}-${name}` }),
      line: (variantId, quantity) => ({ variantId, quantity: q(quantity) }),
      product: async (physical, spec = {}) => {
        const created = await addStockProduct(tx, ctx, { ...spec, variants: [{ physical }] });
        return created.variants[0]!;
      },
      item: async (variantId) =>
        tx.inventoryItem.findUniqueOrThrow({
          where: { variantId_warehouseId: { variantId, warehouseId: ctx.warehouseId } },
          select: { physical: true, committed: true, reserved: true },
        }),
      consistent: async (variantId) => {
        const check = await service.checkConsistency(variantId);
        expect(
          check.ok,
          JSON.stringify(check, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
        ).toBe(true);
      },
    };
    return fn(h);
  });
}

async function failure(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; message: string; details?: unknown } | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as { code?: string; message: string; details?: unknown };
  }
}

describe("clasificarea liniilor: doar produsele gestionate rezervă", () => {
  it("digital, negestionat, «La comandă» (hibrid epuizat) nu rezervă nimic; gestionatul rezervă", async () => {
    await withStock(async (h) => {
      const managed = await h.product("5");
      const digital = await h.product(null, { type: "digital" });
      const unmanaged = await h.product(null, { manageStock: false });
      const hybrid = await h.product("0", { allowBackorder: true });
      const outcomes = await h.service.reserve(
        h.ref("mixt"),
        [
          h.line(managed.id, "2"),
          h.line(digital.id, "1"),
          h.line(unmanaged.id, "7"),
          h.line(hybrid.id, "3"),
        ],
        minutes(T0, 15),
      );
      expect(outcomes.map((o) => o.outcome)).toEqual([
        "reserved",
        "skipped_digital",
        "skipped_unmanaged",
        "skipped_on_order",
      ]);
      expect((await h.item(managed.id)).reserved).toBe(q("2"));
      // fără nicio rezervare sau rând de stoc pentru ce nu e gestionat
      expect(
        await h.tx.stockReservation.count({
          where: { variantId: { in: [digital.id, unmanaged.id, hybrid.id] } },
        }),
      ).toBe(0);
      expect(
        await h.tx.inventoryItem.count({
          where: { variantId: { in: [digital.id, unmanaged.id] } },
        }),
      ).toBe(0);
      await h.consistent(managed.id);
    });
  });

  it("gestiunea pe variantă suprascrie produsul (variantă negestionată într-un produs gestionat)", async () => {
    await withStock(async (h) => {
      const created = await addStockProduct(h.tx, h.ctx, { variants: [{ physical: "5" }] });
      await h.tx.productVariant.update({
        where: { id: created.variants[0]!.id },
        data: { manageStock: false },
      });
      const [outcome] = await h.service.reserve(
        h.ref("v"),
        [h.line(created.variants[0]!.id, "2")],
        minutes(T0, 15),
      );
      expect(outcome?.outcome).toBe("skipped_unmanaged");
      expect((await h.item(created.variants[0]!.id)).reserved).toBe(0n);
    });
  });

  it("gestionat fără rând de stoc: indisponibil (eroare) sau, cu hibrid, «La comandă»", async () => {
    await withStock(async (h) => {
      const plain = await h.product(null);
      const hybrid = await h.product(null, { allowBackorder: true });
      const error = await failure(() =>
        h.service.reserve(h.ref("a"), [h.line(plain.id, "1")], minutes(T0, 15)),
      );
      expect(error?.code).toBe("STOCK_INSUFFICIENT");
      const [outcome] = await h.service.reserve(
        h.ref("b"),
        [h.line(hybrid.id, "1")],
        minutes(T0, 15),
      );
      expect(outcome?.outcome).toBe("skipped_on_order");
    });
  });

  it("hibrid cu stoc parțial: nu depășește stocul (cere 5, sunt 2) și nu devine «La comandă»", async () => {
    await withStock(async (h) => {
      const hybrid = await h.product("2", { allowBackorder: true });
      const error = await failure(() =>
        h.service.reserve(h.ref("h"), [h.line(hybrid.id, "5")], minutes(T0, 15)),
      );
      expect(error?.code).toBe("STOCK_INSUFFICIENT");
      expect((await h.item(hybrid.id)).reserved).toBe(0n);
      expect(
        (await h.service.reserve(h.ref("h2"), [h.line(hybrid.id, "2")], minutes(T0, 15)))[0]
          ?.outcome,
      ).toBe("reserved");
    });
  });
});

describe("rezervare", () => {
  it("angajatul, rezervatul și tamponul se scad din ce se poate rezerva", async () => {
    await withStock(async (h) => {
      const p = await h.product("10");
      await h.tx.inventoryItem.updateMany({
        where: { variantId: p.id },
        data: { safetyBuffer: q("2") },
      });
      await h.service.commitDirect(h.ref("angajat"), [h.line(p.id, "3")]);
      await h.service.reserve(h.ref("rez"), [h.line(p.id, "2")], minutes(T0, 15));
      // 10 − 3 − 2 − 2 (tampon) = 3 rămase
      expect(
        (await h.service.reserve(h.ref("a"), [h.line(p.id, "3")], minutes(T0, 15)))[0]?.outcome,
      ).toBe("reserved");
      const error = await failure(() =>
        h.service.reserve(h.ref("b"), [h.line(p.id, "1")], minutes(T0, 15)),
      );
      expect(error?.code).toBe("STOCK_INSUFFICIENT");
      await h.consistent(p.id);
    });
  });

  it("refuzul spune pe linie cât se poate comanda (în pași) și nu lasă nimic rezervat", async () => {
    await withStock(async (h) => {
      const a = await h.product("100", { step: "41,25" });
      const b = await h.product("10");
      const error = await failure(() =>
        h.service.reserve(h.ref("x"), [h.line(b.id, "1"), h.line(a.id, "123,75")], minutes(T0, 15)),
      );
      expect(error?.code).toBe("STOCK_INSUFFICIENT");
      const lines = (
        error?.details as {
          lines: Array<{ variantId: string; maxSteps: string; requestedSteps: string }>;
        }
      ).lines;
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ variantId: a.id, requestedSteps: "3", maxSteps: "2" });
      expect((await h.item(b.id)).reserved).toBe(0n);
      expect(
        await h.tx.stockReservation.count({ where: { variantId: { in: [a.id, b.id] } } }),
      ).toBe(0);
    });
  });

  it("aceeași comandă, aceleași cantități: idempotent; alte cantități: nepotrivire", async () => {
    await withStock(async (h) => {
      const p = await h.product("10");
      expect(
        (await h.service.reserve(h.ref("i"), [h.line(p.id, "2")], minutes(T0, 15)))[0]?.outcome,
      ).toBe("reserved");
      expect(
        (await h.service.reserve(h.ref("i"), [h.line(p.id, "2")], minutes(T0, 15)))[0]?.outcome,
      ).toBe("already_reserved");
      expect((await h.item(p.id)).reserved).toBe(q("2"));
      const mismatch = await failure(() =>
        h.service.reserve(h.ref("i"), [h.line(p.id, "3")], minutes(T0, 15)),
      );
      expect(mismatch?.code).toBe("STOCK_RESERVATION_MISMATCH");
      expect((await h.item(p.id)).reserved).toBe(q("2"));
    });
  });

  it("liniile repetate ale aceleiași variante se adună într-o singură rezervare", async () => {
    await withStock(async (h) => {
      const p = await h.product("10");
      const outcomes = await h.service.reserve(
        h.ref("d"),
        [h.line(p.id, "1"), h.line(p.id, "2")],
        minutes(T0, 15),
      );
      expect(outcomes.map((o) => o.outcome)).toEqual(["reserved", "reserved"]);
      const rows = await h.tx.stockReservation.findMany({ where: { variantId: p.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.quantity).toBe(q("3"));
    });
  });

  it("cantitatea trebuie să fie pozitivă, multiplu de pas și ≥ minim; varianta trebuie să existe", async () => {
    await withStock(async (h) => {
      const p = await h.product("20", { step: "2,5", minSteps: 2 });
      expect(
        (await failure(() => h.service.reserve(h.ref("0"), [h.line(p.id, "0")], minutes(T0, 15))))
          ?.code,
      ).toBe("QUANTITY_NOT_POSITIVE");
      expect(
        (await failure(() => h.service.reserve(h.ref("1"), [h.line(p.id, "6")], minutes(T0, 15))))
          ?.code,
      ).toBe("QUANTITY_NOT_MULTIPLE_OF_STEP");
      expect(
        (await failure(() => h.service.reserve(h.ref("2"), [h.line(p.id, "2,5")], minutes(T0, 15))))
          ?.code,
      ).toBe("QUANTITY_BELOW_MINIMUM");
      expect(
        (await h.service.reserve(h.ref("3"), [h.line(p.id, "5")], minutes(T0, 15)))[0]?.outcome,
      ).toBe("reserved");
      expect(
        (
          await failure(() =>
            h.service.reserve(h.ref("4"), [h.line("nu-exista", "1")], minutes(T0, 15)),
          )
        )?.code,
      ).toBe("STOCK_VARIANT_NOT_FOUND");
      expect((await failure(() => h.service.reserve(h.ref("5"), [], minutes(T0, 15))))?.code).toBe(
        "VALIDATION_ERROR",
      );
    });
  });

  it("rezervările expirate ale rândului se eliberează la rezervarea următoare (fără să aștepte jobul)", async () => {
    await withStock(async (h) => {
      const p = await h.product("1");
      await h.service.reserve(h.ref("veche"), [h.line(p.id, "1")], minutes(T0, 15));
      expect(
        (
          await failure(() =>
            h.service.reserve(h.ref("alta"), [h.line(p.id, "1")], minutes(T0, 15)),
          )
        )?.code,
      ).toBe("STOCK_INSUFFICIENT");
      h.setClock(minutes(T0, 20));
      expect(
        (await h.service.reserve(h.ref("alta"), [h.line(p.id, "1")], minutes(T0, 35)))[0]?.outcome,
      ).toBe("reserved");
      const old = await h.tx.stockReservation.findFirstOrThrow({
        where: { refId: h.ref("veche").refId },
      });
      expect(old.status).toBe("expired");
      expect((await h.item(p.id)).reserved).toBe(q("1"));
      await h.consistent(p.id);
    });
  });
});

describe("eliberare și expirare", () => {
  it("eliberarea întoarce stocul o singură dată (idempotentă)", async () => {
    await withStock(async (h) => {
      const p = await h.product("5");
      await h.service.reserve(h.ref("e"), [h.line(p.id, "3")], minutes(T0, 15));
      expect(await h.service.release(h.ref("e"))).toBe(1);
      expect(await h.service.release(h.ref("e"))).toBe(0);
      expect((await h.item(p.id)).reserved).toBe(0n);
      const row = await h.tx.stockReservation.findFirstOrThrow({ where: { variantId: p.id } });
      expect(row).toMatchObject({ status: "released" });
      expect(row.releasedAt).not.toBeNull();
      // după eliberare, aceeași comandă poate rezerva din nou
      expect(
        (await h.service.reserve(h.ref("e"), [h.line(p.id, "3")], minutes(T0, 15)))[0]?.outcome,
      ).toBe("reserved");
      await h.consistent(p.id);
    });
  });

  it("jobul de expirare eliberează doar ce a expirat, o singură dată, cu filtru opțional pe variante", async () => {
    await withStock(async (h) => {
      const a = await h.product("5");
      const b = await h.product("5");
      await h.service.reserve(h.ref("a1"), [h.line(a.id, "1")], minutes(T0, 5));
      await h.service.reserve(h.ref("a2"), [h.line(a.id, "1")], minutes(T0, 30));
      await h.service.reserve(h.ref("b1"), [h.line(b.id, "1")], minutes(T0, 5));
      h.setClock(minutes(T0, 10));
      expect(await h.service.expireDue({ variantIds: [a.id] })).toEqual({ expired: 1, items: 1 });
      expect((await h.item(a.id)).reserved).toBe(q("1")); // a2 rămâne
      expect((await h.item(b.id)).reserved).toBe(q("1")); // filtrul n-a atins b
      expect(await h.service.expireDue({ variantIds: [a.id] })).toEqual({ expired: 0, items: 0 });
      expect((await h.service.expireDue()).expired).toBeGreaterThanOrEqual(1);
      expect((await h.item(b.id)).reserved).toBe(0n);
      await h.consistent(a.id);
      await h.consistent(b.id);
    });
  });

  it("citirea ține cont de expirare chiar înainte de job: rezervarea expirată nu mai blochează afișarea", async () => {
    await withStock(async (h) => {
      const p = await h.product("2");
      await h.service.reserve(h.ref("r"), [h.line(p.id, "2")], minutes(T0, 15));
      const view = async () => {
        const inventory = await h.service.readInventory(p.id);
        return computeAvailability({
          isDigital: false,
          manageStock: true,
          stockStatus: "instock",
          allowBackorder: false,
          step: q("1"),
          inventory,
          defaultLowStockSteps: 2,
          leadTime: { productDays: null, brandDays: null, globalDays: 14 },
        });
      };
      expect((await view()).state).toBe("unavailable");
      h.setClock(minutes(T0, 20));
      expect((await view()).state).toBe("limited");
      expect((await h.item(p.id)).reserved).toBe(q("2")); // contorul rămâne până la job; citirea e cea corectată
      expect((await h.service.readInventory(p.id))?.reserved).toBe(0n);
    });
  });
});

describe("confirmarea plății (rezervare → angajare)", () => {
  it("mută din rezervat în angajat, scrie angajarea și mișcarea «commit»", async () => {
    await withStock(async (h) => {
      const p = await h.product("5");
      await h.service.reserve(h.ref("p"), [h.line(p.id, "2")], minutes(T0, 15));
      const [outcome] = await h.service.confirmReservation(h.ref("p"));
      expect(outcome?.outcome).toBe("committed");
      const row = await h.item(p.id);
      expect(row).toMatchObject({ physical: q("5"), committed: q("2"), reserved: 0n });
      const commitment = await h.tx.stockCommitment.findFirstOrThrow({
        where: { variantId: p.id },
      });
      expect(commitment).toMatchObject({
        status: "open",
        quantity: q("2"),
        refType: "order",
        refId: h.ref("p").refId,
      });
      const movements = await h.tx.stockMovement.findMany({ where: { variantId: p.id } });
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({
        kind: "commit",
        deltaPhysical: 0n,
        deltaCommitted: q("2"),
        physicalAfter: q("5"),
        committedAfter: q("2"),
        refType: "order",
        refId: h.ref("p").refId,
      });
      // a doua confirmare nu mai face nimic
      expect((await h.service.confirmReservation(h.ref("p")))[0]?.outcome).toBe(
        "already_committed",
      );
      expect(await h.tx.stockMovement.count({ where: { variantId: p.id } })).toBe(1);
      await h.consistent(p.id);
    });
  });

  it("rezervare expirată (eliberată de job), stocul încă liber → plata târzie reia cantitatea și o angajează", async () => {
    await withStock(async (h) => {
      const p = await h.product("2");
      await h.service.reserve(h.ref("t"), [h.line(p.id, "1")], minutes(T0, 5));
      h.setClock(minutes(T0, 10));
      await h.service.expireDue({ variantIds: [p.id] });
      expect((await h.item(p.id)).reserved).toBe(0n);
      expect((await h.service.confirmReservation(h.ref("t")))[0]?.outcome).toBe("committed");
      expect(await h.item(p.id)).toMatchObject({ committed: q("1"), reserved: 0n });
      // webhook repetat după reluare: tot o singură angajare
      expect((await h.service.confirmReservation(h.ref("t")))[0]?.outcome).toBe(
        "already_committed",
      );
      expect(await h.tx.stockCommitment.count({ where: { variantId: p.id } })).toBe(1);
      await h.consistent(p.id);
    });
  });

  it("rezervare expirată și stocul luat între timp → STOCK_RESERVATION_LOST, nimic modificat", async () => {
    await withStock(async (h) => {
      const p = await h.product("1");
      const a = await h.product("5");
      await h.service.reserve(h.ref("t"), [h.line(p.id, "1"), h.line(a.id, "2")], minutes(T0, 5));
      h.setClock(minutes(T0, 10));
      await h.service.expireDue({ variantIds: [p.id, a.id] });
      await h.service.reserve(h.ref("alt"), [h.line(p.id, "1")], minutes(T0, 25));
      const error = await failure(() => h.service.confirmReservation(h.ref("t")));
      expect(error?.code).toBe("STOCK_RESERVATION_LOST");
      // fără angajare parțială nici pe linia care avea stoc
      expect((await h.item(a.id)).committed).toBe(0n);
      expect((await h.item(p.id)).committed).toBe(0n);
      expect(await h.tx.stockCommitment.count({ where: { variantId: { in: [p.id, a.id] } } })).toBe(
        0,
      );
    });
  });

  it("nicio rezervare pentru comandă (doar linii negestionate): confirmare goală, fără eroare", async () => {
    await withStock(async (h) => {
      expect(await h.service.confirmReservation(h.ref("nimic"))).toEqual([]);
    });
  });

  it("un coș cu 2 linii se confirmă împreună", async () => {
    await withStock(async (h) => {
      const a = await h.product("5");
      const b = await h.product("5", { step: "0,3" });
      await h.service.reserve(
        h.ref("c"),
        [h.line(a.id, "1"), h.line(b.id, "0,6")],
        minutes(T0, 15),
      );
      const outcomes = await h.service.confirmReservation(h.ref("c"));
      expect(outcomes.map((o) => o.outcome).sort()).toEqual(["committed", "committed"]);
      expect(formatQuantity((await h.item(b.id)).committed as Quantity)).toBe("0,6");
      await h.consistent(a.id);
      await h.consistent(b.id);
    });
  });
});

describe("angajare directă (ramburs)", () => {
  it("scade imediat, idempotent; stoc insuficient refuză fără urme", async () => {
    await withStock(async (h) => {
      const p = await h.product("2");
      expect((await h.service.commitDirect(h.ref("r"), [h.line(p.id, "2")]))[0]?.outcome).toBe(
        "committed",
      );
      expect((await h.service.commitDirect(h.ref("r"), [h.line(p.id, "2")]))[0]?.outcome).toBe(
        "already_committed",
      );
      expect(await h.item(p.id)).toMatchObject({ committed: q("2"), reserved: 0n });
      const error = await failure(() => h.service.commitDirect(h.ref("alta"), [h.line(p.id, "1")]));
      expect(error?.code).toBe("STOCK_INSUFFICIENT");
      expect(await h.tx.stockCommitment.count({ where: { variantId: p.id } })).toBe(1);
      expect(await h.tx.stockMovement.count({ where: { variantId: p.id, kind: "commit" } })).toBe(
        1,
      );
      await h.consistent(p.id);
    });
  });

  it("clasificarea e aceeași ca la rezervare (digital/negestionat nu se angajează)", async () => {
    await withStock(async (h) => {
      const digital = await h.product("0", { type: "digital" });
      const unmanaged = await h.product(null, { manageStock: false });
      const outcomes = await h.service.commitDirect(h.ref("m"), [
        h.line(digital.id, "1"),
        h.line(unmanaged.id, "1"),
      ]);
      expect(outcomes.map((o) => o.outcome)).toEqual(["skipped_digital", "skipped_unmanaged"]);
    });
  });
});

describe("eliberarea angajării (comandă anulată înainte de oglindire)", () => {
  it("o angajare deschisă se eliberează o dată, cu mișcarea «release»; apoi comanda nu se mai poate angaja", async () => {
    await withStock(async (h) => {
      const p = await h.product("5");
      await h.service.commitDirect(h.ref("an"), [h.line(p.id, "2")]);
      expect(await h.service.releaseCommitment(h.ref("an"))).toEqual({
        released: 1,
        alreadyMirrored: 0,
      });
      expect(await h.service.releaseCommitment(h.ref("an"))).toEqual({
        released: 0,
        alreadyMirrored: 0,
      });
      expect((await h.item(p.id)).committed).toBe(0n);
      const move = await h.tx.stockMovement.findFirstOrThrow({
        where: { variantId: p.id, kind: "release" },
      });
      expect(move).toMatchObject({ deltaCommitted: -q("2"), committedAfter: 0n });
      const again = await failure(() => h.service.commitDirect(h.ref("an"), [h.line(p.id, "2")]));
      expect(again?.code).toBe("STOCK_COMMITMENT_RELEASED");
      expect((await h.item(p.id)).committed).toBe(0n);
      await h.consistent(p.id);
    });
  });

  it("o angajare deja oglindită nu se mai atinge (stocul revine prin stornoul din SmartBill)", async () => {
    await withStock(async (h) => {
      const p = await h.product("5");
      await h.service.commitDirect(h.ref("o"), [h.line(p.id, "1")]);
      await h.service.markInvoiced(h.ref("o"), minutes(T0, -120));
      const snapshot = await h.tx.stockSnapshot.create({
        data: { warehouseId: h.ctx.warehouseId, takenAt: minutes(T0, 60), source: "import" },
      });
      await h.service.applySnapshot({
        variantId: p.id,
        snapshotId: snapshot.id,
        quantity: q("4"),
        takenAt: minutes(T0, 60),
        safetyWindowMinutes: 30,
      });
      expect(await h.service.releaseCommitment(h.ref("o"))).toEqual({
        released: 0,
        alreadyMirrored: 1,
      });
      expect(await h.item(p.id)).toMatchObject({ physical: q("4"), committed: 0n });
    });
  });
});

describe("oglindire: poza SmartBill aplicată (cronologia din plan)", () => {
  async function photo(h: Harness, takenAt: Date) {
    const row = await h.tx.stockSnapshot.create({
      data: { warehouseId: h.ctx.warehouseId, takenAt, source: "import" },
    });
    return row.id;
  }

  it("09:00 poză 5 · 10:00 comandă · 10:01 factură · 12:00 poză 3 → comanda e oglindită: disponibil 3, nu 2", async () => {
    await withStock(async (h) => {
      const p = await h.product("5");
      const day = (hhmm: string) => new Date(`2026-10-21T${hhmm}:00Z`);
      h.setClock(day("10:00"));
      await h.service.commitDirect(h.ref("o1"), [h.line(p.id, "1")]);
      await h.service.markInvoiced(h.ref("o1"), day("10:01"));
      // vânzarea din magazin de la 11:00 (deja în SmartBill) se scrie ca ajustare cu ora efectivă 11:00
      await h.tx.stockMovement.create({
        data: {
          variantId: p.id,
          warehouseId: h.ctx.warehouseId,
          kind: "adjustment",
          reason: "sale_in_store",
          note: "vânzare în magazin",
          deltaPhysical: parseSignedDelta("-1"),
          physicalAfter: q("4"),
          committedAfter: q("1"),
          effectiveAt: day("11:00"),
        },
      });
      h.setClock(day("12:00"));
      const result = await h.service.applySnapshot({
        variantId: p.id,
        snapshotId: await photo(h, day("12:00")),
        quantity: q("3"),
        takenAt: day("12:00"),
        safetyWindowMinutes: 30,
      });
      expect(result).toMatchObject({ applied: true, mirroredIds: expect.any(Array) });
      expect((result as { mirroredIds: string[] }).mirroredIds).toHaveLength(1);
      const row = await h.item(p.id);
      expect(row).toMatchObject({ physical: q("3"), committed: 0n });
      const item = await h.tx.inventoryItem.findFirstOrThrow({ where: { variantId: p.id } });
      expect(item.physicalAsOf?.toISOString()).toBe(day("12:00").toISOString());
      expect(
        (await h.tx.stockCommitment.findFirstOrThrow({ where: { variantId: p.id } })).status,
      ).toBe("mirrored");
      // mișcările: poza (5 → 3) și oglindirea (angajat −1)
      const kinds = (
        await h.tx.stockMovement.findMany({
          where: { variantId: p.id },
          orderBy: { createdAt: "asc" },
        })
      ).map((m) => m.kind);
      expect(kinds).toEqual(expect.arrayContaining(["commit", "adjustment", "snapshot", "mirror"]));
      const snapshotMove = await h.tx.stockMovement.findFirstOrThrow({
        where: { variantId: p.id, kind: "snapshot" },
      });
      expect(snapshotMove).toMatchObject({ deltaPhysical: -q("2"), physicalAfter: q("3") });
      const mirrorMove = await h.tx.stockMovement.findFirstOrThrow({
        where: { variantId: p.id, kind: "mirror" },
      });
      expect(mirrorMove).toMatchObject({
        deltaCommitted: -q("1"),
        committedAfter: 0n,
        refId: h.ref("o1").refId,
      });
      await h.consistent(p.id);
    });
  });

  it("poza de la 10:20 cu factura de la 10:01 (în fereastră): comanda rămâne angajată → disponibil 3, nu 4", async () => {
    await withStock(async (h) => {
      const p = await h.product("5");
      const day = (hhmm: string) => new Date(`2026-10-21T${hhmm}:00Z`);
      await h.service.commitDirect(h.ref("o1"), [h.line(p.id, "1")]);
      await h.service.markInvoiced(h.ref("o1"), day("10:01"));
      await h.service.applySnapshot({
        variantId: p.id,
        snapshotId: await photo(h, day("10:20")),
        quantity: q("4"),
        takenAt: day("10:20"),
        safetyWindowMinutes: 30,
      });
      expect(await h.item(p.id)).toMatchObject({ physical: q("4"), committed: q("1") });
      await h.consistent(p.id);
    });
  });

  it("ajustarea cu ora efectivă DUPĂ poză rămâne aplicată; cele dinainte sau de la ora pozei dispar", async () => {
    await withStock(async (h) => {
      const p = await h.product("10");
      const day = (hhmm: string) => new Date(`2026-10-21T${hhmm}:00Z`);
      const adjust = (effectiveAt: Date, delta: string, after: string) =>
        h.tx.stockMovement.create({
          data: {
            variantId: p.id,
            warehouseId: h.ctx.warehouseId,
            kind: "adjustment",
            reason: "other",
            note: "test",
            deltaPhysical: parseSignedDelta(delta),
            physicalAfter: q(after),
            committedAfter: 0n,
            effectiveAt,
          },
        });
      await adjust(day("11:00"), "-1", "9");
      await adjust(day("12:00"), "-2", "7");
      await adjust(day("13:00"), "-3", "4");
      await h.service.applySnapshot({
        variantId: p.id,
        snapshotId: await photo(h, day("12:00")),
        quantity: q("10"),
        takenAt: day("12:00"),
        safetyWindowMinutes: 30,
      });
      expect((await h.item(p.id)).physical).toBe(q("7")); // 10 − 3 (doar cea de la 13:00)
    });
  });

  it("poză mai veche sau identică cu ultima aplicată: ignorată, nimic modificat (import repetat)", async () => {
    await withStock(async (h) => {
      const p = await h.product("5");
      const day = (hhmm: string) => new Date(`2026-10-21T${hhmm}:00Z`);
      const apply = async (hhmm: string, quantity: string) =>
        h.service.applySnapshot({
          variantId: p.id,
          snapshotId: await photo(h, day(hhmm)),
          quantity: q(quantity),
          takenAt: day(hhmm),
          safetyWindowMinutes: 30,
        });
      expect(await apply("12:00", "3")).toMatchObject({ applied: true });
      expect(await apply("12:00", "9")).toEqual({ applied: false, reason: "not_newer" });
      expect(await apply("11:00", "9")).toEqual({ applied: false, reason: "not_newer" });
      expect((await h.item(p.id)).physical).toBe(q("3"));
      expect(await apply("12:30", "2")).toMatchObject({ applied: true });
      expect((await h.item(p.id)).physical).toBe(q("2"));
    });
  });

  it("variantă fără rând de stoc: poza îl creează; ajustări care duc sub zero lasă 0, cu semnal", async () => {
    await withStock(async (h) => {
      const p = await h.product(null);
      const day = (hhmm: string) => new Date(`2026-10-21T${hhmm}:00Z`);
      expect(await h.tx.inventoryItem.count({ where: { variantId: p.id } })).toBe(0);
      const result = await h.service.applySnapshot({
        variantId: p.id,
        snapshotId: await photo(h, day("12:00")),
        quantity: q("8,5"),
        takenAt: day("12:00"),
        safetyWindowMinutes: 30,
      });
      expect(result).toMatchObject({ applied: true, physicalClamped: false });
      expect(formatQuantity((await h.item(p.id)).physical as Quantity)).toBe("8,5");
      // ajustare după poză mai mare decât stocul: la poza următoare fizicul rămâne 0
      await h.tx.stockMovement.create({
        data: {
          variantId: p.id,
          warehouseId: h.ctx.warehouseId,
          kind: "adjustment",
          reason: "lost_stolen",
          note: "test",
          deltaPhysical: parseSignedDelta("-20"),
          physicalAfter: 0n,
          committedAfter: 0n,
          effectiveAt: day("13:00"),
        },
      });
      const clamped = await h.service.applySnapshot({
        variantId: p.id,
        snapshotId: await photo(h, day("12:30")),
        quantity: q("8,5"),
        takenAt: day("12:30"),
        safetyWindowMinutes: 30,
      });
      expect(clamped).toMatchObject({ applied: true, physicalClamped: true });
      expect((await h.item(p.id)).physical).toBe(0n);
    });
  });
});

describe("consistența contoarelor", () => {
  it("contoarele coincid cu rândurile care le justifică; o corupere se vede", async () => {
    await withStock(async (h) => {
      const p = await h.product("10");
      await h.service.reserve(h.ref("r"), [h.line(p.id, "2")], minutes(T0, 15));
      await h.service.commitDirect(h.ref("c"), [h.line(p.id, "3")]);
      const ok = await h.service.checkConsistency(p.id);
      expect(ok).toMatchObject({
        ok: true,
        reserved: q("2"),
        reservedFromRows: q("2"),
        committed: q("3"),
        committedFromRows: q("3"),
      });
      await h.tx.inventoryItem.updateMany({
        where: { variantId: p.id },
        data: { reserved: q("5") },
      });
      const bad = await h.service.checkConsistency(p.id);
      expect(bad).toMatchObject({ ok: false, reserved: q("5"), reservedFromRows: q("2") });
    });
  });

  it("variantă fără rând de stoc: consistentă, cu zero peste tot", async () => {
    await withStock(async (h) => {
      const p = await h.product(null);
      expect(await h.service.checkConsistency(p.id)).toMatchObject({
        ok: true,
        reserved: 0n,
        committed: 0n,
      });
      expect(await h.service.readInventory(p.id)).toBeNull();
    });
  });
});
