import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { harness, q } from "../test-utils/checkout-fixtures";
import { getOrderSummary, normalizeTrackingKey, trackOrder } from "./order-read";

const db = getDb();
afterAll(() => db.$disconnect());

describe("urmărirea comenzii (număr + email)", () => {
  it("găsește comanda cu perechea corectă, fără să țină cont de litere mari și spații", async () => {
    await harness(async (h) => {
      const product = await h.product({ price: 19_900 });
      const owner = await h.fill([{ variantId: product.variantId, quantity: q("2") }]);
      const placed = await h.checkout.place(owner, await h.input(owner));
      const exact = await trackOrder(h.tx, { number: placed.number, email: "client@exemplu.ro" });
      expect(exact?.number).toBe(placed.number);
      const sloppy = await trackOrder(h.tx, {
        number: ` ${placed.number.toLowerCase()} `,
        email: "  CLIENT@Exemplu.RO ",
      });
      expect(sloppy?.number).toBe(placed.number);
    });
  });

  it("perechea greșită (număr sau email) dă același răspuns: null", async () => {
    await harness(async (h) => {
      const product = await h.product();
      const owner = await h.fill([{ variantId: product.variantId }]);
      const placed = await h.checkout.place(owner, await h.input(owner));
      const wrongEmail = await trackOrder(h.tx, {
        number: placed.number,
        email: "altcineva@exemplu.ro",
      });
      const wrongNumber = await trackOrder(h.tx, {
        number: "NU-EXISTA",
        email: "client@exemplu.ro",
      });
      const bothWrong = await trackOrder(h.tx, {
        number: "NU-EXISTA",
        email: "altcineva@exemplu.ro",
      });
      expect([wrongEmail, wrongNumber, bothWrong]).toEqual([null, null, null]);
      expect(await trackOrder(h.tx, { number: "", email: "client@exemplu.ro" })).toBeNull();
      expect(await trackOrder(h.tx, { number: placed.number, email: " " })).toBeNull();
    });
  });

  it("rezumatul NU conține strada, telefonul, emailul, CUI-ul sau date de achiziție", async () => {
    await harness(async (h) => {
      const product = await h.product({ price: 19_900 });
      const owner = await h.fill([{ variantId: product.variantId }]);
      const placed = await h.checkout.place(
        owner,
        await h.input(owner, { company: { name: "Firma SRL", vatId: "14399840" } }),
      );
      const summary = await getOrderSummary(h.tx, placed.orderId);
      const json = JSON.stringify(summary);
      expect(json).not.toContain("Str. Exemplu");
      expect(json).not.toContain("0722");
      expect(json).not.toContain("client@exemplu.ro");
      expect(json).not.toContain("14399840");
      expect(json).not.toMatch(/cost/i);
      expect(summary?.destination).toEqual({ countyName: "Test", localityName: "Sat Test" });
      expect(summary?.totals.totalMinor).toBeGreaterThan(0);
    });
  });

  it("termenul cel mai lung dintre liniile «La comandă» apare în rezumat", async () => {
    await harness(async (h) => {
      const special = await h.product({
        manageStock: false,
        stockStatus: "onbackorder",
        variants: [{ physical: null }],
      });
      const owner = await h.fill([{ variantId: special.variantId }]);
      const placed = await h.checkout.place(
        owner,
        await h.input(owner, { paymentMethod: "bank_transfer" }),
      );
      const summary = await getOrderSummary(h.tx, placed.orderId);
      expect(summary?.longestLeadTimeDays).not.toBeNull();
      expect(summary?.reservationExpiresAt).not.toBeNull();
    });
  });
});

describe("normalizeTrackingKey", () => {
  it("numărul: fără spații, majuscule; emailul: litere mici, fără spații la capete", () => {
    expect(normalizeTrackingKey(" web- 0001 ", " A@B.Ro ")).toEqual({
      number: "WEB-0001",
      email: "a@b.ro",
    });
  });
});
