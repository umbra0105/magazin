import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { DEFAULT_ROLES } from "../../rbac/catalog";
import type { PermissionSubject } from "../../rbac/can";
import { inRolledBackTransaction, type TestTx } from "../../test-utils/rollback";
import { ProductListService, createPrismaProductListStore } from "../product-list";
import { countProductsMissingNir } from "./missing-nir";

/**
 * «Produse fără preț NIR» (Faza 15): filtrul din lista de produse și numărătoarea din indicator. Filtrul există DOAR pentru cine are
 * `products.cost.view`: pentru ceilalți e ignorat, ca lista să nu spună, produs cu produs, ce are preț de achiziție și ce nu.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const uid = (): string => randomUUID().slice(0, 8);
const storage = new LocalStorageDriver({
  rootDir: "unused-in-test",
  appUrl: "https://magazin.test",
  signingKey: deriveSigningKey(Buffer.alloc(32, 5).toString("base64")),
});

const subjectFor = (role: string): PermissionSubject => ({
  userId: `u_${uid()}`,
  email: `${role}@exemplu.test`,
  roles: [role],
  permissions: new Set(DEFAULT_ROLES.find((r) => r.key === role)?.permissions ?? []),
});

async function product(tx: TestTx, tag: string, costs: Array<number | null>) {
  const created = await tx.product.create({
    data: { slug: `${tag}-${uid()}`, title: `${tag} produs`, status: "active" },
  });
  for (const [index, costPrice] of costs.entries()) {
    await tx.productVariant.create({
      data: { productId: created.id, sku: `${tag}-${uid()}-${index}`, price: 10_000, costPrice },
    });
  }
  return created;
}

describe("produse fără preț NIR", () => {
  it("filtrul ține produsele cu cel puțin o variantă fără cost; cu cost pe toate variantele, nu", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const tag = `nir${uid()}`;
      const withoutAny = await product(tx, tag, [null]);
      const partial = await product(tx, tag, [1_000, null]);
      const full = await product(tx, tag, [1_000, 2_000]);
      const service = new ProductListService({ store: createPrismaProductListStore(tx), storage });
      const ids = async (subject: PermissionSubject, nir: boolean) =>
        (
          await service.list(subject, { q: tag, ...(nir ? { nir: "lipsa" } : {}), size: "100" })
        ).page.rows
          .map((row) => row.id)
          .sort();

      const manager = subjectFor("manager"); // vede costul
      expect(await ids(manager, false)).toEqual([withoutAny.id, partial.id, full.id].sort());
      expect(await ids(manager, true)).toEqual([withoutAny.id, partial.id].sort());
    });
  });

  it("fără products.cost.view filtrul se ignoră: lista întoarce toate produsele, nu o listă care trădează costul", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const tag = `nir${uid()}`;
      const withoutAny = await product(tx, tag, [null]);
      const full = await product(tx, tag, [1_000]);
      const service = new ProductListService({ store: createPrismaProductListStore(tx), storage });
      for (const role of ["editor", "warehouse"]) {
        const page = await service.list(subjectFor(role), { q: tag, nir: "lipsa", size: "100" });
        expect(page.query.missingNir, role).toBe(false);
        expect(page.page.rows.map((row) => row.id).sort(), role).toEqual(
          [withoutAny.id, full.id].sort(),
        );
      }
    });
  });

  it("numărătoarea ține cont doar de produsele active, în afara coșului de gunoi", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const before = await countProductsMissingNir(tx);
      const tag = `nir${uid()}`;
      await product(tx, tag, [null]);
      await product(tx, tag, [500]);
      const archived = await product(tx, tag, [null]);
      await tx.product.update({ where: { id: archived.id }, data: { status: "archived" } });
      const trashed = await product(tx, tag, [null]);
      await tx.product.update({ where: { id: trashed.id }, data: { deletedAt: new Date() } });
      expect(await countProductsMissingNir(tx)).toBe(before + 1);
    });
  });
});
