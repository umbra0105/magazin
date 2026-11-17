import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction } from "../test-utils/rollback";
import { createPrismaBrandStore } from "./brand-service";
import { createPrismaCategoryStore } from "./category-store";
import { planMove, planRename, type CategoryNode } from "./category-tree";
import { createPrismaProductStore } from "./product-store";
import { findRedirectTarget } from "./slug-redirect";

const db = getDb();
afterAll(() => db.$disconnect());
const uid = (): string => randomUUID().slice(0, 8);

describe("istoric de adrese în bază (C-43)", () => {
  it("produs: schimbarea slugului păstrează adresa veche spre produs, fără lanțuri", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = `pompa-${uid()}`;
      const product = await tx.product.create({ data: { slug: a, title: "Pompă" } });
      const store = createPrismaProductStore(tx);
      const b = `${a}-b`;
      const c = `${a}-c`;
      await store.updateProduct(product.id, { slug: b });
      await store.updateProduct(product.id, { slug: c });
      expect(await findRedirectTarget(tx, "product", a)).toBe(product.id);
      expect(await findRedirectTarget(tx, "product", b)).toBe(product.id);
      expect(await findRedirectTarget(tx, "product", c)).toBeNull(); // adresa curentă nu e în istoric
    });
  });

  it("produs: revenirea la o adresă veche o scoate din istoric", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = `filtru-${uid()}`;
      const product = await tx.product.create({ data: { slug: a, title: "Filtru" } });
      const store = createPrismaProductStore(tx);
      await store.updateProduct(product.id, { slug: `${a}-nou` });
      await store.updateProduct(product.id, { slug: a });
      expect(await findRedirectTarget(tx, "product", a)).toBeNull();
      expect(await findRedirectTarget(tx, "product", `${a}-nou`)).toBe(product.id);
    });
  });

  it("produs: o salvare fără schimbare de slug sau cu aceeași adresă nu scrie nimic", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = `duza-${uid()}`;
      const product = await tx.product.create({ data: { slug: a, title: "Duză" } });
      const store = createPrismaProductStore(tx);
      await store.updateProduct(product.id, { title: "Duză nouă" });
      await store.updateProduct(product.id, { slug: a });
      expect(await tx.slugRedirect.count({ where: { targetId: product.id } })).toBe(0);
    });
  });

  it("brand: schimbarea slugului păstrează adresa veche", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = `brand-${uid()}`;
      const brand = await tx.brand.create({ data: { slug: a, name: "Brand" } });
      await createPrismaBrandStore(tx).update(brand.id, { slug: `${a}-nou` });
      expect(await findRedirectTarget(tx, "brand", a)).toBe(brand.id);
    });
  });

  it("categorie: redenumirea unui părinte redirecționează părintele și descendenții", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const root = `pompe-${uid()}`;
      const parent = await tx.category.create({
        data: { slug: root, name: "Pompe", path: root, depth: 0 },
      });
      const child = await tx.category.create({
        data: {
          slug: "filtrare",
          name: "Filtrare",
          path: `${root}/filtrare`,
          depth: 1,
          parentId: parent.id,
        },
      });
      const store = createPrismaCategoryStore(tx);
      const nodes = (await store.listAll()) as unknown as CategoryNode[];
      await store.applyUpdates(planRename(nodes, parent.id, `${root}-noi`));
      expect(await findRedirectTarget(tx, "category", root)).toBe(parent.id);
      expect(await findRedirectTarget(tx, "category", `${root}/filtrare`)).toBe(child.id);
      expect(await findRedirectTarget(tx, "category", `${root}-noi`)).toBeNull();
    });
  });

  it("categorie: mutarea sub alt părinte redirecționează calea veche", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const r1 = `a-${uid()}`;
      const r2 = `b-${uid()}`;
      const p1 = await tx.category.create({ data: { slug: r1, name: "A", path: r1, depth: 0 } });
      const p2 = await tx.category.create({ data: { slug: r2, name: "B", path: r2, depth: 0 } });
      const kid = await tx.category.create({
        data: { slug: "x", name: "X", path: `${r1}/x`, depth: 1, parentId: p1.id },
      });
      const store = createPrismaCategoryStore(tx);
      const nodes = (await store.listAll()) as unknown as CategoryNode[];
      await store.applyUpdates(planMove(nodes, kid.id, p2.id, 0));
      expect(await findRedirectTarget(tx, "category", `${r1}/x`)).toBe(kid.id);
    });
  });
});
