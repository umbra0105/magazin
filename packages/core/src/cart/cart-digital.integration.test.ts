import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { codeOf, harness, q } from "../test-utils/checkout-fixtures";

/**
 * Faza 14c, decizia 1: maxim o bucată pe linie digitală, pe server (CartService) și pe Postgres real. Un coș existent cu
 * cantitate peste 1 nu se modifică în tăcere: linia primește problema «digital_quantity» și coșul cere o decizie.
 */
const db = getDb();
afterAll(() => db.$disconnect());

describe("coș: maxim o bucată pe linie digitală", () => {
  it("adăugarea cu cantitatea minimă pune o bucată; a doua adăugare a aceluiași produs e refuzată", async () => {
    await harness(async (h) => {
      const d = await h.product({ type: "digital", manageStock: false, price: 30_000 });
      const owner = await h.fill([{ variantId: d.variantId }]);
      const view = await h.cart.view(owner);
      expect(view.lines).toHaveLength(1);
      expect(view.lines[0]?.quantityTicks).toBe("10000");
      expect(view.lines[0]?.isDigital).toBe(true);
      expect(view.canCheckout).toBe(true);

      expect(await codeOf(h.cart.add(owner, { variantId: d.variantId, quantity: q("1") }))).toBe(
        "CART_DIGITAL_SINGLE",
      );
      // nimic nu s-a schimbat
      expect((await h.cart.view(owner)).lines[0]?.quantityTicks).toBe("10000");
    });
  });

  it("adăugarea directă a 2 bucăți digitale e refuzată", async () => {
    await harness(async (h) => {
      const d = await h.product({ type: "digital", manageStock: false });
      const owner = { kind: "guest", token: null } as const;
      expect(await codeOf(h.cart.add(owner, { variantId: d.variantId, quantity: q("2") }))).toBe(
        "CART_DIGITAL_SINGLE",
      );
    });
  });

  it("modificarea cantității unei linii digitale la 2 e refuzată", async () => {
    await harness(async (h) => {
      const d = await h.product({ type: "digital", manageStock: false });
      const owner = await h.fill([{ variantId: d.variantId }]);
      expect(
        await codeOf(h.cart.setQuantity(owner, { variantId: d.variantId, quantity: q("2") })),
      ).toBe("CART_DIGITAL_SINGLE");
    });
  });

  it("un produs fizic își păstrează cantitatea (3 bucăți) chiar alături de unul digital", async () => {
    await harness(async (h) => {
      const physical = await h.product({ price: 5_000 });
      const d = await h.product({ type: "digital", manageStock: false, price: 30_000 });
      const owner = await h.fill([
        { variantId: physical.variantId, quantity: q("3") },
        { variantId: d.variantId },
      ]);
      const view = await h.cart.view(owner);
      expect(view.canCheckout).toBe(true);
      expect(view.lines.map((line) => [line.isDigital, line.quantityTicks])).toEqual([
        [false, "30000"],
        [true, "10000"],
      ]);
      expect(view.totals.totalMinor).toBe(3 * 5_000 + 30_000);
    });
  });

  it("un coș existent cu 2 bucăți digitale nu se schimbă în tăcere: linia cere o decizie, totalul rămâne cel al regulilor de preț", async () => {
    await harness(async (h) => {
      const d = await h.product({ type: "digital", manageStock: false, price: 30_000 });
      const owner = await h.fill([{ variantId: d.variantId }]);
      // coș vechi, de dinainte de regulă: cantitatea 2 scrisă direct în bază
      await h.tx.cartItem.updateMany({
        where: { variantId: d.variantId },
        data: { quantity: q("2") },
      });
      const view = await h.cart.view(owner);
      const line = view.lines[0];
      expect(line?.quantityTicks).toBe("20000");
      expect(line?.issues).toEqual([{ type: "digital_quantity" }]);
      expect(line?.included).toBe(true);
      expect(line?.pricing?.totalMinor).toBe(60_000);
      expect(view.totals.totalMinor).toBe(60_000);
      expect(view.canCheckout).toBe(false);

      // clientul decide: coboară la 1 și coșul e din nou gata
      await h.cart.setQuantity(owner, { variantId: d.variantId, quantity: q("1") });
      const fixed = await h.cart.view(owner);
      expect(fixed.canCheckout).toBe(true);
      expect(fixed.totals.totalMinor).toBe(30_000);
    });
  });
});
