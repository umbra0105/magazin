import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { NOW, codeOf, harness, orderOf, q, type Harness } from "../test-utils/checkout-fixtures";
import { cardHarness, placeCardOrder } from "../test-utils/payment-fixtures";
import { cancelOrder } from "./order-actions";
import { correctOrderAddress, correctOrderContact } from "./order-edit";
import { addOrderNote, listOrderNotes } from "./order-notes";
import { markBankTransferPaid } from "./order-payments-admin";

/**
 * Note interne, corectarea contactului și a adresei, «marchează plătit» pentru transfer (Faza 11), pe Postgres real. Banii și
 * adresele sunt păzite și în bază (trigger): corectarea nu atinge zona de livrare, firma sau CUI-ul.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const WHO = { actorLabel: "operator@exemplu.ro", now: NOW };

async function placed(h: Harness, paymentMethod?: string) {
  const product = await h.product({ physical: "100" });
  const owner = await h.fill([{ variantId: product.variantId, quantity: q("1") }]);
  return h.checkout.place(owner, await h.input(owner, paymentMethod ? { paymentMethod } : {}));
}

describe("note interne", () => {
  it("se adaugă cu autor și moment; evenimentul spune doar că s-a adăugat o notă, nu și textul", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      const { id } = await addOrderNote(h.tx, orderId, {
        body: "  Clientul vrea livrare dimineața, tel 0722 111 222  ",
        authorLabel: "operator@exemplu.ro",
      });
      const notes = await listOrderNotes(h.tx, orderId);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        id,
        authorLabel: "operator@exemplu.ro",
        body: "Clientul vrea livrare dimineața, tel 0722 111 222",
      });
      const event = (await orderOf(h.tx, orderId)).events.find((e) => e.type === "note.added");
      expect(event).toMatchObject({ actorLabel: "operator@exemplu.ro", data: { noteId: id } });
      expect(JSON.stringify(event)).not.toContain("0722");
      expect(JSON.stringify(event)).not.toContain("dimineața");
    });
  });

  it("nota goală sau prea lungă se refuză; limita exactă trece; ordinea e cea mai nouă întâi", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      for (const body of ["", "   ", "x".repeat(2001)]) {
        expect(await codeOf(addOrderNote(h.tx, orderId, { body, authorLabel: "a@b.ro" }))).toBe(
          "ORDER_NOTE_INVALID",
        );
      }
      await addOrderNote(h.tx, orderId, { body: "x".repeat(2000), authorLabel: "a@b.ro" });
      await addOrderNote(h.tx, orderId, { body: "a doua", authorLabel: "a@b.ro" });
      const notes = await listOrderNotes(h.tx, orderId);
      expect(notes).toHaveLength(2);
      expect(notes[0]?.body).toBe("a doua");
      expect(
        await codeOf(addOrderNote(h.tx, "nu-exista", { body: "x", authorLabel: "a@b.ro" })),
      ).toBe("ORDER_NOT_FOUND");
    });
  });
});

describe("corectarea contactului", () => {
  it("email și telefon se normalizează; evenimentul spune CE câmpuri s-au schimbat, fără valori", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      const result = await correctOrderContact(h.tx, orderId, {
        email: "  Nou.Client@Exemplu.RO ",
        phone: "0733 444 555",
        actorLabel: "operator@exemplu.ro",
      });
      expect(result.changed.sort()).toEqual(["email", "phone"]);
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ email: "nou.client@exemplu.ro", phone: "+40733444555" });
      const event = order.events.find((e) => e.type === "order.contact_corrected");
      expect(event?.data).toEqual({ fields: ["email", "phone"] });
      expect(JSON.stringify(event?.data)).not.toContain("exemplu.ro");
    });
  });

  it("aceleași valori: nu se schimbă nimic și nu se scrie eveniment; valorile invalide se refuză", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      const order = await orderOf(h.tx, orderId);
      expect(
        await correctOrderContact(h.tx, orderId, {
          email: order.email,
          phone: order.phone,
          actorLabel: "o@e.ro",
        }),
      ).toEqual({ changed: [] });
      expect(
        await h.tx.orderEvent.count({ where: { orderId, type: "order.contact_corrected" } }),
      ).toBe(0);
      for (const bad of [
        { email: "nu-e-email", phone: "0722111222" },
        { email: "ok@exemplu.ro", phone: "123" },
      ]) {
        expect(
          await codeOf(correctOrderContact(h.tx, orderId, { ...bad, actorLabel: "o@e.ro" })),
        ).toBe("ORDER_EDIT_INVALID");
      }
    });
  });

  it("o comandă anulată nu se mai editează", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      await cancelOrder(h.tx, orderId, { ...WHO, reason: "Motiv bun" });
      expect(
        await codeOf(
          correctOrderContact(h.tx, orderId, {
            email: "alt@exemplu.ro",
            phone: "0722111222",
            actorLabel: "o@e.ro",
          }),
        ),
      ).toBe("ORDER_EDIT_INVALID");
    });
  });
});

describe("corectarea adresei: doar greșelile de tastare, zona nu se atinge", () => {
  const FIX = {
    fullName: "Ion Popescu-Vasile",
    phone: "0722123456",
    street: "Str. Corectă 12, bl. 3",
    postalCode: "510009",
  };

  it("nume, telefon, stradă și cod poștal se corectează; județul, localitatea și țara rămân", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      const before = (await orderOf(h.tx, orderId)).addresses.find((a) => a.kind === "shipping");
      const result = await correctOrderAddress(
        h.tx,
        orderId,
        "shipping",
        FIX,
        "operator@exemplu.ro",
      );
      expect(result.changed).toEqual(expect.arrayContaining(["street", "postalCode"]));
      const after = (await orderOf(h.tx, orderId)).addresses.find((a) => a.kind === "shipping");
      expect(after).toMatchObject({
        fullName: "Ion Popescu-Vasile",
        phone: "+40722123456",
        street: "Str. Corectă 12, bl. 3",
        postalCode: "510009",
        countySirutaCode: before?.countySirutaCode,
        localitySirutaCode: before?.localitySirutaCode,
        countyName: before?.countyName,
        localityName: before?.localityName,
        country: before?.country,
      });
      const event = (await orderOf(h.tx, orderId)).events.find(
        (e) => e.type === "order.address_corrected",
      );
      expect(event?.actorLabel).toBe("operator@exemplu.ro");
      expect(JSON.stringify(event?.data)).not.toContain("Corectă");
    });
  });

  it("DB-ul păzește ce nu se corectează: zona, tipul, țara, firma și CUI-ul nu se pot schimba nici cu SQL direct", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      const address = (await orderOf(h.tx, orderId)).addresses.find((a) => a.kind === "shipping");
      const attempt = async (set: string) => {
        await h.tx.$executeRawUnsafe(`SAVEPOINT a`);
        try {
          await h.tx.$executeRawUnsafe(`UPDATE address SET ${set} WHERE id = '${address?.id}'`);
          return "trecut";
        } catch {
          return "respins";
        } finally {
          await h.tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT a`);
        }
      };
      for (const set of [
        `"localityName" = 'Altă localitate'`,
        `"countyName" = 'Alt județ'`,
        `"localitySirutaCode" = ${address?.localitySirutaCode ?? 0} + 1`,
        `"country" = 'DE'`,
        `kind = 'billing'`,
        `company = 'Firma SRL'`,
        `"vatId" = 'RO1234567'`,
        `"vatIdVerification" = 'verified'`,
        `"tradeRegisterNo" = 'J1/1/2000'`,
        `"createdAt" = now()`,
      ]) {
        expect(await attempt(set), set).toBe("respins");
      }
      for (const set of [
        `"fullName" = 'Nume Nou'`,
        `phone = '+40700000000'`,
        `street = 'Strada Nouă'`,
        `"postalCode" = '123456'`,
      ]) {
        expect(await attempt(set), set).toBe("trecut");
      }
    });
  });

  it("date invalide se refuză (cod poștal, telefon, stradă scurtă); nicio schimbare nu scrie evenimentul", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h);
      for (const bad of [
        { ...FIX, postalCode: "123" },
        { ...FIX, phone: "abc" },
        { ...FIX, street: "ab" },
        { ...FIX, fullName: "x" },
      ]) {
        expect(await codeOf(correctOrderAddress(h.tx, orderId, "shipping", bad, "o@e.ro"))).toBe(
          "ORDER_EDIT_INVALID",
        );
      }
      expect(
        await h.tx.orderEvent.count({ where: { orderId, type: "order.address_corrected" } }),
      ).toBe(0);
    });
  });
});

describe("«marchează plătit» pentru transfer bancar", () => {
  const paid = (h: Harness, orderId: string, over: Record<string, unknown> = {}) =>
    markBankTransferPaid(h.tx, orderId, {
      amountMinor: 0,
      reference: "OP 1234 / Popescu",
      actorLabel: "contabil@exemplu.ro",
      now: NOW,
      ...over,
    });

  it("suma exactă: comanda devine confirmată și plătită, stocul se angajează, emailul «plată primită» e în coadă, referința e păstrată", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h, "bank_transfer");
      const total = (await orderOf(h.tx, orderId)).totalMinor;
      const result = await paid(h, orderId, { amountMinor: total });
      expect(result).toEqual({ alreadyPaid: false, differenceMinor: 0 });
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
      expect(order.payments[0]).toMatchObject({
        status: "paid",
        capturedAmountMinor: total,
        attentionReason: null,
      });
      expect(order.stockCommitments).toHaveLength(1);
      expect(order.events.map((e) => e.type)).toEqual(
        expect.arrayContaining(["payment.confirmed", "payment.transfer_recorded"]),
      );
      expect(order.events.find((e) => e.type === "payment.transfer_recorded")?.data).toEqual({
        reference: "OP 1234 / Popescu",
        receivedMinor: total,
        differenceMinor: 0,
      });
      expect(
        await h.tx.emailDispatch.count({ where: { orderId, template: "order.payment_received" } }),
      ).toBe(1);
    });
  });

  it("suma diferită fără decizie explicită: refuzată, nimic nu se modifică (nici mai mică, nici mai mare cu 1 ban)", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h, "bank_transfer");
      const total = (await orderOf(h.tx, orderId)).totalMinor;
      for (const amountMinor of [total - 1, total + 1]) {
        const error = await paid(h, orderId, { amountMinor }).catch((e: unknown) => e);
        expect((error as { code?: string }).code).toBe("ORDER_PAYMENT_AMOUNT_MISMATCH");
        expect((error as { details?: Record<string, number> }).details).toMatchObject({
          expectedMinor: total,
          receivedMinor: amountMinor,
        });
      }
      const order = await orderOf(h.tx, orderId);
      expect(order).toMatchObject({ status: "pending", paymentStatus: "pending" });
      expect(order.stockCommitments).toHaveLength(0);
    });
  });

  it("cu decizie explicită: se confirmă cu suma primită, iar diferența intră în «necesită atenție» (nu se pierde)", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h, "bank_transfer");
      const total = (await orderOf(h.tx, orderId)).totalMinor;
      const result = await paid(h, orderId, { amountMinor: total + 500, acceptDifference: true });
      expect(result).toEqual({ alreadyPaid: false, differenceMinor: 500 });
      const order = await orderOf(h.tx, orderId);
      expect(order.payments[0]).toMatchObject({
        status: "paid",
        capturedAmountMinor: total + 500,
        attentionReason: "amount_mismatch",
        attentionResolvedAt: null,
      });
      expect(order.events.find((e) => e.type === "payment.transfer_recorded")?.data).toMatchObject({
        differenceMinor: 500,
      });
    });
  });

  it("idempotent: a doua confirmare nu schimbă nimic, nu scrie alt eveniment și nu trimite alt email", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h, "bank_transfer");
      const total = (await orderOf(h.tx, orderId)).totalMinor;
      await paid(h, orderId, { amountMinor: total });
      const events = await h.tx.orderEvent.count({ where: { orderId } });
      expect(await paid(h, orderId, { amountMinor: total })).toEqual({
        alreadyPaid: true,
        differenceMinor: 0,
      });
      // chiar și o sumă diferită, după plată, nu face nimic
      expect(await paid(h, orderId, { amountMinor: total + 7 })).toEqual({
        alreadyPaid: true,
        differenceMinor: 0,
      });
      expect(await h.tx.orderEvent.count({ where: { orderId } })).toBe(events);
      expect(
        await h.tx.emailDispatch.count({ where: { orderId, template: "order.payment_received" } }),
      ).toBe(1);
    });
  });

  it("referința și suma sunt obligatorii; comenzile cu alte metode, anulate sau inexistente se refuză", async () => {
    await harness(async (h) => {
      const { orderId } = await placed(h, "bank_transfer");
      const total = (await orderOf(h.tx, orderId)).totalMinor;
      for (const reference of ["", "  ", "ab", "x".repeat(101)]) {
        expect(await codeOf(paid(h, orderId, { amountMinor: total, reference }))).toBe(
          "ORDER_PAYMENT_REFERENCE_INVALID",
        );
      }
      for (const amountMinor of [0, -5, 1.5]) {
        expect(await codeOf(paid(h, orderId, { amountMinor }))).toBe(
          "ORDER_PAYMENT_AMOUNT_INVALID",
        );
      }
      expect(await codeOf(paid(h, "nu-exista", { amountMinor: total }))).toBe("ORDER_NOT_FOUND");
      const cod = await placed(h);
      expect(await codeOf(paid(h, cod.orderId, { amountMinor: 100 }))).toBe(
        "ORDER_PAYMENT_NOT_PENDING",
      );
      await cancelOrder(h.tx, orderId, { ...WHO, reason: "Motiv bun" });
      expect(await codeOf(paid(h, orderId, { amountMinor: total }))).toBe(
        "ORDER_PAYMENT_NOT_PENDING",
      );
    });
    await cardHarness(async (h) => {
      const card = await placeCardOrder(h);
      expect(await codeOf(paid(h, card.orderId, { amountMinor: card.amountMinor }))).toBe(
        "ORDER_PAYMENT_NOT_PENDING",
      );
    });
  });
});
