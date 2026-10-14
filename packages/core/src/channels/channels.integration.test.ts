import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, type Prisma } from "@ecom/db";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { CHANNEL_LISTING_STATUSES, CHANNEL_SYNC_STATUSES, WEB_CHANNEL_CODE } from "./constants";

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

async function setup(tx: TestTx) {
  const channel = await tx.salesChannel.create({
    data: { code: `emag_${uid()}`, name: "eMAG", requiresEan: true, requiresBrand: true },
  });
  const product = await tx.product.create({ data: { slug: `p-${uid()}`, title: "Produs" } });
  const variant = await tx.productVariant.create({
    data: { productId: product.id, sku: `SKU-${uid()}`, price: 10000 },
  });
  return { channel, product, variant };
}

const listing = (
  c: Awaited<ReturnType<typeof setup>>,
  over: Partial<Prisma.ChannelListingUncheckedCreateInput> = {},
): { data: Prisma.ChannelListingUncheckedCreateInput } => ({
  data: {
    channelId: c.channel.id,
    productId: c.product.id,
    variantId: c.variant.id,
    ...over,
  },
});

/** Rulează într-o tranzacție anulată și cere ca baza să respingă scrierea (opțional: după nume). */
async function violation(fn: (tx: TestTx) => Promise<unknown>, expected?: string): Promise<void> {
  const error = await inRolledBackTransaction(db, async (tx) => {
    try {
      await fn(tx);
      return null;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  });
  expect(error, "baza trebuia să respingă scrierea").not.toBeNull();
  if (expected) expect(JSON.stringify(error) + String(error?.message)).toContain(expected);
}

describe("canalul web", () => {
  it("seed-ul creează canalul de sistem `web`, idempotent, fără cerințe de EAN/brand", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await runBaseSeed(tx);
      const again = await runBaseSeed(tx);
      expect(again.salesChannels).toBe(0);
      const web = await tx.salesChannel.findUniqueOrThrow({ where: { code: WEB_CHANNEL_CODE } });
      expect(web).toMatchObject({
        isSystem: true,
        isActive: true,
        requiresEan: false,
        requiresBrand: false,
      });
      expect(await tx.salesChannel.count({ where: { code: WEB_CHANNEL_CODE } })).toBe(1);
    });
  });

  it("canalul de sistem nu se poate șterge; unul obișnuit da", async () => {
    await violation(async (tx) => {
      await runBaseSeed(tx);
      await tx.salesChannel.delete({ where: { code: WEB_CHANNEL_CODE } });
    }, "sales_channel_system_protected");
    await inRolledBackTransaction(db, async (tx) => {
      const c = await tx.salesChannel.create({ data: { code: `tmp_${uid()}`, name: "Temporar" } });
      await tx.salesChannel.delete({ where: { id: c.id } });
    });
  });

  it("codul canalului: litere mici, cifre, _; unic", async () => {
    await violation(
      (tx) => tx.salesChannel.create({ data: { code: "eMAG-RO", name: "x" } }),
      "sales_channel_code_check",
    );
    await violation(async (tx) => {
      await tx.salesChannel.create({ data: { code: "dublu", name: "x" } });
      await tx.salesChannel.create({ data: { code: "dublu", name: "y" } });
    });
  });
});

describe("oferte pe canal", () => {
  it("stările permise coincid cu constantele; implicit draft, fără erori de validare", async () => {
    expect([...CHANNEL_LISTING_STATUSES]).toEqual([
      "draft",
      "pending",
      "active",
      "rejected",
      "inactive",
    ]);
    await inRolledBackTransaction(db, async (tx) => {
      const c = await setup(tx);
      const l = await tx.channelListing.create(listing(c));
      expect(l).toMatchObject({ status: "draft", validationErrors: [], price: null, stock: null });
      for (const status of CHANNEL_LISTING_STATUSES) {
        await tx.channelListing.update({ where: { id: l.id }, data: { status } });
      }
      for (const lastSyncStatus of CHANNEL_SYNC_STATUSES) {
        await tx.channelListing.update({ where: { id: l.id }, data: { lastSyncStatus } });
      }
    });
    await violation(async (tx) => {
      const c = await setup(tx);
      await tx.channelListing.create(listing(c, { status: "published" }));
    }, "channel_listing_status_check");
    await violation(async (tx) => {
      const c = await setup(tx);
      await tx.channelListing.create(listing(c, { lastSyncStatus: "partial" }));
    }, "channel_listing_lastSyncStatus_check");
  });

  it("promoția pe canal: cere prețul canalului (una setată, una nulă) și nu îl depășește", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const c = await setup(tx);
      await tx.channelListing.create(listing(c, { price: 9000, salePrice: 8000 }));
    });
    // salePrice setat, price nul: CHECK-ul cu comparații explicite îl respinge
    await violation(async (tx) => {
      const c = await setup(tx);
      await tx.channelListing.create(listing(c, { price: null, salePrice: 8000 }));
    }, "channel_listing_salePrice_check");
    await violation(async (tx) => {
      const c = await setup(tx);
      await tx.channelListing.create(listing(c, { price: 9000, salePrice: 9001 }));
    }, "channel_listing_salePrice_check");
    await violation(async (tx) => {
      const c = await setup(tx);
      await tx.channelListing.create(listing(c, { price: -1 }));
    }, "channel_listing_price_check");
    await violation(async (tx) => {
      const c = await setup(tx);
      await tx.channelListing.create(listing(c, { stock: -1 }));
    }, "channel_listing_stock_check");
  });

  it("o ofertă per variantă și canal; același ID extern o singură dată pe canal", async () => {
    await violation(async (tx) => {
      const c = await setup(tx);
      await tx.channelListing.create(listing(c));
      await tx.channelListing.create(listing(c));
    });
    await violation(async (tx) => {
      const c = await setup(tx);
      const other = await tx.productVariant.create({
        data: { productId: c.product.id, sku: `SKU-${uid()}`, price: 100 },
      });
      await tx.channelListing.create(listing(c, { externalId: "emag-1" }));
      await tx.channelListing.create({
        data: {
          channelId: c.channel.id,
          productId: c.product.id,
          variantId: other.id,
          externalId: "emag-1",
        },
      });
    }, "channel_listing_external_key");
    await inRolledBackTransaction(db, async (tx) => {
      const c = await setup(tx);
      const other = await tx.productVariant.create({
        data: { productId: c.product.id, sku: `SKU-${uid()}`, price: 100 },
      });
      await tx.channelListing.create(listing(c)); // fără externalId
      await tx.channelListing.create({
        data: { channelId: c.channel.id, productId: c.product.id, variantId: other.id },
      }); // două oferte fără ID extern sunt permise
    });
  });

  it("varianta trebuie să aparțină produsului; oferta dispare cu produsul; canalul cu oferte nu se șterge", async () => {
    await violation(async (tx) => {
      const c = await setup(tx);
      const otherProduct = await tx.product.create({ data: { slug: `p-${uid()}`, title: "Alt" } });
      await tx.channelListing.create({
        data: {
          channelId: c.channel.id,
          productId: otherProduct.id,
          variantId: c.variant.id,
        },
      });
    }, "channel_listing_variantId_productId_fkey");
    await inRolledBackTransaction(db, async (tx) => {
      const c = await setup(tx);
      await tx.channelListing.create(listing(c));
      await tx.product.delete({ where: { id: c.product.id } });
      expect(await tx.channelListing.count({ where: { channelId: c.channel.id } })).toBe(0);
    });
    await violation(async (tx) => {
      const c = await setup(tx);
      await tx.channelListing.create(listing(c));
      await tx.salesChannel.delete({ where: { id: c.channel.id } });
    }, "channel_listing_channelId_fkey");
  });
});

describe("maparea categoriilor", () => {
  it("o mapare per categorie și canal; dispare cu categoria sau cu canalul", async () => {
    await violation(async (tx) => {
      const c = await setup(tx);
      const category = await tx.category.create({
        data: { slug: `c-${uid()}`, name: "C", path: `c-${uid()}` },
      });
      const data = {
        channelId: c.channel.id,
        categoryId: category.id,
        externalCategoryId: "4242",
      };
      await tx.channelCategoryMapping.create({ data });
      await tx.channelCategoryMapping.create({ data: { ...data, externalCategoryId: "9" } });
    });
    await inRolledBackTransaction(db, async (tx) => {
      const c = await setup(tx);
      const category = await tx.category.create({
        data: { slug: `c-${uid()}`, name: "C", path: `c-${uid()}` },
      });
      const m = await tx.channelCategoryMapping.create({
        data: {
          channelId: c.channel.id,
          categoryId: category.id,
          externalCategoryId: "4242",
          characteristicsMap: { debit: "Debit (m3/h)" },
        },
      });
      expect(m.characteristicsMap).toEqual({ debit: "Debit (m3/h)" });
      await tx.category.delete({ where: { id: category.id } });
      expect(await tx.channelCategoryMapping.count({ where: { channelId: c.channel.id } })).toBe(0);
    });
  });
});
