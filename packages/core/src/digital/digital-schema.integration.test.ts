import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";

/**
 * Faza 14b, schema produselor digitale. Fiecare constrângere are un test care o încalcă, iar CHECK-urile compuse au și cazul «una
 * setată, una nulă» (un CHECK cu rezultat NULL TRECE). Testele nu presupun date de seed: își creează singure produsul, clientul,
 * comanda și linia, într-o tranzacție anulată.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

interface Fixture {
  userId: string;
  productId: string;
  orderId: string;
  lineId: string;
}

async function fixture(tx: TestTx): Promise<Fixture> {
  const user = await tx.user.create({
    data: {
      id: `u_${uid()}`,
      name: "Client",
      email: `c-${uid()}@exemplu.test`,
      emailVerified: true,
    },
  });
  const product = await tx.product.create({
    data: { slug: `dig-${uid()}`, title: "Curs digital", type: "digital" },
  });
  await tx.digitalProduct.create({ data: { productId: product.id } });
  const channel = await tx.salesChannel.create({ data: { code: `t_${uid()}`, name: "Canal" } });
  const order = await tx.order.create({
    data: {
      number: `T-${uid()}`,
      channelId: channel.id,
      email: user.email,
      phone: "0722000000",
      subtotalMinor: 10_000,
      shippingMinor: 0,
      taxMinor: 1_735,
      totalMinor: 10_000,
      taxRateBps: 2100,
      shippingMethodCode: "digital",
      shippingSnapshot: { kind: "digital" },
      paymentMethod: "cod",
      termsAcceptedAt: new Date(),
      termsConsentText: "Sunt de acord",
      termsConsentVersion: "t",
      idempotencyKey: randomUUID(),
    },
  });
  const line = await tx.orderLine.create({
    data: {
      orderId: order.id,
      sku: `S-${uid()}`,
      title: "Curs digital",
      quantity: 10_000n,
      unitSymbol: "buc",
      unitDecimals: 0,
      unitPriceMinor: 10_000,
      lineTotalMinor: 10_000,
      netMinor: 8_265,
      taxMinor: 1_735,
      taxRateBps: 2100,
      stockState: "in_stock",
      shippingClass: "standard",
      productSnapshot: {},
      isDigital: true,
    },
  });
  return { userId: user.id, productId: product.id, orderId: order.id, lineId: line.id };
}

async function entitlement(tx: TestTx, f: Fixture, extra: Record<string, unknown> = {}) {
  return tx.digitalEntitlement.create({
    data: {
      orderId: f.orderId,
      orderLineId: f.lineId,
      customerId: f.userId,
      productId: f.productId,
      accessToken: `${randomUUID()}${randomUUID()}`.replaceAll("-", ""),
      grantReason: "payment",
      ...extra,
    },
  });
}

const asset = (productId: string, data: Record<string, unknown>) => ({
  data: { productId, title: "Modul 1", ...data } as never,
});

describe("bifa legală pe comandă: toate trei sau niciuna", () => {
  it("niciuna: trece (comandă fără linii digitale)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      const order = await tx.order.findUniqueOrThrow({ where: { id: f.orderId } });
      expect(order.digitalConsentAt).toBeNull();
    });
  });

  it("toate trei setate: trece", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await tx.order.update({
        where: { id: f.orderId },
        data: {
          digitalConsentAt: new Date(),
          digitalConsentText: "Solicit livrarea imediată",
          digitalConsentVersion: "provizoriu-1",
        },
      });
    });
  });

  it.each([
    ["doar momentul", { digitalConsentAt: new Date() }],
    ["doar textul", { digitalConsentText: "Solicit livrarea imediată" }],
    ["doar versiunea", { digitalConsentVersion: "provizoriu-1" }],
    [
      "momentul și textul, fără versiune",
      { digitalConsentAt: new Date(), digitalConsentText: "Solicit livrarea imediată" },
    ],
    [
      "momentul și versiunea, fără text",
      { digitalConsentAt: new Date(), digitalConsentVersion: "provizoriu-1" },
    ],
    [
      "textul și versiunea, fără moment",
      { digitalConsentText: "Solicit livrarea imediată", digitalConsentVersion: "provizoriu-1" },
    ],
  ])("una sau două setate (%s) e refuzată", async (_label, data) => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(tx.order.update({ where: { id: f.orderId }, data })).rejects.toThrow();
    });
  });

  it("textul sau versiunea goale (doar spații) sunt refuzate", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(
        tx.order.update({
          where: { id: f.orderId },
          data: {
            digitalConsentAt: new Date(),
            digitalConsentText: "   ",
            digitalConsentVersion: "v",
          },
        }),
      ).rejects.toThrow();
    });
  });
});

describe("DigitalProduct", () => {
  it("valorile implicite: download, pe viață, cu cont, fără limită", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      const row = await tx.digitalProduct.findUniqueOrThrow({ where: { productId: f.productId } });
      expect(row).toMatchObject({
        deliveryType: "download",
        accessType: "lifetime",
        accessDays: null,
        maxDownloads: null,
        requiresLogin: true,
      });
    });
  });

  it("tip de livrare necunoscut e refuzat", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(
        tx.digitalProduct.update({
          where: { productId: f.productId },
          data: { deliveryType: "torrent" },
        }),
      ).rejects.toThrow();
    });
  });

  it("acces pe viață cu zile setate e refuzat (una setată, una nulă)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(
        tx.digitalProduct.update({
          where: { productId: f.productId },
          data: { accessType: "lifetime", accessDays: 30 },
        }),
      ).rejects.toThrow();
    });
  });

  it("acces limitat în zile fără zile e refuzat; cu zile valide trece; cu zile în afara intervalului e refuzat", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(
        tx.digitalProduct.update({
          where: { productId: f.productId },
          data: { accessType: "limited_days", accessDays: null },
        }),
      ).rejects.toThrow();
    });
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await tx.digitalProduct.update({
        where: { productId: f.productId },
        data: { accessType: "limited_days", accessDays: 30 },
      });
    });
    for (const days of [0, 3651]) {
      await inRolledBackTransaction(db, async (tx) => {
        const f = await fixture(tx);
        await expect(
          tx.digitalProduct.update({
            where: { productId: f.productId },
            data: { accessType: "limited_days", accessDays: days },
          }),
        ).rejects.toThrow();
      });
    }
  });

  it("tip de acces necunoscut e refuzat", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(
        tx.digitalProduct.update({
          where: { productId: f.productId },
          data: { accessType: "weekly", accessDays: null },
        }),
      ).rejects.toThrow();
    });
  });

  it.each([0, -1, 100_001])("limita de descărcări %s e refuzată", async (value) => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(
        tx.digitalProduct.update({
          where: { productId: f.productId },
          data: { maxDownloads: value },
        }),
      ).rejects.toThrow();
    });
  });

  it("cerința de cont nu se poate opri", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(
        tx.digitalProduct.update({
          where: { productId: f.productId },
          data: { requiresLogin: false },
        }),
      ).rejects.toThrow();
    });
  });

  it("ștergerea produsului șterge extensia și modulele (cascadă)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await tx.digitalAsset.create(
        asset(f.productId, { type: "file", provider: "local", storageKey: "private/digital/a" }),
      );
      await tx.product.delete({ where: { id: f.productId } });
      expect(await tx.digitalProduct.count({ where: { productId: f.productId } })).toBe(0);
      expect(await tx.digitalAsset.count({ where: { productId: f.productId } })).toBe(0);
    });
  });

  it("cu drepturi de acces existente produsul NU se poate șterge (RESTRICT)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await entitlement(tx, f);
      await expect(tx.product.delete({ where: { id: f.productId } })).rejects.toThrow();
    });
  });
});

describe("DigitalAsset", () => {
  it("video local, fișier local, video bunny, fișier s3 și legătură https: trec", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await tx.digitalAsset.create(
        asset(f.productId, { type: "video", provider: "local", storageKey: "private/d/1" }),
      );
      await tx.digitalAsset.create(
        asset(f.productId, { type: "file", provider: "local", storageKey: "private/d/2" }),
      );
      await tx.digitalAsset.create(
        asset(f.productId, { type: "video", provider: "bunny", storageKey: "guid-1" }),
      );
      await tx.digitalAsset.create(
        asset(f.productId, { type: "file", provider: "s3", storageKey: "private/d/3" }),
      );
      await tx.digitalAsset.create(
        asset(f.productId, { type: "link", externalUrl: "https://exemplu.test/resursa" }),
      );
      expect(await tx.digitalAsset.count({ where: { productId: f.productId } })).toBe(5);
    });
  });

  it.each([
    ["tip necunoscut", { type: "audio", provider: "local", storageKey: "k" }],
    ["stare necunoscută", { type: "file", provider: "local", storageKey: "k", status: "pending" }],
    ["video fără furnizor (cheie setată)", { type: "video", storageKey: "k" }],
    ["video fără cheie (furnizor setat)", { type: "video", provider: "local" }],
    ["fișier fără furnizor (cheie setată)", { type: "file", storageKey: "k" }],
    ["fișier fără cheie (furnizor setat)", { type: "file", provider: "local" }],
    ["fișier pe bunny", { type: "file", provider: "bunny", storageKey: "k" }],
    ["video pe s3", { type: "video", provider: "s3", storageKey: "k" }],
    ["furnizor necunoscut", { type: "file", provider: "ftp", storageKey: "k" }],
    ["legătură fără adresă", { type: "link" }],
    [
      "legătură cu cheie (adresă setată)",
      { type: "link", externalUrl: "https://a.test", storageKey: "k" },
    ],
    [
      "legătură cu furnizor (adresă setată)",
      { type: "link", externalUrl: "https://a.test", provider: "local" },
    ],
    [
      "fișier cu adresă externă",
      { type: "file", provider: "local", storageKey: "k", externalUrl: "https://a.test" },
    ],
    ["legătură ne-https", { type: "link", externalUrl: "http://a.test" }],
    ["cheie goală (doar spații)", { type: "file", provider: "local", storageKey: "  " }],
    ["titlu gol", { title: "  ", type: "file", provider: "local", storageKey: "k" }],
    ["poziție negativă", { type: "file", provider: "local", storageKey: "k", position: -1 }],
    ["mărime negativă", { type: "file", provider: "local", storageKey: "k", fileSize: -1n }],
    ["durată negativă", { type: "video", provider: "local", storageKey: "k", durationSeconds: -1 }],
  ])("%s e refuzat", async (_label, data) => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(tx.digitalAsset.create(asset(f.productId, data))).rejects.toThrow();
    });
  });

  it("un modul nu poate aparține unui produs fără extensie digitală", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      const other = await tx.product.create({ data: { slug: `fiz-${uid()}`, title: "Fizic" } });
      await expect(
        tx.digitalAsset.create(
          asset(other.id, { type: "file", provider: "local", storageKey: "k" }),
        ),
      ).rejects.toThrow();
      expect(f.productId).not.toBe(other.id);
    });
  });
});

describe("DigitalEntitlement", () => {
  it("o linie are cel mult un drept de acces (unicitate pe linie)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await entitlement(tx, f);
      await expect(entitlement(tx, f)).rejects.toThrow();
    });
  });

  it("jetonul de acces e unic", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await fixture(tx);
      const b = await fixture(tx);
      const token = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
      await entitlement(tx, a, { accessToken: token });
      await expect(entitlement(tx, b, { accessToken: token })).rejects.toThrow();
    });
  });

  it("jeton prea scurt e refuzat", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(entitlement(tx, f, { accessToken: "scurt" })).rejects.toThrow();
    });
  });

  it("motiv de acordare necunoscut e refuzat", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(entitlement(tx, f, { grantReason: "gratis" })).rejects.toThrow();
    });
  });

  it("contorul nu depășește limita (CHECK în bază)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      const e = await entitlement(tx, f, { maxDownloads: 2, downloadCount: 2 });
      await expect(
        tx.digitalEntitlement.update({ where: { id: e.id }, data: { downloadCount: 3 } }),
      ).rejects.toThrow();
    });
  });

  it("contor negativ sau limită nulă/zero/negativă sunt refuzate", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(entitlement(tx, f, { downloadCount: -1 })).rejects.toThrow();
    });
    for (const max of [0, -1]) {
      await inRolledBackTransaction(db, async (tx) => {
        const f = await fixture(tx);
        await expect(entitlement(tx, f, { maxDownloads: max })).rejects.toThrow();
      });
    }
  });

  it("fără limită, contorul crește oricât", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      const e = await entitlement(tx, f, { maxDownloads: null, downloadCount: 500 });
      expect(e.downloadCount).toBe(500);
    });
  });

  it("revocarea: moment și motiv împreună (una setată, una nulă e refuzată în ambele sensuri)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await entitlement(tx, f, { revokedAt: new Date(), revokedReason: "Rambursat" });
    });
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(entitlement(tx, f, { revokedAt: new Date() })).rejects.toThrow();
    });
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(entitlement(tx, f, { revokedReason: "Rambursat" })).rejects.toThrow();
    });
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(entitlement(tx, f, { revokedBy: "admin@exemplu.test" })).rejects.toThrow();
    });
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      await expect(
        entitlement(tx, f, { revokedAt: new Date(), revokedReason: "   " }),
      ).rejects.toThrow();
    });
  });

  it("expirarea trebuie să fie după acordare", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      const granted = new Date(Date.now() - 60_000);
      await expect(
        entitlement(tx, f, { grantedAt: granted, expiresAt: new Date(granted.getTime() - 1) }),
      ).rejects.toThrow();
    });
  });

  it("ștergerea comenzii șterge drepturile de acces și jurnalul lor (cascadă, ca la curățarea E2E)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      const e = await entitlement(tx, f);
      await tx.digitalAccessLog.create({ data: { entitlementId: e.id, action: "view" } });
      await tx.order.delete({ where: { id: f.orderId } });
      expect(await tx.digitalEntitlement.count({ where: { id: e.id } })).toBe(0);
      expect(await tx.digitalAccessLog.count({ where: { entitlementId: e.id } })).toBe(0);
    });
  });
});

describe("DigitalAccessLog", () => {
  it("acțiuni permise: view și download; altceva e refuzat", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      const e = await entitlement(tx, f);
      await tx.digitalAccessLog.create({
        data: { entitlementId: e.id, action: "view", ip: "203.0.113.5", userAgent: "Test" },
      });
      await tx.digitalAccessLog.create({ data: { entitlementId: e.id, action: "download" } });
      await expect(
        tx.digitalAccessLog.create({ data: { entitlementId: e.id, action: "stream" } }),
      ).rejects.toThrow();
    });
  });

  it("IP-ul și user-agent-ul au lungime limitată", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      const e = await entitlement(tx, f);
      await expect(
        tx.digitalAccessLog.create({
          data: { entitlementId: e.id, action: "view", ip: "x".repeat(65) },
        }),
      ).rejects.toThrow();
    });
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      const e = await entitlement(tx, f);
      await expect(
        tx.digitalAccessLog.create({
          data: { entitlementId: e.id, action: "view", userAgent: "x".repeat(401) },
        }),
      ).rejects.toThrow();
    });
  });

  it("ștergerea unui modul păstrează jurnalul (assetId devine nul)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      const e = await entitlement(tx, f);
      const a = await tx.digitalAsset.create(
        asset(f.productId, { type: "file", provider: "local", storageKey: "k" }),
      );
      const log = await tx.digitalAccessLog.create({
        data: { entitlementId: e.id, assetId: a.id, action: "download" },
      });
      await tx.digitalAsset.delete({ where: { id: a.id } });
      const kept = await tx.digitalAccessLog.findUniqueOrThrow({ where: { id: log.id } });
      expect(kept.assetId).toBeNull();
    });
  });
});

describe("linia de comandă", () => {
  it("`isDigital` e fals implicit", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await fixture(tx);
      const plain = await tx.orderLine.create({
        data: {
          orderId: f.orderId,
          sku: `S-${uid()}`,
          title: "Fizic",
          quantity: 10_000n,
          unitSymbol: "buc",
          unitDecimals: 0,
          unitPriceMinor: 100,
          lineTotalMinor: 100,
          netMinor: 83,
          taxMinor: 17,
          taxRateBps: 2100,
          stockState: "in_stock",
          shippingClass: "standard",
          productSnapshot: {},
        },
      });
      expect(plain.isDigital).toBe(false);
    });
  });
});
