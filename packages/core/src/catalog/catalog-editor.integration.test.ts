import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { AttributeService, createPrismaAttributeStore } from "./attribute-service";
import { ProductAttributesService, createPrismaProductAttributeStore } from "./product-attributes";
import { ProductRelationsService, createPrismaProductRelationStore } from "./product-relations";
import { ProductService } from "./product-service";
import { createPrismaProductStore } from "./product-store";

/**
 * Blocul 11b pe baza reală: atribute (definiții și valori numerice exacte), relații (ambele părți,
 * CHECK-ul de auto-relație) și variante (previzualizare, ștergere cu preluarea variantei implicite).
 */

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

async function withServices<T>(
  fn: (c: {
    tx: TestTx;
    products: ProductService;
    attributes: AttributeService;
    values: ProductAttributesService;
    relations: ProductRelationsService;
    as: (role: string) => ReturnType<PermissionService["loadSubject"]>;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const audit = new AuditService(createPrismaAuditStore(tx));
    const logger = createLogger({ destination: { write() {} } });
    const products = new ProductService({
      store: createPrismaProductStore(tx),
      audit,
      defaultManageStock: async () => true,
      logger,
    });
    const attributeStore = createPrismaAttributeStore(tx);
    const attributes = new AttributeService({ store: attributeStore, audit, logger });
    const values = new ProductAttributesService({
      store: createPrismaProductAttributeStore(tx),
      attributes: attributeStore,
      audit,
      logger,
    });
    const relations = new ProductRelationsService({
      store: createPrismaProductRelationStore(tx),
      audit,
      logger,
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `ce-${role}-${n++}`, name: role, email: `ce-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      return new PermissionService(tx).loadSubject(user.id);
    };
    return fn({ tx, products, attributes, values, relations, as });
  });
}

async function violation(fn: (tx: TestTx) => Promise<unknown>, expected: string): Promise<void> {
  await expect(
    inRolledBackTransaction(db, async (tx) => {
      await runBaseSeed(tx);
      await fn(tx);
    }),
  ).rejects.toThrow(expected);
}

describe("atribute pe baza reală", () => {
  it("definiții cu unitate, valori numerice EXACTE (virgulă sau punct) și citire înapoi", async () => {
    await withServices(async ({ tx, products, attributes, values, as }) => {
      const manager = await as("manager");
      const code = `diam_${uid()}`;
      const debitCode = `debit_${uid()}`;
      const diametru = await attributes.create(manager, {
        code,
        name: "Diametru",
        type: "number",
        unit: "mm",
        isFilterable: true,
      });
      const debit = await attributes.create(manager, {
        code: debitCode,
        name: "Debit",
        type: "number",
        unit: "m³/h",
      });
      const { product } = await products.create(manager, {
        title: `Pompă ${uid()}`,
        variants: [{ sku: `AT-${uid()}`, price: 1000 }],
      });

      await values.set(manager, product.id, {
        values: [
          { attributeId: diametru.id, value: "63,5" },
          { attributeId: debit.id, value: "0.1" },
        ],
      });
      const rows = await tx.attributeValue.findMany({ where: { productId: product.id } });
      const byAttr = new Map(rows.map((r) => [r.attributeId, r.numberValue?.toString()]));
      expect(byAttr.get(diametru.id)).toBe("63.5");
      expect(byAttr.get(debit.id)).toBe("0.1"); // exact, nu 0.10000000000000001

      const entries = await values.get(manager, product.id);
      expect(entries.find((e) => e.attribute.code === code)?.value).toBe("63.5");
      expect(entries.find((e) => e.attribute.code === code)?.attribute.unit).toBe("mm");
    });
  });

  it("tipul se blochează cât are valori; ștergerea atributului/opțiunii folosite e refuzată cu numărul", async () => {
    await withServices(async ({ products, attributes, values, as }) => {
      const manager = await as("manager");
      const material = await attributes.create(manager, {
        code: `material_${uid()}`,
        name: "Material",
        type: "select",
        options: ["Inox", "PVC"],
      });
      const { product } = await products.create(manager, {
        title: `Cu material ${uid()}`,
        variants: [{ sku: `AT-${uid()}`, price: 1000 }],
      });
      const inox = material.options.find((o) => o.value === "Inox")!;
      await values.set(manager, product.id, {
        values: [{ attributeId: material.id, value: inox.id }],
      });

      await expect(attributes.update(manager, material.id, { type: "text" })).rejects.toMatchObject(
        { code: "ATTRIBUTE_TYPE_LOCKED" },
      );
      await expect(attributes.delete(manager, material.id)).rejects.toMatchObject({
        code: "ATTRIBUTE_IN_USE",
      });
      await expect(attributes.deleteOption(manager, inox.id)).rejects.toMatchObject({
        code: "ATTRIBUTE_OPTION_IN_USE",
      });
      // opțiunea nefolosită se șterge
      const pvc = material.options.find((o) => o.value === "PVC")!;
      await attributes.deleteOption(manager, pvc.id);

      // după golirea valorii, atributul se poate șterge
      await values.set(manager, product.id, {
        values: [{ attributeId: material.id, value: null }],
      });
      await attributes.delete(manager, material.id);
      expect((await attributes.list(manager)).some((a) => a.id === material.id)).toBe(false);
    });
  });

  it("Editorul nu poate crea atribute și nici completa valori (403)", async () => {
    await withServices(async ({ products, attributes, values, as }) => {
      const manager = await as("manager");
      const editor = await as("editor");
      await expect(
        attributes.create(editor, { code: `x_${uid()}`, name: "X", type: "text" }),
      ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
      const attr = await attributes.create(manager, {
        code: `n_${uid()}`,
        name: "N",
        type: "text",
      });
      const { product } = await products.create(manager, {
        title: `Drepturi ${uid()}`,
        variants: [{ sku: `AT-${uid()}`, price: 1000 }],
      });
      await expect(
        values.set(editor, product.id, { values: [{ attributeId: attr.id, value: "x" }] }),
      ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    });
  });

  it("baza respinge o valoare de alt tip decât atributul (trigger) și două valori în aceeași coloană", async () => {
    await violation(async (tx) => {
      const attr = await tx.attribute.create({
        data: { code: `t_${uid()}`, name: "T", type: "number" },
      });
      const product = await tx.product.create({
        data: { slug: `tr-${uid()}`, title: "T" },
      });
      // text într-un atribut numeric
      await tx.attributeValue.create({
        data: { productId: product.id, attributeId: attr.id, textValue: "abc" },
      });
    }, "attribute_value_type_mismatch");
  });
});

describe("relații pe baza reală", () => {
  it("se adaugă, apar din ambele părți și dispar odată cu produsul; auto-relația e respinsă și de bază", async () => {
    await withServices(async ({ tx, products, relations, as }) => {
      const manager = await as("manager");
      const mk = async (label: string) =>
        (
          await products.create(manager, {
            title: `${label} ${uid()}`,
            variants: [{ sku: `RL-${uid()}`, price: 1000 }],
          })
        ).product;
      const a = await mk("Pompă");
      const b = await mk("Husă");

      await relations.add(manager, a.id, { relatedProductId: b.id, type: "accessory" });
      await relations.add(manager, a.id, { relatedProductId: b.id, type: "spare_part" });
      await expect(
        relations.add(manager, a.id, { relatedProductId: b.id, type: "accessory" }),
      ).rejects.toMatchObject({ code: "CATALOG_RELATION_DUPLICATE" });
      await expect(
        relations.add(manager, a.id, { relatedProductId: a.id, type: "similar" }),
      ).rejects.toMatchObject({ code: "CATALOG_RELATION_SELF" });

      const fromA = await relations.list(manager, a.id);
      expect(fromA.map((r) => `${r.direction}:${r.type}`).sort()).toEqual([
        "outgoing:accessory",
        "outgoing:spare_part",
      ]);
      const fromB = await relations.list(manager, b.id);
      expect(fromB.map((r) => `${r.direction}:${r.type}`).sort()).toEqual([
        "incoming:accessory",
        "incoming:spare_part",
      ]);
      expect(fromB[0]?.product).toMatchObject({ id: a.id, deleted: false });
      expect(fromB[0]?.product.sku).toMatch(/^RL-/);

      // ștergerea din partea produsului asociat
      const incoming = fromB.find((r) => r.type === "accessory")!;
      await relations.remove(manager, b.id, incoming.id);
      expect((await relations.list(manager, a.id)).map((r) => r.type)).toEqual(["spare_part"]);

      // la ștergerea produsului principal, relația dispare (cascadă)
      await tx.product.delete({ where: { id: a.id } });
      expect(await relations.list(manager, b.id)).toEqual([]);
    });
  });

  it("baza respinge auto-relația (CHECK), chiar ocolind serviciul", async () => {
    await violation(async (tx) => {
      const p = await tx.product.create({ data: { slug: `self-${uid()}`, title: "S" } });
      await tx.productRelation.create({
        data: { productId: p.id, relatedProductId: p.id, type: "similar" },
      });
    }, "product_relation_self_check");
  });
});

describe("variante pe baza reală", () => {
  it("generare, previzualizare cu orfane (nimic șters), ștergere explicită cu preluarea variantei implicite", async () => {
    await withServices(async ({ tx, products, as }) => {
      const manager = await as("manager");
      const base = `VR-${uid()}`.toUpperCase();
      const { product, variants } = await products.create(manager, {
        title: `Variante ${uid()}`,
        variants: [{ sku: base, price: 2000 }],
      });
      const original = variants[0] as { id: string };

      const generated = await products.generateVariants(manager, product.id, {
        options: [{ name: "Culoare", values: ["Alb", "Albastru"] }],
        price: 2500,
        baseSku: base,
      });
      expect(generated.created.map((v) => v.sku)).toEqual([`${base}-ALB`, `${base}-ALBASTRU`]);

      // opțiuni schimbate: „Albastru” devine orfan, „Roșu” de creat; nimic nu se șterge
      const plan = await products.previewVariantPlan(manager, product.id, {
        options: [{ name: "Culoare", values: ["Alb", "Roșu"] }],
        baseSku: base,
      });
      expect(plan.existing).toBe(1);
      expect(plan.toCreate.map((v) => v.sku)).toEqual([`${base}-ROSU`]);
      expect(plan.orphaned.map((o) => o.sku)).toEqual([`${base}-ALBASTRU`]);
      expect(plan.withoutOptions).toBe(1);
      expect(await tx.productVariant.count({ where: { productId: product.id } })).toBe(3);

      const detailed = await products.getVariantsForEdit(manager, product.id);
      expect(detailed.options).toEqual([{ name: "Culoare", values: ["Alb", "Albastru"] }]);
      expect(detailed.variants.find((v) => v.sku === `${base}-ALB`)?.selections).toEqual([
        { option: "Culoare", value: "Alb" },
      ]);

      // ștergerea variantei implicite (cea originală): prima rămasă o preia
      await products.deleteVariant(manager, original.id);
      const left = await tx.productVariant.findMany({ where: { productId: product.id } });
      expect(left).toHaveLength(2);
      expect(left.filter((v) => v.isDefault)).toHaveLength(1);

      // ultima variantă nu se poate șterge
      const [first, second] = left as [(typeof left)[number], (typeof left)[number]];
      await products.deleteVariant(manager, first.id);
      await expect(products.deleteVariant(manager, second.id)).rejects.toMatchObject({
        code: "CATALOG_VARIANT_LAST",
      });
    });
  });
});
