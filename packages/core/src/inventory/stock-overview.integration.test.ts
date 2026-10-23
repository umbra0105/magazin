import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import {
  ForbiddenError,
  UnauthenticatedError,
  formatQuantity,
  parseQuantity,
  parseSignedDelta,
  saleStepToInt,
  type Quantity,
} from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import { runBaseSeed } from "../seed/base-seed";
import { MemoryAudit } from "../test-utils/memory-audit";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  addStockProduct,
  createStockContext,
  type ProductSpec,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { StockMaintenance } from "./stock-maintenance";
import { createPrismaStockOverviewStore } from "./stock-overview-store";
import {
  StockOverviewService,
  parseStockOverviewQuery,
  type StockOverviewServiceSettings,
} from "./stock-overview-service";
import { StockService } from "./stock-service";

/**
 * Faza 5, punctul 8: citirea pentru ecranul de stoc, pe baza reală (tranzacție anulată): valorile EFECTIVE (varianta peste
 * produs), filtrele, paginarea, suma pe produs, istoricul mișcărilor și drepturile pe roluri reale. Nu presupune seed:
 * depozitul implicit îl creează `runBaseSeed`, restul testul.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const q = (text: string): Quantity => parseQuantity(text);
const T0 = new Date("2026-10-22T10:00:00Z");
const settings: StockOverviewServiceSettings = {
  lowStockSteps: 2,
  defaultLeadTimeDays: 14,
  snapshotStaleHours: 24,
  timeZone: "Europe/Bucharest",
};

function roleSubject(roleKey: string): PermissionSubject {
  const role = DEFAULT_ROLES.find((r) => r.key === roleKey);
  if (!role) throw new Error(roleKey);
  return {
    userId: `u-${roleKey}`,
    email: `${roleKey}@magazin.test`,
    roles: [roleKey],
    permissions: new Set<string>(role.permissions),
  };
}

interface Harness {
  tx: TestTx;
  ctx: StockContext;
  service: StockOverviewService;
  stock: StockService;
  manager: PermissionSubject;
  warehouseId: string;
  /** Un produs cu variantele date; întoarce id-ul produsului și variantele */
  add: (
    title: string,
    spec?: ProductSpec,
  ) => Promise<{ productId: string; variants: Array<{ id: string; sku: string }> }>;
}

async function withStock<T>(
  fn: (h: Harness) => Promise<T>,
  options: { maxRows?: number } = {},
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const ctx = await createStockContext(tx, { useDefaultWarehouse: true });
    const stock = new StockService({ db: tx, now: () => T0 });
    const maintenance = new StockMaintenance({
      db: tx,
      audit: new AuditService(new MemoryAudit()),
      now: () => T0,
    });
    const service = new StockOverviewService({
      store: createPrismaStockOverviewStore(tx),
      maintenance,
      readSettings: async () => settings,
      ...(options.maxRows !== undefined && { maxRows: options.maxRows }),
    });
    const h: Harness = {
      tx,
      ctx,
      service,
      stock,
      manager: roleSubject("manager"),
      warehouseId: ctx.warehouseId,
      add: async (title, spec = {}) => {
        const created = await addStockProduct(tx, ctx, spec);
        await tx.product.update({ where: { id: created.productId }, data: { title } });
        return created;
      },
    };
    return fn(h);
  });
}

const show = (value: Quantity | bigint | null | undefined): string | null =>
  value === null || value === undefined ? null : formatQuantity(value as Quantity);

describe("drepturi: inventory.read pentru citire", () => {
  it("Owner, Admin, Manager și Depozit pot; Editor, Suport și Contabil nu; anonimul nu", async () => {
    await withStock(async (h) => {
      await h.add("Liner", { step: "41,25", variants: [{ physical: "100" }] });
      for (const role of ["owner", "admin", "manager", "warehouse"]) {
        const page = await h.service.list(roleSubject(role), {});
        expect(page.rows.length, role).toBeGreaterThan(0);
      }
      for (const role of ["editor", "support", "accountant"]) {
        await expect(h.service.list(roleSubject(role), {}), role).rejects.toBeInstanceOf(
          ForbiddenError,
        );
        await expect(h.service.movements(roleSubject(role), "x", {}), role).rejects.toBeInstanceOf(
          ForbiddenError,
        );
        await expect(h.service.variant(roleSubject(role), "x"), role).rejects.toBeInstanceOf(
          ForbiddenError,
        );
      }
      await expect(h.service.list(null, {})).rejects.toBeInstanceOf(UnauthenticatedError);
    });
  });
});

describe("lista: valorile efective și cele 6 produse", () => {
  it("cantitățile, pașii și restul nevandabil ajung din bază", async () => {
    await withStock(async (h) => {
      await h.add("Liner placare", { step: "41,25", variants: [{ physical: "100" }] });
      await h.add("Bisulfat de sodiu", { step: "25", variants: [{ physical: "80" }] });
      await h.add("Mozaic placare", { step: "2,03", variants: [{ physical: "10" }] });
      const page = await h.service.list(h.manager, { search: "placare" });
      const byTitle = Object.fromEntries(page.rows.map((r) => [r.productTitle, r]));
      expect(show(byTitle["Liner placare"]?.available)).toBe("100");
      expect(byTitle["Liner placare"]?.availableSteps?.toString()).toBe("2");
      expect(show(byTitle["Liner placare"]?.remainder)).toBe("17,5");
      expect(byTitle["Mozaic placare"]?.availableSteps?.toString()).toBe("4");
      expect(show(byTitle["Mozaic placare"]?.remainder)).toBe("1,88");
      expect(byTitle["Bisulfat de sodiu"]).toBeUndefined();
    });
  });

  it("varianta suprascrie produsul: bifa de gestiune, starea, unitatea, pasul și minimul", async () => {
    await withStock(async (h) => {
      const product = await h.add("Abachi", {
        step: "1,5",
        variants: [{ physical: "10" }, { physical: "10" }, { physical: "10" }],
      });
      const [a, b, c] = product.variants;
      const mlDecimals0 = await h.tx.measureUnit.create({
        data: { code: `u_${h.ctx.tag}z`, name: "Fără zecimale", symbol: "zz", decimals: 0 },
      });
      await h.tx.productVariant.update({
        where: { id: a!.id },
        data: { saleStep: saleStepToInt(q("1,8")), minSteps: 2 },
      });
      await h.tx.productVariant.update({
        where: { id: b!.id },
        data: { manageStock: false, stockStatus: "outofstock" },
      });
      await h.tx.productVariant.update({
        where: { id: c!.id },
        data: { measureUnitId: mlDecimals0.id },
      });
      const page = await h.service.list(h.manager, { search: "Abachi" });
      const rows = new Map(page.rows.map((r) => [r.variantId, r]));
      expect(show(rows.get(a!.id)?.step)).toBe("1,8");
      expect(rows.get(a!.id)?.minSteps).toBe(2);
      expect(rows.get(b!.id)).toMatchObject({
        kind: "unmanaged",
        stockStatus: "outofstock",
        state: "unavailable",
      });
      expect(rows.get(b!.id)?.physical).toBeNull();
      expect(rows.get(c!.id)?.unit).toMatchObject({ symbol: "zz", decimals: 0 });
      expect(rows.get(c!.id)?.unit.code).toBe(`u_${h.ctx.tag}z`);
    });
  });

  it("o variantă fără unitate (produs fără unitate) înseamnă «buc», cu 0 zecimale, fără să existe vreun rând «buc»", async () => {
    await withStock(async (h) => {
      await h.add("Pompă", { variants: [{ physical: "3" }] });
      const row = (await h.service.list(h.manager, { search: "Pompă" })).rows[0];
      expect(row?.unit).toEqual({ code: "buc", symbol: "buc", decimals: 0 });
      expect(show(row?.step)).toBe("1");
    });
  });

  it("termenul «La comandă»: produs, apoi brand, apoi setarea globală", async () => {
    await withStock(async (h) => {
      const brand = await h.tx.brand.create({
        data: { name: `Brand ${h.ctx.tag}`, slug: `brand-${h.ctx.tag}`, defaultLeadTimeDays: 7 },
      });
      const own = await h.add("Cu termen propriu", {
        allowBackorder: true,
        variants: [{ physical: "0" }],
      });
      const viaBrand = await h.add("Termen din brand", {
        allowBackorder: true,
        variants: [{ physical: "0" }],
      });
      await h.add("Termen global", {
        allowBackorder: true,
        variants: [{ physical: "0" }],
      });
      await h.tx.product.update({
        where: { id: own.productId },
        data: { leadTimeDays: 3, brandId: brand.id },
      });
      await h.tx.product.update({ where: { id: viaBrand.productId }, data: { brandId: brand.id } });
      const page = await h.service.list(h.manager, { search: "termen" });
      const days = Object.fromEntries(page.rows.map((r) => [r.productTitle, r.leadTimeDays]));
      expect(days).toEqual({ "Cu termen propriu": 3, "Termen din brand": 7, "Termen global": 14 });
      expect(page.rows.every((r) => r.state === "on_order")).toBe(true);
    });
  });

  it("eticheta variantei vine din valorile opțiunilor, în ordinea opțiunilor", async () => {
    await withStock(async (h) => {
      const product = await h.add("Abachi cu opțiuni", { variants: [{ physical: "5" }] });
      const variantId = product.variants[0]!.id;
      const length = await h.tx.productOption.create({
        data: { productId: product.productId, name: "Lungime", position: 0 },
      });
      const wood = await h.tx.productOption.create({
        data: { productId: product.productId, name: "Esență", position: 1 },
      });
      const l18 = await h.tx.optionValue.create({ data: { optionId: length.id, value: "1,8 ml" } });
      const oak = await h.tx.optionValue.create({ data: { optionId: wood.id, value: "Stejar" } });
      for (const [option, value] of [
        [wood, oak],
        [length, l18],
      ] as const) {
        await h.tx.variantOptionValue.create({
          data: {
            variantId,
            productId: product.productId,
            optionId: option.id,
            optionValueId: value.id,
          },
        });
      }
      const row = (await h.service.list(h.manager, { search: "opțiuni" })).rows[0];
      expect(row?.variantLabel).toBe("1,8 ml · Stejar");
    });
  });

  it("produsele din coșul de gunoi nu apar", async () => {
    await withStock(async (h) => {
      const gone = await h.add("Dispărut din coș", { variants: [{ physical: "5" }] });
      await h.add("Rămas", { variants: [{ physical: "5" }] });
      await h.tx.product.update({ where: { id: gone.productId }, data: { deletedAt: T0 } });
      const titles = (await h.service.list(h.manager, { search: "ămas" })).rows.map(
        (r) => r.productTitle,
      );
      expect(titles).toEqual(["Rămas"]);
      expect((await h.service.list(h.manager, { search: "Dispărut" })).rows).toHaveLength(0);
    });
  });
});

describe("filtre, căutare, paginare", () => {
  it("căutarea ia titlul sau SKU-ul, fără diferență de majuscule", async () => {
    await withStock(async (h) => {
      const p = await h.add("Furtun de dozare", { variants: [{ physical: "5" }] });
      await h.add("Altceva", { variants: [{ physical: "5" }] });
      expect(
        (await h.service.list(h.manager, { search: "FURTUN" })).rows.map((r) => r.productTitle),
      ).toEqual(["Furtun de dozare"]);
      expect(
        (await h.service.list(h.manager, { search: p.variants[0]!.sku.toLowerCase() })).rows.map(
          (r) => r.productTitle,
        ),
      ).toEqual(["Furtun de dozare"]);
      expect((await h.service.list(h.manager, { search: "nu există niciunde" })).rows).toHaveLength(
        0,
      );
    });
  });

  it("filtrul de tip: gestionat / negestionat / digital", async () => {
    await withStock(async (h) => {
      await h.add("T gestionat", { variants: [{ physical: "5" }] });
      await h.add("T negestionat", { manageStock: false, variants: [{ physical: null }] });
      await h.add("T digital", { type: "digital", variants: [{ physical: null }] });
      const kinds = async (kind: "managed" | "unmanaged" | "digital") =>
        (await h.service.list(h.manager, { search: "T ", kind })).rows.map((r) => r.productTitle);
      expect(await kinds("managed")).toEqual(["T gestionat"]);
      expect(await kinds("unmanaged")).toEqual(["T negestionat"]);
      expect(await kinds("digital")).toEqual(["T digital"]);
    });
  });

  it("filtrul de stare și «doar stoc mic»", async () => {
    await withStock(async (h) => {
      await h.add("S mult", { variants: [{ physical: "50" }] });
      await h.add("S puțin", { variants: [{ physical: "2" }] });
      await h.add("S zero", { variants: [{ physical: "0" }] });
      const titles = async (query: object) =>
        (await h.service.list(h.manager, { search: "S ", ...query })).rows
          .map((r) => r.productTitle)
          .sort();
      expect(await titles({ state: "in_stock" })).toEqual(["S mult"]);
      expect(await titles({ state: "limited" })).toEqual(["S puțin"]);
      expect(await titles({ state: "unavailable" })).toEqual(["S zero"]);
      expect(await titles({ lowStockOnly: true })).toEqual(["S puțin", "S zero"]);
    });
  });

  it("paginare: total, pagini, ordinea alfabetică, ultima pagină parțială; pagina în afara intervalului se aduce la ultima", async () => {
    await withStock(async (h) => {
      for (const letter of ["a", "b", "c", "d", "e"])
        await h.add(`Pag ${letter}`, { variants: [{ physical: "5" }] });
      const first = await h.service.list(h.manager, { search: "Pag ", page: 1, pageSize: 2 });
      expect(first).toMatchObject({ total: 5, page: 1, pageSize: 2, pageCount: 3 });
      expect(first.rows.map((r) => r.productTitle)).toEqual(["Pag a", "Pag b"]);
      const last = await h.service.list(h.manager, { search: "Pag ", page: 3, pageSize: 2 });
      expect(last.rows.map((r) => r.productTitle)).toEqual(["Pag e"]);
      const beyond = await h.service.list(h.manager, { search: "Pag ", page: 99, pageSize: 2 });
      expect(beyond.page).toBe(3);
      expect(beyond.rows.map((r) => r.productTitle)).toEqual(["Pag e"]);
    });
  });

  it("peste plafon (maxRows) rezultatul e marcat «truncated», fără să cadă", async () => {
    await withStock(
      async (h) => {
        for (const letter of ["a", "b", "c", "d"])
          await h.add(`Plafon ${letter}`, { variants: [{ physical: "5" }] });
        const page = await h.service.list(h.manager, { search: "Plafon " });
        expect(page.truncated).toBe(true);
        expect(page.total).toBe(3);
        const small = await h.service.list(h.manager, { search: "Plafon a" });
        expect(small.truncated).toBe(false);
      },
      { maxRows: 3 },
    );
  });
});

describe("suma pe produs (D9) pe pagină", () => {
  it("totalul se calculează pe TOATE variantele produsului, chiar dacă pagina are doar o parte din ele", async () => {
    await withStock(async (h) => {
      await h.add("Cu variante", {
        variants: [{ physical: "10" }, { physical: "5" }, { physical: "1" }],
      });
      const first = await h.service.list(h.manager, {
        search: "Cu variante",
        page: 1,
        pageSize: 2,
      });
      expect(first.groups).toHaveLength(1);
      expect(first.groups[0]?.rows).toHaveLength(2);
      expect(show(first.groups[0]?.total?.physical)).toBe("16");
      const second = await h.service.list(h.manager, {
        search: "Cu variante",
        page: 2,
        pageSize: 2,
      });
      expect(second.groups[0]?.rows).toHaveLength(1);
      expect(show(second.groups[0]?.total?.physical)).toBe("16");
    });
  });

  it("unități diferite pe variante → fără total", async () => {
    await withStock(async (h) => {
      const product = await h.add("Mixt", { variants: [{ physical: "10" }, { physical: "5" }] });
      const other = await h.tx.measureUnit.create({
        data: { code: `u_${h.ctx.tag}m`, name: "Alta", symbol: "al", decimals: 2 },
      });
      await h.tx.productVariant.update({
        where: { id: product.variants[1]!.id },
        data: { measureUnitId: other.id },
      });
      const group = (await h.service.list(h.manager, { search: "Mixt" })).groups[0];
      expect(group?.total).toBeNull();
      expect(group?.totalProblem).toBe("different_units");
    });
  });
});

describe("o variantă și banner-ul «stoc verificat la»", () => {
  it("variant() întoarce rândul, depozitul și prospețimea; o variantă necunoscută → null", async () => {
    await withStock(async (h) => {
      const product = await h.add("O variantă", { step: "41,25", variants: [{ physical: "100" }] });
      await h.tx.stockSnapshot.create({
        data: {
          warehouseId: h.warehouseId,
          takenAt: new Date(T0.getTime() - 3 * 3_600_000),
          source: "import",
        },
      });
      const detail = await h.service.variant(h.manager, product.variants[0]!.id);
      expect(detail?.row.availableSteps?.toString()).toBe("2");
      expect(detail?.warehouse.id).toBe(h.warehouseId);
      expect(detail?.freshness).toMatchObject({ status: "fresh" });
      expect(await h.service.variant(h.manager, "nu-exista")).toBeNull();
    });
  });

  it("lista aduce prospețimea depozitului: fără poză → «never»; poză veche → «stale»", async () => {
    await withStock(async (h) => {
      await h.add("Banner", { variants: [{ physical: "5" }] });
      expect((await h.service.list(h.manager, {})).freshness).toMatchObject({ status: "never" });
      await h.tx.stockSnapshot.create({
        data: {
          warehouseId: h.warehouseId,
          takenAt: new Date(T0.getTime() - 30 * 3_600_000),
          source: "import",
        },
      });
      expect((await h.service.list(h.manager, {})).freshness).toMatchObject({ status: "stale" });
    });
  });

  it("un depozit inexistent → eroare clară", async () => {
    await withStock(async (h) => {
      await expect(h.service.list(h.manager, { warehouseId: "nu-exista" })).rejects.toMatchObject({
        code: "STOCK_NO_WAREHOUSE",
      });
    });
  });
});

describe("istoricul mișcărilor", () => {
  it("cele mai noi primele (după ora efectivă), cu motiv, text, autor; paginat; doar depozitul și varianta cerute", async () => {
    await withStock(async (h) => {
      const product = await h.add("Istoric", {
        variants: [{ physical: "10" }, { physical: "10" }],
      });
      const [v, other] = product.variants;
      const adjust = (
        variantId: string,
        delta: string,
        hoursAgo: number,
        reason: "sale_in_store" | "receipt",
        note: string,
      ) =>
        h.stock.adjustPhysical({
          variantId,
          warehouseId: h.warehouseId,
          delta: parseSignedDelta(delta),
          reason,
          note,
          effectiveAt: new Date(T0.getTime() - hoursAgo * 3_600_000),
          actor: { id: "u1", label: "depozit@magazin.test" },
        });
      await adjust(v!.id, "-1", 5, "sale_in_store", "prima");
      await adjust(v!.id, "+4", 3, "receipt", "a doua");
      await adjust(v!.id, "-2", 1, "sale_in_store", "a treia");
      await adjust(other!.id, "-5", 2, "sale_in_store", "altă variantă");

      const page = await h.service.movements(h.manager, v!.id, {});
      expect(page.total).toBe(3);
      expect(page.rows.map((r) => r.note)).toEqual(["a treia", "a doua", "prima"]);
      expect(page.rows[0]).toMatchObject({
        kind: "adjustment",
        reason: "sale_in_store",
        actorLabel: "depozit@magazin.test",
      });
      expect(show(page.rows[0]?.deltaPhysical)).toBe("-2");
      expect(show(page.rows[0]?.physicalAfter)).toBe("11");

      const small = await h.service.movements(h.manager, v!.id, { pageSize: 2, page: 2 });
      expect(small.rows.map((r) => r.note)).toEqual(["prima"]);
      expect(small).toMatchObject({ page: 2, pageCount: 2, total: 3 });
    });
  });

  it("include și mișcările pozei, fără motiv sau autor", async () => {
    await withStock(async (h) => {
      const product = await h.add("Cu poză", { variants: [{ physical: null }] });
      const snapshot = await h.tx.stockSnapshot.create({
        data: { warehouseId: h.warehouseId, takenAt: T0, source: "import" },
      });
      await h.stock.applySnapshot({
        variantId: product.variants[0]!.id,
        warehouseId: h.warehouseId,
        snapshotId: snapshot.id,
        quantity: q("7"),
        takenAt: T0,
        safetyWindowMinutes: 30,
      });
      const page = await h.service.movements(h.manager, product.variants[0]!.id, {});
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toMatchObject({ kind: "snapshot", reason: null, actorLabel: null });
      expect(show(page.rows[0]?.physicalAfter)).toBe("7");
    });
  });

  it("variantă fără mișcări → listă goală, nu eroare", async () => {
    await withStock(async (h) => {
      const product = await h.add("Fără istoric", { variants: [{ physical: "5" }] });
      expect(await h.service.movements(h.manager, product.variants[0]!.id, {})).toMatchObject({
        total: 0,
        rows: [],
      });
    });
  });
});

describe("interogarea din adresă (parametri de URL)", () => {
  it("valorile valide se păstrează; cele invalide se ignoră, fără eroare", () => {
    expect(parseStockOverviewQuery({})).toEqual({});
    expect(
      parseStockOverviewQuery({
        q: "  liner ",
        tip: "managed",
        stare: "limited",
        mic: "1",
        pagina: "3",
      }),
    ).toEqual({ search: "liner", kind: "managed", state: "limited", lowStockOnly: true, page: 3 });
    expect(
      parseStockOverviewQuery({ tip: "altceva", stare: "x", mic: "nu", pagina: "-2" }),
    ).toEqual({});
    expect(parseStockOverviewQuery({ pagina: "2.5" })).toEqual({});
    expect(parseStockOverviewQuery({ q: ["a", "b"] })).toEqual({ search: "a" });
    expect(parseStockOverviewQuery({ q: "x".repeat(300) }).search).toHaveLength(100);
  });
});
