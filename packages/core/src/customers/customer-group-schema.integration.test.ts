import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";

/**
 * Faza 15, schema grupurilor de clienți. Fiecare constrângere are un test care o încalcă, iar CHECK-urile compuse au și cazul
 * «una setată, una nulă» (un CHECK cu rezultat NULL TRECE). Testele nu presupun date de seed: își creează singure grupul, clientul
 * și comanda, într-o tranzacție anulată (grupul de sistem se creează aici, nu se presupune din seed).
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

const group = (data: Record<string, unknown> = {}) => ({
  data: { name: `Grup ${uid()}`, slug: `g-${uid()}`, ...data } as never,
});

async function makeGroup(tx: TestTx, data: Record<string, unknown> = {}) {
  return tx.customerGroup.create(group(data));
}

async function makeUser(tx: TestTx, customerGroupId: string | null = null) {
  return tx.user.create({
    data: {
      id: `u_${uid()}`,
      name: "Client",
      email: `c-${uid()}@exemplu.test`,
      emailVerified: true,
      customerGroupId,
    },
  });
}

async function makeOrder(tx: TestTx, extra: Record<string, unknown> = {}) {
  const channel = await tx.salesChannel.create({ data: { code: `t_${uid()}`, name: "Canal" } });
  return tx.order.create({
    data: {
      number: `T-${uid()}`,
      channelId: channel.id,
      email: `c-${uid()}@exemplu.test`,
      phone: "0722000000",
      subtotalMinor: 10_000,
      shippingMinor: 0,
      taxMinor: 1_735,
      totalMinor: 10_000,
      taxRateBps: 2100,
      shippingMethodCode: "courier",
      shippingSnapshot: {},
      paymentMethod: "cod",
      termsAcceptedAt: new Date(),
      termsConsentText: "Sunt de acord",
      termsConsentVersion: "t",
      idempotencyKey: randomUUID(),
      ...extra,
    } as never,
  });
}

describe("CustomerGroup: valorile implicite", () => {
  it("un grup fără alte câmpuri e «none», fără procente, acumulează puncte, activ, nu e de sistem", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const row = await makeGroup(tx);
      expect(row).toMatchObject({
        pricingType: "none",
        discountBps: null,
        markupBps: null,
        stacksWithSalePrice: false,
        earnsLoyaltyPoints: true,
        isSystem: false,
        isActive: true,
        tone: "neutral",
      });
    });
  });

  it("slug-ul e unic", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const slug = `g-${uid()}`;
      await makeGroup(tx, { slug });
      await expect(makeGroup(tx, { slug })).rejects.toThrow();
    });
  });
});

describe("CustomerGroup: tipul și procentele (CHECK compus cu IS NULL / IS NOT NULL)", () => {
  it("combinațiile valide trec", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await makeGroup(tx, { pricingType: "none" });
      await makeGroup(tx, { pricingType: "discount", discountBps: 500 });
      await makeGroup(tx, { pricingType: "discount", discountBps: 0 });
      await makeGroup(tx, { pricingType: "discount", discountBps: 10_000 });
      await makeGroup(tx, { pricingType: "cost_plus", markupBps: 1200 });
      await makeGroup(tx, { pricingType: "cost_plus", markupBps: 0 });
      await makeGroup(tx, { pricingType: "discount", discountBps: 500, stacksWithSalePrice: true });
    });
  });

  it.each([
    ["tip necunoscut", { pricingType: "special" }],
    ["tip gol", { pricingType: "" }],
    ["«none» cu reducere", { pricingType: "none", discountBps: 500 }],
    ["«none» cu adaos", { pricingType: "none", markupBps: 1200 }],
    ["«discount» fără procent (una setată, una nulă)", { pricingType: "discount" }],
    ["«discount» cu adaos în loc de reducere", { pricingType: "discount", markupBps: 500 }],
    [
      "«discount» cu ambele procente",
      { pricingType: "discount", discountBps: 500, markupBps: 1200 },
    ],
    ["«discount» peste 100%", { pricingType: "discount", discountBps: 10_001 }],
    ["«discount» negativ", { pricingType: "discount", discountBps: -1 }],
    ["«cost_plus» fără adaos (una setată, una nulă)", { pricingType: "cost_plus" }],
    ["«cost_plus» cu reducere în loc de adaos", { pricingType: "cost_plus", discountBps: 500 }],
    [
      "«cost_plus» cu ambele procente",
      { pricingType: "cost_plus", markupBps: 1200, discountBps: 500 },
    ],
    ["«cost_plus» cu adaos negativ", { pricingType: "cost_plus", markupBps: -1 }],
    ["«cost_plus» cu adaos peste plafon", { pricingType: "cost_plus", markupBps: 1_000_001 }],
  ])("%s e refuzat", async (_label, data) => {
    await inRolledBackTransaction(db, async (tx) => {
      await expect(makeGroup(tx, data)).rejects.toThrow();
    });
  });

  it.each([
    ["«none»", { pricingType: "none" }],
    ["«cost_plus»", { pricingType: "cost_plus", markupBps: 1200 }],
  ])("cumularea cu promoția (stacksWithSalePrice) nu se poate la %s", async (_label, data) => {
    await inRolledBackTransaction(db, async (tx) => {
      await expect(makeGroup(tx, { ...data, stacksWithSalePrice: true })).rejects.toThrow();
    });
  });

  it("tonul badge-ului: doar cheile cunoscute", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      for (const tone of ["neutral", "info", "success", "warning", "danger", "accent"]) {
        await makeGroup(tx, { tone });
      }
    });
    await inRolledBackTransaction(db, async (tx) => {
      await expect(makeGroup(tx, { tone: "#ff0000" })).rejects.toThrow();
    });
  });

  it("modificarea unui grup valid într-o combinație invalidă e refuzată", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const row = await makeGroup(tx, { pricingType: "discount", discountBps: 500 });
      await expect(
        tx.customerGroup.update({ where: { id: row.id }, data: { discountBps: null } }),
      ).rejects.toThrow();
    });
  });
});

describe("«Client standard»: grupul de sistem", () => {
  const system = { slug: "client-standard", name: "Client standard", isSystem: true };

  it("se creează ca «none»; poate exista cel mult unul", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      // nu presupun seed: dacă baza are deja grupul de sistem, numărul se compară înainte/după
      const before = await tx.customerGroup.count({ where: { isSystem: true } });
      if (before === 0) {
        await makeGroup(tx, system);
        await expect(makeGroup(tx, { isSystem: true })).rejects.toThrow();
      } else {
        await expect(makeGroup(tx, { isSystem: true })).rejects.toThrow();
      }
    });
  });

  it("un grup de sistem nu poate fi «discount» sau «cost_plus»", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await expect(
        makeGroup(tx, { isSystem: true, pricingType: "discount", discountBps: 500 }),
      ).rejects.toThrow();
    });
  });

  it("nu se șterge", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const row =
        (await tx.customerGroup.findFirst({ where: { isSystem: true } })) ??
        (await makeGroup(tx, system));
      await expect(tx.customerGroup.delete({ where: { id: row.id } })).rejects.toThrow();
    });
  });

  it("nu devine ne-de-sistem și nu-și schimbă tipul", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const row =
        (await tx.customerGroup.findFirst({ where: { isSystem: true } })) ??
        (await makeGroup(tx, system));
      await expect(
        tx.customerGroup.update({ where: { id: row.id }, data: { isSystem: false } }),
      ).rejects.toThrow();
    });
    await inRolledBackTransaction(db, async (tx) => {
      const row =
        (await tx.customerGroup.findFirst({ where: { isSystem: true } })) ??
        (await makeGroup(tx, system));
      await expect(
        tx.customerGroup.update({
          where: { id: row.id },
          data: { pricingType: "discount", discountBps: 500 },
        }),
      ).rejects.toThrow();
    });
  });

  it("un grup obișnuit nu poate deveni de sistem", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const row = await makeGroup(tx);
      await expect(
        tx.customerGroup.update({ where: { id: row.id }, data: { isSystem: true } }),
      ).rejects.toThrow();
    });
  });

  it("numele se poate redenumi și grupul se poate dezactiva doar pe grupurile obișnuite", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const row = await makeGroup(tx, { name: "Vechi" });
      const updated = await tx.customerGroup.update({
        where: { id: row.id },
        data: { name: "Nou", isActive: false },
      });
      expect(updated).toMatchObject({ name: "Nou", isActive: false });
    });
  });
});

describe("clientul și grupul lui", () => {
  it("clientul fără grup rămâne valid (grup nul = «Client standard»)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const user = await makeUser(tx);
      expect(user.customerGroupId).toBeNull();
    });
  });

  it("grupul clientului trebuie să existe", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await expect(makeUser(tx, "nu-exista")).rejects.toThrow();
    });
  });

  it("un grup cu clienți nu se șterge (RESTRICT), unul gol da", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const used = await makeGroup(tx);
      await makeUser(tx, used.id);
      await expect(tx.customerGroup.delete({ where: { id: used.id } })).rejects.toThrow();
    });
    await inRolledBackTransaction(db, async (tx) => {
      const empty = await makeGroup(tx);
      await tx.customerGroup.delete({ where: { id: empty.id } });
      expect(await tx.customerGroup.findUnique({ where: { id: empty.id } })).toBeNull();
    });
  });
});

describe("snapshot-ul grupului pe comandă", () => {
  it("comanda fără grup (implicit) e valabilă: «none», fără procente, avantaj 0", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const order = await makeOrder(tx);
      expect(order).toMatchObject({
        groupPricingType: "none",
        customerGroupId: null,
        groupDiscountBps: null,
        groupMarkupBps: null,
        groupAdvantageMinor: 0,
      });
    });
  });

  it("snapshot valid pentru «discount» și «cost_plus»", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const fidel = await makeGroup(tx, { pricingType: "discount", discountBps: 500 });
      const partner = await makeGroup(tx, { pricingType: "cost_plus", markupBps: 1200 });
      await makeOrder(tx, {
        groupPricingType: "discount",
        customerGroupId: fidel.id,
        groupDiscountBps: 500,
        groupAdvantageMinor: 995,
      });
      await makeOrder(tx, {
        groupPricingType: "cost_plus",
        customerGroupId: partner.id,
        groupMarkupBps: 1200,
        groupAdvantageMinor: 2100,
      });
    });
  });

  it("grupul de pe comandă trebuie să existe", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await expect(makeOrder(tx, { customerGroupId: "nu-exista" })).rejects.toThrow();
    });
  });

  it("un grup folosit de o comandă nu se șterge", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const row = await makeGroup(tx, { pricingType: "discount", discountBps: 500 });
      await makeOrder(tx, {
        groupPricingType: "discount",
        customerGroupId: row.id,
        groupDiscountBps: 500,
      });
      await expect(tx.customerGroup.delete({ where: { id: row.id } })).rejects.toThrow();
    });
  });

  it.each([
    ["tip necunoscut", { groupPricingType: "special" }],
    ["«none» cu procent de reducere", { groupPricingType: "none", groupDiscountBps: 500 }],
    ["«none» cu adaos", { groupPricingType: "none", groupMarkupBps: 1200 }],
    ["«none» cu avantaj peste 0", { groupPricingType: "none", groupAdvantageMinor: 100 }],
    ["avantaj negativ", { groupPricingType: "none", groupAdvantageMinor: -1 }],
  ])("%s e refuzat", async (_label, data) => {
    await inRolledBackTransaction(db, async (tx) => {
      await expect(makeOrder(tx, data)).rejects.toThrow();
    });
  });

  it.each([
    ["«discount» fără procent (una setată, una nulă)", { groupPricingType: "discount" }],
    [
      "«discount» cu adaos în loc de reducere",
      { groupPricingType: "discount", groupMarkupBps: 500 },
    ],
    ["«cost_plus» fără adaos (una setată, una nulă)", { groupPricingType: "cost_plus" }],
    [
      "«cost_plus» cu reducere în loc de adaos",
      { groupPricingType: "cost_plus", groupDiscountBps: 500 },
    ],
    [
      "«discount» fără grup (id nul)",
      { groupPricingType: "discount", groupDiscountBps: 500, customerGroupId: null },
    ],
  ])("%s e refuzat", async (_label, data) => {
    await inRolledBackTransaction(db, async (tx) => {
      await expect(makeOrder(tx, data)).rejects.toThrow();
    });
  });
});
