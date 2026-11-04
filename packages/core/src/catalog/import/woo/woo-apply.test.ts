import { describe, expect, it } from "vitest";
import type { PermissionSubject } from "../../../rbac/can";
import type { PlannedRow } from "../import-plan";
import { WooApplier, type WooApplyDeps, type WooRun } from "./woo-apply";
import type { WooCreateOp, WooUpdateOp } from "./woo-types";

/**
 * Regula D2 (FAZA-5-plan): produsele create din importul WooCommerce sunt NEGESTIONATE, «în stoc», cu unitatea «buc»
 * (fără unitate), chiar dacă magazinul are gestiunea stocului pornită implicit. Aici se verifică EXACT ce primește
 * serviciul de produse: valorile trebuie să fie scrise explicit, nu moștenite din valori implicite.
 */

const subject = { userId: "u1", email: "test@exemplu.invalid" } as unknown as PermissionSubject;

const simple = (): WooCreateOp => ({
  kind: "woo-create",
  product: {
    title: "Pompă de test",
    subtitle: null,
    description: null,
    status: "draft",
    shippingClass: "standard",
    brandKey: null,
    categoryKeys: [],
  },
  variants: [
    {
      sku: "T-1",
      price: 10_000,
      salePrice: null,
      saleStartsAt: null,
      saleEndsAt: null,
      ean: null,
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      legacyId: null,
      selections: [],
    },
  ],
  options: [],
  attributeValues: [],
  relations: [],
  legacyId: null,
  childRows: [],
});

const variable = (): WooCreateOp => {
  const base = simple();
  const [first] = base.variants;
  if (!first) throw new Error("variantă lipsă");
  return {
    ...base,
    variants: [
      { ...first, sku: "T-V1", selections: [{ option: "Putere", value: "0,5 kW" }] },
      { ...first, sku: "T-V2", selections: [{ option: "Putere", value: "0,75 kW" }] },
    ],
    options: [{ name: "Putere", values: ["0,5 kW", "0,75 kW"] }],
  };
};

interface Captured {
  created: Record<string, unknown>[];
  createdVariable: Record<string, unknown>[];
  updated: { id: string; patch: Record<string, unknown> }[];
  variantUpdated: { id: string; patch: Record<string, unknown> }[];
}

function harness(): { applier: WooApplier; captured: Captured } {
  const captured: Captured = { created: [], createdVariable: [], updated: [], variantUpdated: [] };
  const made = (input: Record<string, unknown>) => ({
    product: { id: "p1" },
    variants: (input["variants"] as { sku: string }[]).map((v, i) => ({ id: `v${i}`, sku: v.sku })),
  });
  const deps = {
    products: {
      async create(_s: unknown, input: Record<string, unknown>) {
        captured.created.push(input);
        return made(input);
      },
      async createVariable(_s: unknown, input: Record<string, unknown>) {
        captured.createdVariable.push(input);
        return made(input);
      },
      async update(_s: unknown, id: string, patch: Record<string, unknown>) {
        captured.updated.push({ id, patch });
        return {};
      },
      async updateVariant(_s: unknown, id: string, patch: Record<string, unknown>) {
        captured.variantUpdated.push({ id, patch });
        return {};
      },
    },
    assignments: { async setCategories() {} },
    categories: { async create() {} },
    brands: { async create() {} },
    attributeDefs: { async create() {} },
    attributeValues: { async set() {} },
    relations: { async add() {} },
    store: {
      woo: {
        async setProductLegacyId() {
          return true;
        },
        async setVariantLegacyId() {
          return true;
        },
      },
    },
    logger: { error() {} },
  } as unknown as WooApplyDeps;
  return { applier: new WooApplier(deps), captured };
}

const run = (): WooRun => ({
  categoryId: new Map(),
  brandId: new Map(),
  attributeId: new Map(),
  failures: new Map(),
  pendingRelations: [],
  failedParents: new Set(),
  extraWarnings: new Map(),
});

const rowOf = (op: PlannedRow["op"]): PlannedRow => ({
  row: 2,
  sku: "T-1",
  outcome: "new",
  messages: [],
  changed: [],
  op,
});

describe("regula D2 la crearea produselor din WooCommerce", () => {
  it("produsul simplu se creează negestionat, «în stoc», fără unitate («buc»)", async () => {
    const { applier, captured } = harness();
    const result = await applier.applyRow(subject, rowOf(simple()), run());
    expect(result.outcome).toBe("new");
    expect(captured.created).toHaveLength(1);
    expect(captured.created[0]).toMatchObject({
      manageStock: false,
      stockStatus: "instock",
      measureUnitId: null,
    });
  });

  it("produsul variabil: aceleași valori pe produs", async () => {
    const { applier, captured } = harness();
    await applier.applyRow(subject, rowOf(variable()), run());
    expect(captured.createdVariable).toHaveLength(1);
    expect(captured.createdVariable[0]).toMatchObject({
      manageStock: false,
      stockStatus: "instock",
      measureUnitId: null,
    });
  });

  it("variantele nu primesc suprascrieri de stoc sau de unitate: moștenesc de la produs", async () => {
    const { applier, captured } = harness();
    await applier.applyRow(subject, rowOf(simple()), run());
    await applier.applyRow(subject, rowOf(variable()), run());
    const inputs = [...captured.created, ...captured.createdVariable];
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      for (const variant of input["variants"] as Record<string, unknown>[]) {
        for (const key of ["manageStock", "stockStatus", "measureUnitId", "saleStep", "minSteps"]) {
          expect(variant, `variantă cu ${key}`).not.toHaveProperty(key);
        }
      }
    }
  });

  it("actualizarea unui produs existent trimite doar câmpurile din plan, fără câmpuri de stoc", async () => {
    const { applier, captured } = harness();
    const op: WooUpdateOp = {
      kind: "woo-update",
      productId: "p9",
      variantId: "v9",
      productPatch: { title: "Titlu nou" },
      variantPatch: { price: 12_000 },
      legacyProduct: null,
      legacyVariant: null,
      attributeValues: [],
      relations: [],
    };
    await applier.applyRow(subject, rowOf(op), run());
    expect(captured.updated).toEqual([{ id: "p9", patch: { title: "Titlu nou" } }]);
    expect(captured.variantUpdated).toEqual([{ id: "v9", patch: { price: 12_000 } }]);
    const sent = JSON.stringify([...captured.updated, ...captured.variantUpdated]);
    expect(sent).not.toMatch(/manageStock|stockStatus|measureUnitId/);
  });

  it("un rând fără operație nu atinge nimic", async () => {
    const { applier, captured } = harness();
    await applier.applyRow(subject, rowOf(null), run());
    expect(captured.created).toHaveLength(0);
    expect(captured.updated).toHaveLength(0);
  });
});
