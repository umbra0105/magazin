import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { ProductService } from "./product-service";
import { createPrismaProductStore, type ProductStore } from "./product-store";

/**
 * Blocul C, C-13, pe Postgres real: doi administratori șterg, simultan, câte una din cele două variante ale unui produs.
 * Verificarea «nu e ultima variantă» se făcea în afara tranzacției de ștergere și nu se relua în ea: ambele treceau, iar
 * produsul rămânea FĂRĂ nicio variantă (și fără variantă implicită), fără nicio constrângere care să o oprească.
 * Determinist: o barieră în `listVariantsOf` face ca ambele apeluri să citească înainte ca vreunul să șteargă.
 */

const db = getDb();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const subject: PermissionSubject = {
  userId: "u-variant",
  email: "variant@magazin.test",
  roles: ["manager"],
  permissions: new Set(["admin.access", "products.write", "products.read"]),
};

afterAll(async () => {
  await db.$disconnect();
});

function serviceOver(store: ProductStore) {
  return new ProductService({
    store,
    audit: new AuditService({ append: async () => undefined, list: async () => [] }),
    defaultManageStock: async () => true,
    logger: createLogger({ destination: { write() {} } }),
  });
}

async function productWithVariants(tag: string, count: number) {
  const product = await db.product.create({
    data: {
      slug: `zz-var-${tag}`,
      title: `ZZ variante ${tag}`,
      variants: {
        create: Array.from({ length: count }, (_, i) => ({
          sku: `ZZ-${tag}-${i}`,
          price: 1000 + i,
          position: i,
          isDefault: i === 0,
        })),
      },
    },
    select: { id: true, variants: { select: { id: true }, orderBy: { position: "asc" } } },
  });
  return product;
}

describe("deleteVariant: ștergeri simultane (Postgres real)", () => {
  it("două ștergeri simultane din două variante lasă produsul cu o variantă; a doua primește «ultima variantă»", async () => {
    const tag = randomUUID().slice(0, 8);
    const product = await productWithVariants(tag, 2);
    try {
      const real = createPrismaProductStore(db);
      let reads = 0;
      let bothRead: () => void = () => undefined;
      const both = new Promise<void>((resolve) => {
        bothRead = resolve;
      });
      const store: ProductStore = {
        ...real,
        async listVariantsOf(productId) {
          const rows = await real.listVariantsOf(productId);
          reads++;
          if (reads >= 2) bothRead();
          // primul apel așteaptă ca și al doilea să fi citit (sau expiră, dacă al doilea e blocat de un lacăt)
          if (reads === 1) await Promise.race([both, sleep(600)]);
          return rows;
        },
      };
      const service = serviceOver(store);
      const [first, second] = product.variants.map((v) => v.id) as [string, string];

      const results = await Promise.allSettled([
        service.deleteVariant(subject, first),
        (async () => {
          await sleep(30);
          return service.deleteVariant(subject, second);
        })(),
      ]);

      const remaining = await db.productVariant.findMany({
        where: { productId: product.id },
        select: { id: true, isDefault: true },
      });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.isDefault).toBe(true);
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ code: "CATALOG_VARIANT_LAST" });
    } finally {
      await db.product.deleteMany({ where: { id: product.id } });
    }
  }, 30_000);

  it("ștergerea obișnuită a unei variante dintre trei merge, iar prima rămasă devine implicită", async () => {
    const tag = randomUUID().slice(0, 8);
    const product = await productWithVariants(tag, 3);
    try {
      const service = serviceOver(createPrismaProductStore(db));
      const result = await service.deleteVariant(subject, product.variants[0]?.id as string);
      expect(result.remaining).toBe(2);
      const left = await db.productVariant.findMany({
        where: { productId: product.id },
        select: { isDefault: true },
      });
      expect(left.filter((v) => v.isDefault)).toHaveLength(1);
    } finally {
      await db.product.deleteMany({ where: { id: product.id } });
    }
  });
});
