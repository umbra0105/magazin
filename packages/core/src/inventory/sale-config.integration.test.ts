import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { createPrismaProductStore } from "../catalog/product-store";
import { ProductService } from "../catalog/product-service";
import type { PermissionSubject } from "../rbac/can";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { MeasureUnitService } from "./measure-unit-service";
import { createPrismaMeasureUnitStore } from "./measure-unit-store";

/**
 * Faza 5, punctul 3: configurarea de vânzare (unitate, bază de preț, pas, minim, conversie SmartBill) validată în
 * serviciu, pe baza reală. Cele 6 produse ale proprietarului sunt cazurile de lucru.
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
    units: MeasureUnitService;
    as: (role: string) => Promise<PermissionSubject>;
    unit: (code: string) => Promise<{ id: string; decimals: number }>;
    newProduct: (
      subject: PermissionSubject,
      extra?: Record<string, unknown>,
      variants?: Array<Record<string, unknown>>,
    ) => Promise<{ productId: string; variantIds: string[]; skus: string[] }>;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const audit = new AuditService(createPrismaAuditStore(tx));
    const logger = createLogger({ destination: { write() {} } });
    const products = new ProductService({
      store: createPrismaProductStore(tx),
      audit,
      defaultManageStock: async () => false,
      logger,
    });
    const units = new MeasureUnitService({ store: createPrismaMeasureUnitStore(tx), audit });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `sc-${role}-${n++}`, name: role, email: `sc-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      const subject = await new PermissionService(tx).loadSubject(user.id);
      if (!subject) throw new Error("subiect lipsă");
      return subject;
    };
    const unit = async (code: string) =>
      tx.measureUnit.findUniqueOrThrow({
        where: { code },
        select: { id: true, decimals: true },
      });
    const newProduct = async (
      subject: PermissionSubject,
      extra: Record<string, unknown> = {},
      variants: Array<Record<string, unknown>> = [{}],
    ) => {
      const created = await products.create(subject, {
        title: `Produs ${uid()}`,
        ...extra,
        variants: variants.map((v) => ({ sku: `SKU-${uid()}`, price: 10_000, ...v })),
      });
      return {
        productId: created.product.id,
        variantIds: created.variants.map((v) => v.id),
        skus: created.variants.map((v) => v.sku),
      };
    };
    return fn({ tx, products, units, as, unit, newProduct });
  });
}

interface Failure {
  code: string;
  message: string;
  paths: string[];
}

async function failure(fn: () => Promise<unknown>): Promise<Failure | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const error = e as {
      code?: string;
      message?: string;
      details?: { issues?: Array<{ path: string }> };
    };
    return {
      code: error.code ?? "FĂRĂ_COD",
      message: error.message ?? "",
      paths: (error.details?.issues ?? []).map((i) => i.path),
    };
  }
}

describe("produsul: unitate, bază de preț, pas și minim", () => {
  it("mozaic: mp cu 2 zecimale, cutia de 2,03 mp, preț pe unitate, minim 1 pas, cu prețul pasului afișat", async () => {
    await withServices(async ({ products, units, as, unit, newProduct }) => {
      const manager = await as("manager");
      const mp = await unit("mp");
      await units.update(manager, mp.id, { decimals: 2 });
      const { productId } = await newProduct(manager);
      const updated = await products.update(manager, productId, {
        measureUnitId: mp.id,
        priceBasis: "unit",
        saleStep: 20_300,
        minSteps: 1,
        showStepPrice: true,
      });
      expect(updated).toMatchObject({
        measureUnitId: mp.id,
        priceBasis: "unit",
        saleStep: 20_300,
        minSteps: 1,
        showStepPrice: true,
      });
    });
  });

  it("bisulfat: kg fără zecimale, sacul de 25 kg, preț pe pas", async () => {
    await withServices(async ({ products, units, as, unit, newProduct }) => {
      const manager = await as("manager");
      const kg = await unit("kg");
      await units.update(manager, kg.id, { decimals: 0 });
      const { productId } = await newProduct(manager);
      const updated = await products.update(manager, productId, {
        measureUnitId: kg.id,
        priceBasis: "step",
        saleStep: 250_000,
      });
      expect(updated).toMatchObject({ priceBasis: "step", saleStep: 250_000 });
    });
  });

  it("pasul se verifică față de zecimalele unității efective (nulă = «buc», 0 zecimale)", async () => {
    await withServices(async ({ products, units, as, unit, newProduct }) => {
      const manager = await as("manager");
      const { productId } = await newProduct(manager);
      // fără unitate: «buc», fără zecimale: 2 bucăți merge, 2,5 nu
      expect(await products.update(manager, productId, { saleStep: 20_000 })).toMatchObject({
        saleStep: 20_000,
      });
      const bad = await failure(() => products.update(manager, productId, { saleStep: 25_000 }));
      expect(bad).toMatchObject({ code: "VALIDATION_ERROR", paths: ["saleStep"] });
      expect(bad?.message).toMatch(/zecimale/);
      // pasul de 2,5 devine valid odată cu o unitate cu zecimale
      const ml = await unit("ml");
      await units.update(manager, ml.id, { decimals: 1 });
      expect(
        await products.update(manager, productId, { measureUnitId: ml.id, saleStep: 25_000 }),
      ).toMatchObject({ saleStep: 25_000, measureUnitId: ml.id });
      // iar 2,53 nu (ml are o zecimală aici)
      const bad2 = await failure(() => products.update(manager, productId, { saleStep: 25_300 }));
      expect(bad2?.paths).toEqual(["saleStep"]);
    });
  });

  it("câmpurile se validează: baza de preț, pasul pozitiv, minimul ≥ 1, cheie necunoscută", async () => {
    await withServices(async ({ products, as, newProduct }) => {
      const manager = await as("manager");
      const { productId } = await newProduct(manager);
      for (const patch of [
        { priceBasis: "kg" },
        { saleStep: 0 },
        { saleStep: -5 },
        { saleStep: 1.5 },
        { saleStep: 2_147_483_648 },
        { minSteps: 0 },
        { minSteps: 1.5 },
        { showStepPrice: "da" },
        { isSystem: true },
      ]) {
        expect(
          (await failure(() => products.update(manager, productId, patch)))?.code,
          JSON.stringify(patch),
        ).toBe("VALIDATION_ERROR");
      }
      // golirea (nul) = moștenește / o unitate
      expect(await products.update(manager, productId, { saleStep: 20_000 })).toMatchObject({
        saleStep: 20_000,
      });
      expect(await products.update(manager, productId, { saleStep: null })).toMatchObject({
        saleStep: null,
      });
    });
  });

  it("unitatea aleasă trebuie să existe și să fie activă; una dezactivată rămâne pe produsul care o are", async () => {
    await withServices(async ({ products, units, as, unit, newProduct }) => {
      const manager = await as("manager");
      const set = await unit("set");
      const { productId } = await newProduct(manager);
      expect(
        await failure(() => products.update(manager, productId, { measureUnitId: "inexistent" })),
      ).toMatchObject({ code: "VALIDATION_ERROR", paths: ["measureUnitId"] });
      await products.update(manager, productId, { measureUnitId: set.id });
      await units.update(manager, set.id, { isActive: false });
      // un alt produs nu o mai poate alege
      const other = await newProduct(manager);
      expect(
        await failure(() => products.update(manager, other.productId, { measureUnitId: set.id })),
      ).toMatchObject({ code: "VALIDATION_ERROR", paths: ["measureUnitId"] });
      // dar produsul care o are poate rămâne cu ea și își poate schimba alte câmpuri de vânzare
      expect(
        await products.update(manager, productId, { measureUnitId: set.id, minSteps: 2 }),
      ).toMatchObject({ measureUnitId: set.id, minSteps: 2 });
    });
  });

  it("schimbarea unității sau a pasului produsului se verifică pe variantele care îl moștenesc", async () => {
    await withServices(async ({ products, units, as, unit, newProduct }) => {
      const manager = await as("manager");
      const ml = await unit("ml");
      await units.update(manager, ml.id, { decimals: 1 });
      const { productId, skus, variantIds } = await newProduct(manager, {}, [{}, {}]);
      await products.update(manager, productId, { measureUnitId: ml.id, saleStep: 15_000 });
      // o variantă își ia propriul pas
      await products.updateVariant(manager, variantIds[1]!, { saleStep: 18_000 });
      // acum produsul nu mai poate trece pe «buc» (0 zecimale): varianta 1 moștenește 1,5 și varianta 2 are 1,8
      const bad = await failure(() => products.update(manager, productId, { measureUnitId: null }));
      expect(bad?.code).toBe("VALIDATION_ERROR");
      expect(bad?.message).toContain(skus[0]!);
      // pasul produsului nu poate fi 1,53 (ml are o zecimală)
      expect(
        (await failure(() => products.update(manager, productId, { saleStep: 15_300 })))?.paths,
      ).toEqual(["saleStep"]);
    });
  });
});

describe("varianta: pas propriu (abachi 1,5 / 1,8 / 2,1 / 2,6 ml) și moștenire", () => {
  it("pasul pe fiecare variantă, moștenit când e gol", async () => {
    await withServices(async ({ products, units, as, unit, newProduct }) => {
      const manager = await as("manager");
      const ml = await unit("ml");
      await units.update(manager, ml.id, { decimals: 1 });
      const { productId, variantIds } = await newProduct(manager, {}, [{}, {}, {}, {}]);
      await products.update(manager, productId, { measureUnitId: ml.id, saleStep: 15_000 });
      const steps = [15_000, 18_000, 21_000, 26_000];
      for (const [i, saleStep] of steps.entries()) {
        const v = await products.updateVariant(manager, variantIds[i]!, { saleStep });
        expect(v.saleStep).toBe(saleStep);
      }
      // golirea întoarce varianta la pasul produsului
      expect(
        (await products.updateVariant(manager, variantIds[3]!, { saleStep: null })).saleStep,
      ).toBeNull();
    });
  });

  it("pas cu prea multe zecimale pentru unitatea efectivă: refuzat pe câmpul pasului", async () => {
    await withServices(async ({ products, units, as, unit, newProduct }) => {
      const manager = await as("manager");
      const ml = await unit("ml");
      await units.update(manager, ml.id, { decimals: 1 });
      const { productId, variantIds } = await newProduct(manager);
      await products.update(manager, productId, { measureUnitId: ml.id });
      const bad = await failure(() =>
        products.updateVariant(manager, variantIds[0]!, { saleStep: 18_001 }),
      );
      expect(bad).toMatchObject({ code: "VALIDATION_ERROR", paths: ["saleStep"] });
      // aceeași variantă cu o unitate proprie fără zecimale: pasul 1,8 devine invalid
      const buc = await unit("buc");
      expect(
        (
          await failure(() =>
            products.updateVariant(manager, variantIds[0]!, {
              measureUnitId: buc.id,
              saleStep: 18_000,
            }),
          )
        )?.paths,
      ).toEqual(["saleStep"]);
    });
  });

  it("baza de preț, minimul și unitatea proprie pe variantă (nule = moștenesc)", async () => {
    await withServices(async ({ products, as, unit, newProduct }) => {
      const manager = await as("manager");
      const { variantIds } = await newProduct(manager);
      const kg = await unit("kg");
      const v = await products.updateVariant(manager, variantIds[0]!, {
        measureUnitId: kg.id,
        priceBasis: "step",
        minSteps: 2,
      });
      expect(v).toMatchObject({ measureUnitId: kg.id, priceBasis: "step", minSteps: 2 });
      expect(
        (await failure(() => products.updateVariant(manager, variantIds[0]!, { priceBasis: "x" })))
          ?.code,
      ).toBe("VALIDATION_ERROR");
      const cleared = await products.updateVariant(manager, variantIds[0]!, {
        measureUnitId: null,
        priceBasis: null,
        minSteps: null,
      });
      expect(cleared).toMatchObject({ measureUnitId: null, priceBasis: null, minSteps: null });
    });
  });

  it("la creare: produsul și variantele cu unitate, pas și minim sunt validate la fel", async () => {
    await withServices(async ({ units, products, as, unit, newProduct }) => {
      const manager = await as("manager");
      const mp = await unit("mp");
      await units.update(manager, mp.id, { decimals: 2 });
      const ok = await newProduct(
        manager,
        { measureUnitId: mp.id, saleStep: 412_500, minSteps: 1 },
        [{ saleStep: 412_500 }, { saleStep: 825_000 }],
      );
      const created = await products.getProduct(ok.productId);
      expect(created).toMatchObject({ measureUnitId: mp.id, saleStep: 412_500 });
      expect(
        await failure(() => newProduct(manager, { measureUnitId: mp.id, saleStep: 412_501 })),
      ).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(
        await failure(() => newProduct(manager, { measureUnitId: mp.id }, [{ saleStep: 1 }])),
      ).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(
        await failure(() => newProduct(manager, { measureUnitId: "inexistent" })),
      ).toMatchObject({ code: "VALIDATION_ERROR", paths: ["measureUnitId"] });
    });
  });
});

describe("conversia SmartBill: orice comandă valabilă se convertește exact", () => {
  it("liner: rola de 41,25 mp, 1 rolă SmartBill = 41,25 mp, acceptată", async () => {
    await withServices(async ({ products, units, as, unit, newProduct }) => {
      const manager = await as("manager");
      const mp = await unit("mp");
      await units.update(manager, mp.id, { decimals: 2 });
      const { productId, variantIds } = await newProduct(manager);
      await products.update(manager, productId, { measureUnitId: mp.id, saleStep: 412_500 });
      const v = await products.updateVariant(manager, variantIds[0]!, {
        smartbillMode: "ratio",
        smartbillRatio: 412_500,
        smartbillUnitName: "rolă",
      });
      expect(v).toMatchObject({
        smartbillMode: "ratio",
        smartbillRatio: 412_500,
        smartbillUnitName: "rolă",
      });
      // celelalte moduri
      expect(
        (
          await products.updateVariant(manager, variantIds[0]!, {
            smartbillMode: "steps",
            smartbillRatio: null,
          })
        ).smartbillMode,
      ).toBe("steps");
      expect(
        (await products.updateVariant(manager, variantIds[0]!, { smartbillMode: "same_unit" }))
          .smartbillMode,
      ).toBe("same_unit");
    });
  });

  it("raport care nu împarte pasul: produsul NU se salvează cu acea setare", async () => {
    await withServices(async ({ products, units, as, unit, newProduct }) => {
      const manager = await as("manager");
      const ml = await unit("ml");
      await units.update(manager, ml.id, { decimals: 1 });
      const { productId, variantIds } = await newProduct(manager);
      await products.update(manager, productId, { measureUnitId: ml.id, saleStep: 25_000 });
      const bad = await failure(() =>
        products.updateVariant(manager, variantIds[0]!, {
          smartbillMode: "ratio",
          smartbillRatio: 30_000,
        }),
      );
      expect(bad).toMatchObject({ code: "VALIDATION_ERROR", paths: ["smartbillRatio"] });
      expect(bad?.message).toMatch(/exact/);
      const after = await products.getForEdit(manager, productId);
      expect(after.variants[0]).toMatchObject({ smartbillMode: null, smartbillRatio: null });
    });
  });

  it("schimbarea pasului produsului care ar strica o conversie existentă a unei variante se refuză", async () => {
    await withServices(async ({ products, units, as, unit, newProduct }) => {
      const manager = await as("manager");
      const mp = await unit("mp");
      await units.update(manager, mp.id, { decimals: 2 });
      const { productId, variantIds, skus } = await newProduct(manager);
      await products.update(manager, productId, { measureUnitId: mp.id, saleStep: 412_500 });
      await products.updateVariant(manager, variantIds[0]!, {
        smartbillMode: "ratio",
        smartbillRatio: 412_500,
      });
      // 41,25 → 40,00: 40 / 41,25 rolă = 0,9696… nu e exact
      const bad = await failure(() => products.update(manager, productId, { saleStep: 400_000 }));
      expect(bad?.code).toBe("VALIDATION_ERROR");
      expect(bad?.paths).toEqual(["saleStep"]);
      expect(bad?.message).toContain(skus[0]!);
      // pasul de 2 role rămâne exact
      expect(await products.update(manager, productId, { saleStep: 825_000 })).toMatchObject({
        saleStep: 825_000,
      });
    });
  });

  it("raport fără modul «raport» sau modul fără raport: refuzat (una setată, una nulă)", async () => {
    await withServices(async ({ products, as, newProduct }) => {
      const manager = await as("manager");
      const { variantIds } = await newProduct(manager);
      const id = variantIds[0]!;
      expect(
        (await failure(() => products.updateVariant(manager, id, { smartbillRatio: 10_000 })))
          ?.paths,
      ).toEqual(["smartbillRatio"]);
      expect(
        (await failure(() => products.updateVariant(manager, id, { smartbillMode: "ratio" })))
          ?.paths,
      ).toEqual(["smartbillRatio"]);
      expect(
        (
          await failure(() =>
            products.updateVariant(manager, id, { smartbillMode: "ratio", smartbillRatio: 0 }),
          )
        )?.code,
      ).toBe("VALIDATION_ERROR");
      expect(
        (await failure(() => products.updateVariant(manager, id, { smartbillMode: "altceva" })))
          ?.code,
      ).toBe("VALIDATION_ERROR");
      expect(
        (await failure(() => products.updateVariant(manager, id, { smartbillUnitName: "  " })))
          ?.code,
      ).toBe("VALIDATION_ERROR");
    });
  });
});

describe("stoc existent și zecimalele unității", () => {
  it("nu poți trece un produs pe o unitate cu mai puține zecimale dacă stocul are mai multe", async () => {
    await withServices(async ({ tx, products, units, as, unit, newProduct }) => {
      const manager = await as("manager");
      const kg = await unit("kg");
      await units.update(manager, kg.id, { decimals: 1 });
      const { productId, variantIds } = await newProduct(manager);
      await products.update(manager, productId, { measureUnitId: kg.id });
      const warehouse = await tx.warehouse.findFirstOrThrow({ where: { isDefault: true } });
      await tx.inventoryItem.create({
        data: { variantId: variantIds[0]!, warehouseId: warehouse.id, physical: 25_000n },
      });
      const buc = await unit("buc");
      const bad = await failure(() =>
        products.update(manager, productId, { measureUnitId: buc.id }),
      );
      expect(bad).toMatchObject({ code: "VALIDATION_ERROR", paths: ["measureUnitId"] });
      expect(bad?.message).toMatch(/stoc/i);
      // o cantitate întreagă nu e problemă
      await tx.inventoryItem.updateMany({
        where: { variantId: variantIds[0]! },
        data: { physical: 30_000n },
      });
      expect(await products.update(manager, productId, { measureUnitId: buc.id })).toMatchObject({
        measureUnitId: buc.id,
      });
    });
  });

  it("zecimalele unității nu pot scădea sub ce folosesc pașii și stocul (pe baza reală)", async () => {
    await withServices(async ({ tx, units, as, unit, newProduct }) => {
      const manager = await as("manager");
      const mp = await unit("mp");
      await units.update(manager, mp.id, { decimals: 4 });
      const { variantIds } = await newProduct(manager, {
        measureUnitId: mp.id,
        saleStep: 20_300,
      });
      const warehouse = await tx.warehouse.findFirstOrThrow({ where: { isDefault: true } });
      await tx.inventoryItem.create({
        data: { variantId: variantIds[0]!, warehouseId: warehouse.id, physical: 25_050n },
      });
      // 1 zecimală: pasul 2,03 (2 zecimale) și stocul 2,505 (3 zecimale) nu mai încap
      const bad = await failure(() => units.update(manager, mp.id, { decimals: 1 }));
      expect(bad?.code).toBe("MEASURE_UNIT_DECIMALS_IN_USE");
      expect(bad?.message).toMatch(/1 pas de vânzare/);
      expect(bad?.message).toMatch(/1 rând de stoc/);
      // 3 zecimale: pasul încape, stocul 2,505 încape
      expect((await units.update(manager, mp.id, { decimals: 3 })).decimals).toBe(3);
      // 2 zecimale: pasul încape, stocul 2,505 nu
      const bad2 = await failure(() => units.update(manager, mp.id, { decimals: 2 }));
      expect(bad2?.message).not.toMatch(/pas de vânzare/);
      expect(bad2?.message).toMatch(/1 rând de stoc/);
    });
  });
});

describe("drepturi și audit", () => {
  it("câmpurile de vânzare cer products.write: Editorul (doar conținut) e refuzat, Managerul nu", async () => {
    await withServices(async ({ products, as, newProduct }) => {
      const manager = await as("manager");
      const editor = await as("editor");
      const { productId, variantIds } = await newProduct(manager);
      for (const patch of [
        { saleStep: 20_000 },
        { minSteps: 2 },
        { priceBasis: "step" },
        { showStepPrice: true },
        { measureUnitId: null },
      ]) {
        expect(
          (await failure(() => products.update(editor, productId, patch)))?.code,
          JSON.stringify(patch),
        ).toBe("AUTH_FORBIDDEN");
      }
      expect(
        (await failure(() => products.updateVariant(editor, variantIds[0]!, { saleStep: 20_000 })))
          ?.code,
      ).toBe("AUTH_FORBIDDEN");
      expect(
        await failure(() => products.update(manager, productId, { saleStep: 20_000 })),
      ).toBeNull();
    });
  });

  it("modificările de vânzare apar în audit, cu valoarea veche și cea nouă", async () => {
    await withServices(async ({ tx, products, as, newProduct }) => {
      const manager = await as("manager");
      const { productId, variantIds } = await newProduct(manager);
      await products.update(manager, productId, { saleStep: 20_000, minSteps: 3 });
      await products.updateVariant(manager, variantIds[0]!, { saleStep: 40_000 });
      const rows = await tx.auditLog.findMany({
        where: {
          entityId: { in: [productId, variantIds[0]!] },
          action: { in: ["product.update", "product.variant.update"] },
        },
        orderBy: { createdAt: "asc" },
      });
      expect(rows.some((r) => JSON.stringify(r.after).includes("20000"))).toBe(true);
      expect(rows.some((r) => JSON.stringify(r.after).includes("40000"))).toBe(true);
    });
  });
});
