import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { transitionOrder } from "./order-service";
import { NOW, codeOf, harness, orderOf, q, type Harness } from "../test-utils/checkout-fixtures";
import { clearSupplierMark, markAtSupplier } from "./order-supplier";

/**
 * Marcajul «La furnizor» (Faza 11, decizia 2026-11-19): NU e stare nouă și NU atinge stocul, banii sau statusurile. Marcare,
 * actualizare și scoaterea marcajului scriu `OrderEvent`; operațiile sunt idempotente; doar pe comenzi active.
 */
const db = getDb();
afterAll(() => db.$disconnect());

async function codOrder(h: Harness) {
  const product = await h.product({ physical: "100" });
  const owner = await h.fill([{ variantId: product.variantId, quantity: q("1") }]);
  const placed = await h.checkout.place(owner, await h.input(owner));
  return { ...placed, variantId: product.variantId };
}

const WHO = { actorLabel: "operator@exemplu.ro", now: NOW };

describe("marcajul «La furnizor»", () => {
  it("marchează cu furnizor și notă, scrie OrderEvent și nu schimbă statusurile, stocul sau banii", async () => {
    await harness(async (h) => {
      const { orderId, variantId } = await codOrder(h);
      const before = await orderOf(h.tx, orderId);
      const stockBefore = await h.tx.inventoryItem.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId: h.ctx.warehouseId } },
      });

      const result = await markAtSupplier(h.tx, orderId, {
        ...WHO,
        supplierName: "  Furnizor Test SRL ",
        note: "Termen 5 zile",
      });
      expect(result).toEqual({ changed: true });

      const after = await orderOf(h.tx, orderId);
      expect(after).toMatchObject({
        supplierMarkedAt: NOW,
        supplierMarkedBy: "operator@exemplu.ro",
        supplierName: "Furnizor Test SRL",
        supplierNote: "Termen 5 zile",
      });
      for (const field of [
        "status",
        "paymentStatus",
        "fulfillmentStatus",
        "totalMinor",
        "subtotalMinor",
        "taxMinor",
      ] as const) {
        expect(after[field], field).toEqual(before[field]);
      }
      const stockAfter = await h.tx.inventoryItem.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId: h.ctx.warehouseId } },
      });
      expect(stockAfter).toEqual(stockBefore);
      const event = after.events.at(-1);
      expect(event).toMatchObject({
        type: "order.supplier_marked",
        actorLabel: "operator@exemplu.ro",
      });
    });
  });

  it("e idempotentă: aceleași date a doua oară nu scriu alt eveniment; date diferite actualizează", async () => {
    await harness(async (h) => {
      const { orderId } = await codOrder(h);
      await markAtSupplier(h.tx, orderId, { ...WHO, supplierName: "F1", note: null });
      const again = await markAtSupplier(h.tx, orderId, { ...WHO, supplierName: "F1", note: null });
      expect(again).toEqual({ changed: false });
      expect(
        await h.tx.orderEvent.count({ where: { orderId, type: "order.supplier_marked" } }),
      ).toBe(1);

      const updated = await markAtSupplier(h.tx, orderId, {
        ...WHO,
        supplierName: "F2",
        note: "x",
      });
      expect(updated).toEqual({ changed: true });
      const row = await orderOf(h.tx, orderId);
      expect(row).toMatchObject({ supplierName: "F2", supplierNote: "x" });
      expect(
        await h.tx.orderEvent.count({ where: { orderId, type: "order.supplier_updated" } }),
      ).toBe(1);
    });
  });

  it("furnizorul și nota sunt opționale (marcaj simplu), dar nu pot fi șiruri goale sau prea lungi", async () => {
    await harness(async (h) => {
      const { orderId } = await codOrder(h);
      await markAtSupplier(h.tx, orderId, { ...WHO, supplierName: null, note: null });
      expect(await orderOf(h.tx, orderId)).toMatchObject({
        supplierName: null,
        supplierNote: null,
      });
      // un șir cu doar spații se normalizează la «fără furnizor», nu la șir gol
      await markAtSupplier(h.tx, orderId, { ...WHO, supplierName: "   ", note: "  " });
      expect(await orderOf(h.tx, orderId)).toMatchObject({
        supplierName: null,
        supplierNote: null,
      });
      expect(
        await codeOf(
          markAtSupplier(h.tx, orderId, { ...WHO, supplierName: "x".repeat(201), note: null }),
        ),
      ).toBe("ORDER_SUPPLIER_MARK_INVALID");
      expect(
        await codeOf(
          markAtSupplier(h.tx, orderId, { ...WHO, supplierName: null, note: "x".repeat(1001) }),
        ),
      ).toBe("ORDER_SUPPLIER_MARK_INVALID");
      // limitele exacte trec
      await markAtSupplier(h.tx, orderId, {
        ...WHO,
        supplierName: "x".repeat(200),
        note: "y".repeat(1000),
      });
    });
  });

  it("scoate marcajul: câmpurile revin la nul, evenimentul se scrie o singură dată, a doua scoatere nu face nimic", async () => {
    await harness(async (h) => {
      const { orderId } = await codOrder(h);
      expect(await clearSupplierMark(h.tx, orderId, WHO)).toEqual({ changed: false });
      await markAtSupplier(h.tx, orderId, { ...WHO, supplierName: "F1", note: "n" });
      expect(await clearSupplierMark(h.tx, orderId, WHO)).toEqual({ changed: true });
      expect(await orderOf(h.tx, orderId)).toMatchObject({
        supplierMarkedAt: null,
        supplierMarkedBy: null,
        supplierName: null,
        supplierNote: null,
      });
      expect(await clearSupplierMark(h.tx, orderId, WHO)).toEqual({ changed: false });
      expect(
        await h.tx.orderEvent.count({ where: { orderId, type: "order.supplier_unmarked" } }),
      ).toBe(1);
    });
  });

  it("refuză comanda inexistentă și comenzile anulate sau încheiate; scoaterea marcajului rămâne permisă", async () => {
    await harness(async (h) => {
      expect(
        await codeOf(markAtSupplier(h.tx, "nu-exista", { ...WHO, supplierName: null, note: null })),
      ).toBe("ORDER_NOT_FOUND");
      const { orderId } = await codOrder(h);
      await markAtSupplier(h.tx, orderId, { ...WHO, supplierName: "F", note: null });
      await transitionOrder(
        h.tx,
        orderId,
        { status: "cancelled", paymentStatus: "cancelled", fulfillmentStatus: "cancelled" },
        { type: "order.cancelled", message: "test" },
        NOW,
      );
      expect(
        await codeOf(markAtSupplier(h.tx, orderId, { ...WHO, supplierName: "G", note: null })),
      ).toBe("ORDER_SUPPLIER_MARK_INVALID");
      // marcajul rămas pe o comandă anulată se poate scoate
      expect(await clearSupplierMark(h.tx, orderId, WHO)).toEqual({ changed: true });
    });
  });
});

describe("CHECK-ul de pe comandă (marcajul)", () => {
  it("«una setată, una nulă» NU trece: doar momentul sau doar autorul, ori furnizor fără marcaj", async () => {
    await harness(async (h) => {
      const { orderId } = await codOrder(h);
      const attempt = async (data: string) => {
        await h.tx.$executeRawUnsafe(`SAVEPOINT chk`);
        try {
          await h.tx.$executeRawUnsafe(`UPDATE customer_order SET ${data} WHERE id = '${orderId}'`);
          return "trecut";
        } catch {
          return "respins";
        } finally {
          await h.tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT chk`);
        }
      };
      expect(await attempt(`"supplierMarkedAt" = now()`)).toBe("respins");
      expect(await attempt(`"supplierMarkedBy" = 'x'`)).toBe("respins");
      expect(await attempt(`"supplierName" = 'F'`)).toBe("respins");
      expect(await attempt(`"supplierNote" = 'n'`)).toBe("respins");
      expect(await attempt(`"supplierMarkedAt" = now(), "supplierMarkedBy" = 'x'`)).toBe("trecut");
      expect(
        await attempt(`"supplierMarkedAt" = now(), "supplierMarkedBy" = 'x', "supplierName" = ''`),
      ).toBe("respins");
      expect(
        await attempt(
          `"supplierMarkedAt" = now(), "supplierMarkedBy" = 'x', "supplierNote" = repeat('a', 1001)`,
        ),
      ).toBe("respins");
    });
  });
});
