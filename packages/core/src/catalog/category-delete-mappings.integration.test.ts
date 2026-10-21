import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { CategoryService } from "./category-service";
import { createPrismaCategoryStore, type CategoryStore } from "./category-store";

/**
 * Blocul C, C-16, pe Postgres real: o categorie goală (fără copii și fără produse) se putea șterge deși avea mapări către
 * canale de vânzare (eMAG): `ChannelCategoryMapping.category` are `ON DELETE CASCADE`, deci mapările dispăreau în tăcere.
 * Acum ștergerea se refuză, cu lista canalelor, iar verificarea se repetă în tranzacția de ștergere, cu categoria blocată:
 * o mapare adăugată între verificare și ștergere nu mai poate fi pierdută.
 */

const db = getDb();
const subject: PermissionSubject = {
  userId: "u-del",
  email: "del@magazin.test",
  roles: ["manager"],
  permissions: new Set(["admin.access", "products.write"]),
};
const categories: string[] = [];
const channels: string[] = [];

afterAll(async () => {
  await db.channelCategoryMapping.deleteMany({ where: { categoryId: { in: categories } } });
  await db.category.deleteMany({ where: { id: { in: categories } } });
  await db.salesChannel.deleteMany({ where: { id: { in: channels } } });
  await db.$disconnect();
});

const serviceOver = (store: CategoryStore) =>
  new CategoryService({
    store,
    audit: new AuditService({ append: async () => undefined, list: async () => [] }),
    logger: createLogger({ destination: { write() {} } }),
  });

async function setup(tag: string) {
  const category = await db.category.create({
    data: {
      name: `ZZ Cat ${tag}`,
      slug: `zz-cat-${tag}`,
      path: `zz-cat-${tag}`,
      depth: 0,
      sortOrder: 0,
    },
  });
  const channel = await db.salesChannel.create({
    data: { code: `zz_${tag}`.replace(/[^a-z0-9_]/g, ""), name: `Canal ${tag}` },
  });
  categories.push(category.id);
  channels.push(channel.id);
  const map = () =>
    db.channelCategoryMapping.create({
      data: { channelId: channel.id, categoryId: category.id, externalCategoryId: "123" },
    });
  return { category, channel, map };
}

describe("ștergerea categoriei cu mapări către canale (Postgres real)", () => {
  it("se refuză cu lista canalelor; categoria și maparea rămân", async () => {
    const tag = randomUUID().slice(0, 8);
    const { category, map } = await setup(tag);
    await map();
    const service = serviceOver(createPrismaCategoryStore(db));
    const error = await service.delete(subject, category.id).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CATEGORY_HAS_CHANNEL_MAPPINGS" });
    expect((error as Error).message).toContain(`Canal ${tag}`);
    expect(await db.category.count({ where: { id: category.id } })).toBe(1);
    expect(await db.channelCategoryMapping.count({ where: { categoryId: category.id } })).toBe(1);
  });

  it("după ce maparea e scoasă, categoria goală se șterge", async () => {
    const tag = randomUUID().slice(0, 8);
    const { category, map } = await setup(tag);
    await map();
    await db.channelCategoryMapping.deleteMany({ where: { categoryId: category.id } });
    await serviceOver(createPrismaCategoryStore(db)).delete(subject, category.id);
    expect(await db.category.count({ where: { id: category.id } })).toBe(0);
  });

  it("o mapare adăugată ÎNTRE verificare și ștergere nu e pierdută: ștergerea se refuză", async () => {
    const tag = randomUUID().slice(0, 8);
    const { category, map } = await setup(tag);
    const real = createPrismaCategoryStore(db);
    const store: CategoryStore = {
      ...real,
      async delete(id) {
        await map(); // alt proces adaugă maparea după ce serviciul a verificat că nu există niciuna
        return real.delete(id);
      },
    };
    const error = await serviceOver(store)
      .delete(subject, category.id)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CATEGORY_HAS_CHANNEL_MAPPINGS" });
    expect(await db.category.count({ where: { id: category.id } })).toBe(1);
    expect(await db.channelCategoryMapping.count({ where: { categoryId: category.id } })).toBe(1);
  });
});
