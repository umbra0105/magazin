import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { NOW, codeOf, harness, q, type Harness } from "../test-utils/checkout-fixtures";
import { buildAccountExport } from "./account-export";
import { accountDeleteBlockers, anonymizeAccount, anonymizedEmail } from "./account-delete";
import { getAccountOrder, listAccountOrders } from "./account-orders";
import { AddressBook } from "./address-book";
import type { AccountUser } from "./order-ownership";
import { getProfile, setMarketingConsent, updateProfile } from "./profile";
import { addToWishlist, listWishlist, removeFromWishlist } from "./wishlist";
import { initiateReturn } from "../returns/return-customer";

/**
 * Faza 14, contul clientului pe Postgres real (tranzacție anulată): fiecare serviciu primește clientul autentificat, iar clientul A
 * nu poate citi sau schimba nimic al clientului B; exportul GDPR nu conține câmpuri interne; ștergerea anonimizează contul și lasă
 * comenzile neschimbate. Ceasul e injectat.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
const SECRET_NOTE = "NOTA-INTERNA-SECRETA";
const SECRET_SUPPLIER = "FURNIZOR-SECRET";

async function client(h: Harness, email: string, verified = true): Promise<AccountUser> {
  const user = await h.tx.user.create({
    data: { id: `u_${randomUUID().slice(0, 8)}`, name: "Client", email, emailVerified: verified },
  });
  return { id: user.id, email: user.email, emailVerified: user.emailVerified };
}

/** O comandă de oaspete a emailului dat, cu note interne, marcaj «La furnizor» și o notă de comandă (toate trebuie să rămână ascunse). */
async function guestOrder(h: Harness, email: string, opts: { delivered?: boolean } = {}) {
  const product = await h.product();
  const owner = await h.fill([{ variantId: product.variantId, quantity: q("2") }]);
  const { orderId } = await h.checkout.place(
    owner,
    await h.input(owner, { contact: { email, phone: "0722123456" } }),
  );
  await h.tx.order.update({
    where: { id: orderId },
    data: {
      adminNote: SECRET_NOTE,
      supplierMarkedAt: NOW,
      supplierMarkedBy: "admin@test.ro",
      supplierName: SECRET_SUPPLIER,
      supplierNote: SECRET_SUPPLIER,
    },
  });
  await h.tx.orderEvent.create({
    data: { orderId, type: "order.note", message: SECRET_NOTE, actorLabel: "admin@test.ro" },
  });
  await h.tx.orderEvent.create({
    data: {
      orderId,
      type: "order.shipped",
      message: `Expediată de admin@test.ro (${SECRET_NOTE})`,
      actorLabel: "admin@test.ro",
      data: { awb: "AWB123", carrier: "Curier" },
    },
  });
  if (opts.delivered) {
    await h.tx.orderEvent.create({
      data: {
        orderId,
        type: "order.delivered",
        message: "Livrată",
        createdAt: new Date(NOW.getTime() - DAY),
      },
    });
  }
  return { orderId, variantId: product.variantId };
}

describe("izolarea între clienți (IDOR)", () => {
  it("clientul A nu vede comenzile clientului B nici în listă, nici în detaliu", async () => {
    await harness(async (h) => {
      const a = await client(h, "a@exemplu.ro");
      const b = await client(h, "b@exemplu.ro");
      const orderB = await guestOrder(h, "b@exemplu.ro");
      const orderA = await guestOrder(h, "a@exemplu.ro");
      const listA = await listAccountOrders(h.tx, a, 1, 10);
      expect(listA.orders.map((o) => o.id)).toEqual([orderA.orderId]);
      expect(await codeOf(getAccountOrder(h.tx, a, orderB.orderId, NOW))).toBe(
        "ACCOUNT_ORDER_NOT_FOUND",
      );
      expect((await getAccountOrder(h.tx, b, orderB.orderId, NOW)).id).toBe(orderB.orderId);
    });
  });

  it("emailul necerificat nu primește comenzile de oaspete", async () => {
    await harness(async (h) => {
      const unverified = await client(h, "nou@exemplu.ro", false);
      await guestOrder(h, "nou@exemplu.ro");
      expect((await listAccountOrders(h.tx, unverified, 1, 10)).total).toBe(0);
      const verified = { ...unverified, emailVerified: true };
      expect((await listAccountOrders(h.tx, verified, 1, 10)).total).toBe(1);
    });
  });

  it("comparația emailului e normalizată (litere mari, spații)", async () => {
    await harness(async (h) => {
      const a = await client(h, "Client.Mare@Exemplu.RO");
      await guestOrder(h, "client.mare@exemplu.ro");
      expect((await listAccountOrders(h.tx, a, 1, 10)).total).toBe(1);
    });
  });

  it("agenda de adrese: clientul A nu poate citi, modifica sau șterge adresa clientului B", async () => {
    await harness(async (h) => {
      const a = await client(h, "a@exemplu.ro");
      const b = await client(h, "b@exemplu.ro");
      const book = new AddressBook({
        db: h.tx,
        cui: { lookup: async () => ({ status: "unavailable", reason: "network" }) as never },
        today: () => "2030-06-15",
      });
      const input = {
        fullName: "Ion Popescu",
        phone: "0722123456",
        countyCode: h.geo.countyCode,
        localityCode: h.geo.localityCode,
        street: "Str. Exemplu 1",
        postalCode: "123456",
      };
      const mine = await book.create(b.id, input);
      expect(await codeOf(book.get(a.id, mine.id))).toBe("ACCOUNT_ADDRESS_NOT_FOUND");
      expect(await codeOf(book.update(a.id, mine.id, { ...input, street: "Str. Furată 9" }))).toBe(
        "ACCOUNT_ADDRESS_NOT_FOUND",
      );
      expect(await codeOf(book.remove(a.id, mine.id))).toBe("ACCOUNT_ADDRESS_NOT_FOUND");
      expect(await codeOf(book.setDefault(a.id, mine.id, "shipping"))).toBe(
        "ACCOUNT_ADDRESS_NOT_FOUND",
      );
      expect((await book.get(b.id, mine.id)).street).toBe("Str. Exemplu 1");
      // codul județului din agendă e cel din lista de județe (JUD), ca formularul de editare să-l poată alege
      expect((await book.get(b.id, mine.id)).countyCode).toBe(h.geo.countyCode);
      expect(await book.list(a.id)).toEqual([]);
    });
  });

  it("wishlist: operațiile lucrează doar pe rândurile clientului", async () => {
    await harness(async (h) => {
      const a = await client(h, "a@exemplu.ro");
      const b = await client(h, "b@exemplu.ro");
      const product = await h.product();
      await addToWishlist(h.tx, b.id, product.variantId);
      await removeFromWishlist(h.tx, a.id, product.variantId);
      expect(await listWishlist(h.tx, b.id)).toHaveLength(1);
      expect(await listWishlist(h.tx, a.id)).toHaveLength(0);
    });
  });

  it("clientul A nu poate cere retur pe comanda lui B", async () => {
    await harness(async (h) => {
      const a = await client(h, "a@exemplu.ro");
      await client(h, "b@exemplu.ro");
      const orderB = await guestOrder(h, "b@exemplu.ro", { delivered: true });
      const lineId = (await h.tx.orderLine.findFirstOrThrow({ where: { orderId: orderB.orderId } }))
        .id;
      const code = await codeOf(
        initiateReturn(
          h.tx,
          a,
          {
            orderId: orderB.orderId,
            clientKey: randomUUID(),
            items: [{ orderLineId: lineId, quantity: "1", reasonCode: "changed_mind" }],
          },
          NOW,
        ),
      );
      expect(code).toBe("RETURN_NOT_FOUND");
    });
  });
});

describe("ce vede clientul în detaliul comenzii", () => {
  it("cronologia e construită doar din evenimente de pe lista albă; notele interne și furnizorul nu apar niciodată", async () => {
    await harness(async (h) => {
      const a = await client(h, "a@exemplu.ro");
      const o = await guestOrder(h, "a@exemplu.ro");
      const detail = await getAccountOrder(h.tx, a, o.orderId, NOW);
      const text = JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      expect(text).not.toContain(SECRET_NOTE);
      expect(text).not.toContain(SECRET_SUPPLIER);
      expect(text).not.toContain("admin@test.ro");
      expect(text).not.toMatch(/adminNote|supplier|costPrice|ipAddress/);
      const types = detail.timeline.map((t) => t.type);
      expect(types).toContain("order.shipped");
      expect(types).not.toContain("order.note");
      const shipped = detail.timeline.find((t) => t.type === "order.shipped");
      expect(shipped).toMatchObject({ awb: "AWB123", carrier: "Curier" });
    });
  });

  it("facturile: doar cele emise, ale comenzii proprii", async () => {
    await harness(async (h) => {
      const a = await client(h, "a@exemplu.ro");
      const o = await guestOrder(h, "a@exemplu.ro");
      await h.tx.invoice.create({
        data: {
          orderId: o.orderId,
          kind: "invoice",
          docKey: "invoice",
          totalMinor: 100,
          taxMinor: 17,
          status: "queued",
        },
      });
      const detail = await getAccountOrder(h.tx, a, o.orderId, NOW);
      expect(detail.invoices).toEqual([]);
    });
  });
});

describe("exportul GDPR", () => {
  it("conține datele clientului și NU câmpuri interne sau ale altor clienți", async () => {
    await harness(async (h) => {
      const a = await client(h, "a@exemplu.ro");
      await client(h, "b@exemplu.ro");
      await guestOrder(h, "a@exemplu.ro");
      await guestOrder(h, "b@exemplu.ro");
      const dump = await buildAccountExport(h.tx, a, NOW);
      const text = JSON.stringify(dump);
      expect(text).toContain("a@exemplu.ro");
      expect(text).not.toContain("b@exemplu.ro");
      expect(text).not.toContain(SECRET_NOTE);
      expect(text).not.toContain(SECRET_SUPPLIER);
      expect(text).not.toContain("admin@test.ro");
      expect(text).not.toMatch(
        /costPrice|adminNote|supplier|rawPayload|ipAddress|userAgent|productSnapshot/,
      );
      expect((dump["orders"] as unknown[]).length).toBe(1);
      expect(dump["version"]).toBe(1);
    });
  });
});

describe("profil și preferințe", () => {
  it("«oferte și noutăți» e oprit implicit; decizia salvează momentul și textul exact", async () => {
    await harness(async (h) => {
      const a = await client(h, "a@exemplu.ro");
      expect((await getProfile(h.tx, a.id)).marketingOptIn).toBe(false);
      await setMarketingConsent(h.tx, a.id, true, NOW);
      const row = await h.tx.customerPreference.findUniqueOrThrow({ where: { userId: a.id } });
      expect(row.marketingOptIn).toBe(true);
      expect(row.marketingDecisionAt?.getTime()).toBe(NOW.getTime());
      expect(row.marketingDecisionText).toContain("oferte și noutăți");
      await setMarketingConsent(h.tx, a.id, false, new Date(NOW.getTime() + 1000));
      expect((await getProfile(h.tx, a.id)).marketingOptIn).toBe(false);
    });
  });

  it("numele și telefonul se salvează; telefonul se normalizează la +40; unul invalid e refuzat", async () => {
    await harness(async (h) => {
      const a = await client(h, "a@exemplu.ro");
      await updateProfile(h.tx, a.id, { name: "Ion Popescu", phone: "0722 123 456" });
      const profile = await getProfile(h.tx, a.id);
      expect(profile).toMatchObject({ name: "Ion Popescu", phone: "+40722123456" });
      expect(await codeOf(updateProfile(h.tx, a.id, { name: "Ion", phone: "123" }))).toBe(
        "VALIDATION_ERROR",
      );
    });
  });
});

describe("ștergerea contului = anonimizare", () => {
  it("refuzată cu o comandă nefinalizată; reușită după ce comanda e finalizată; comenzile rămân neschimbate", async () => {
    await harness(async (h) => {
      const a = await client(h, "a@exemplu.ro");
      const o = await guestOrder(h, "a@exemplu.ro");
      const before = await h.tx.order.findUniqueOrThrow({
        where: { id: o.orderId },
        include: { lines: true, addresses: true },
      });
      expect((await accountDeleteBlockers(h.tx, a)).unfinishedOrders).toBe(1);
      expect(await codeOf(anonymizeAccount(h.tx, a, NOW))).toBe("ACCOUNT_DELETE_BLOCKED");
      await h.tx.order.update({ where: { id: o.orderId }, data: { status: "completed" } });
      await h.tx.customerPreference.create({ data: { userId: a.id, phone: "+40722123456" } });
      await h.tx.session.create({
        data: {
          id: randomUUID(),
          token: randomUUID(),
          userId: a.id,
          expiresAt: new Date(NOW.getTime() + DAY),
        },
      });
      await anonymizeAccount(h.tx, a, NOW);
      const user = await h.tx.user.findUniqueOrThrow({ where: { id: a.id } });
      expect(user.email).toBe(anonymizedEmail(a.id));
      expect(user.name).not.toContain("Client");
      expect(user.anonymizedAt?.getTime()).toBe(NOW.getTime());
      expect(user.emailVerified).toBe(false);
      expect(await h.tx.session.count({ where: { userId: a.id } })).toBe(0);
      expect(await h.tx.account.count({ where: { userId: a.id } })).toBe(0);
      expect(await h.tx.customerPreference.count({ where: { userId: a.id } })).toBe(0);
      // comanda, liniile și adresele ei rămân EXACT cum erau
      const after = await h.tx.order.findUniqueOrThrow({
        where: { id: o.orderId },
        include: { lines: true, addresses: true },
      });
      expect({ ...after, status: "x", updatedAt: null }).toEqual({
        ...before,
        status: "x",
        updatedAt: null,
      });
      // contul anonimizat nu mai vede nicio comandă, nici cu emailul vechi
      expect((await listAccountOrders(h.tx, { ...a, anonymizedAt: NOW }, 1, 10)).total).toBe(0);
    });
  });

  it("refuzată cu un retur deschis", async () => {
    await harness(async (h) => {
      const a = await client(h, "a@exemplu.ro");
      const o = await guestOrder(h, "a@exemplu.ro", { delivered: true });
      await h.tx.order.update({ where: { id: o.orderId }, data: { status: "completed" } });
      const lineId = (await h.tx.orderLine.findFirstOrThrow({ where: { orderId: o.orderId } })).id;
      await initiateReturn(
        h.tx,
        a,
        {
          orderId: o.orderId,
          clientKey: randomUUID(),
          items: [{ orderLineId: lineId, quantity: "1", reasonCode: "changed_mind" }],
        },
        NOW,
      );
      expect((await accountDeleteBlockers(h.tx, a)).openReturns).toBe(1);
      expect(await codeOf(anonymizeAccount(h.tx, a, NOW))).toBe("ACCOUNT_DELETE_BLOCKED");
    });
  });

  it("un cont cu rol în administrare nu se șterge din cont", async () => {
    await harness(async (h) => {
      const a = await client(h, "staff@exemplu.ro");
      const role = await h.tx.role.findFirstOrThrow();
      await h.tx.userRole.create({ data: { userId: a.id, roleId: role.id } });
      expect(await codeOf(anonymizeAccount(h.tx, a, NOW))).toBe("ACCOUNT_DELETE_BLOCKED");
    });
  });

  it("apelată de două ori, a doua nu face nimic", async () => {
    await harness(async (h) => {
      const a = await client(h, "a@exemplu.ro");
      await anonymizeAccount(h.tx, a, NOW);
      await anonymizeAccount(h.tx, a, new Date(NOW.getTime() + 5000));
      const user = await h.tx.user.findUniqueOrThrow({ where: { id: a.id } });
      expect(user.anonymizedAt?.getTime()).toBe(NOW.getTime());
    });
  });
});
