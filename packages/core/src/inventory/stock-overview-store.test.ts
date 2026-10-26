import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@ecom/db";
import { createPrismaStockOverviewStore } from "./stock-overview-store";

/**
 * `loadSources` și `getSource` citesc variantele cu un `select` imbricat. Prisma 7.10 cu adaptorul `pg` îl execută ca MAI
 * MULTE interogări separate (variantele, apoi produsele lor, apoi opțiunile), fără snapshot comun: dacă un produs e șters
 * definitiv între ele, relația OBLIGATORIE `product` (și `option`/`value` din etichetă) vine `null`, deși tipul spune
 * altceva. Rândul dispărut trebuie omis (ca un produs șters), nu să dea `TypeError` pentru toată cererea. `db` e fals:
 * întoarce exact ce ar întoarce Prisma după o ștergere între interogări.
 */

interface RowOptions {
  id: string;
  sku: string;
  product: { id: string; title: string } | null;
  optionValues?: { option: { position: number } | null; value: { value: string } | null }[];
}

/** Un rând așa cum îl întoarce `findMany` cu `sourceSelect` (câmpurile fără importanță pentru test, nule/implicite). */
function variantRow({ id, sku, product, optionValues = [] }: RowOptions) {
  return {
    id,
    sku,
    manageStock: null,
    stockStatus: null,
    saleStep: null,
    minSteps: null,
    measureUnit: null,
    optionValues,
    inventoryItems: [],
    product: product && {
      id: product.id,
      title: product.title,
      slug: `slug-${product.id}`,
      type: "physical",
      manageStock: false,
      stockStatus: "in_stock",
      allowBackorder: false,
      leadTimeDays: null,
      saleStep: null,
      minSteps: null,
      measureUnit: null,
      brand: null,
    },
  };
}

type Row = ReturnType<typeof variantRow>;

function storeWith(rows: Row[]) {
  const db = {
    productVariant: {
      findMany: async () => rows,
      findFirst: async () => rows[0] ?? null,
    },
  } as unknown as PrismaClient;
  return createPrismaStockOverviewStore(db);
}

const input = { warehouseId: "w1", limit: 10 };

describe("loadSources: rândurile dispărute între interogări", () => {
  it("un rând normal rămâne neschimbat: variantă, produs, etichetă din opțiuni în ordinea pozițiilor", async () => {
    const store = storeWith([
      variantRow({
        id: "v1",
        sku: "A-1",
        product: { id: "p1", title: "Pompă" },
        optionValues: [
          { option: { position: 2 }, value: { value: "L" } },
          { option: { position: 1 }, value: { value: "Roșu" } },
        ],
      }),
    ]);
    const [source, ...rest] = await store.loadSources(input);
    expect(rest).toEqual([]);
    expect(source).toMatchObject({
      variantId: "v1",
      sku: "A-1",
      variantLabel: "Roșu · L",
      productId: "p1",
      productTitle: "Pompă",
      productSlug: "slug-p1",
      productType: "physical",
      manageStock: false,
      item: null,
    });
  });

  it("un rând fără produs (șters între interogări) e omis; celelalte rămân, în ordine, fără TypeError", async () => {
    const store = storeWith([
      variantRow({ id: "v1", sku: "A-1", product: { id: "p1", title: "Primul" } }),
      variantRow({ id: "v2", sku: "B-1", product: null }),
      variantRow({ id: "v3", sku: "C-1", product: { id: "p3", title: "Al treilea" } }),
    ]);
    const sources = await store.loadSources(input);
    expect(sources.map((s) => s.variantId)).toEqual(["v1", "v3"]);
  });

  it("dacă toate rândurile au dispărut, rezultatul e gol (nu eroare)", async () => {
    const store = storeWith([variantRow({ id: "v1", sku: "A-1", product: null })]);
    await expect(store.loadSources(input)).resolves.toEqual([]);
  });

  it("o valoare de opțiune fără option sau value (ștearsă între interogări) nu strică rândul: eticheta vine din restul", async () => {
    const store = storeWith([
      variantRow({
        id: "v1",
        sku: "A-1",
        product: { id: "p1", title: "Pompă" },
        optionValues: [
          { option: null, value: { value: "pierdut" } },
          { option: { position: 1 }, value: null },
          { option: { position: 3 }, value: { value: "XL" } },
          { option: { position: 2 }, value: { value: "Albastru" } },
        ],
      }),
      variantRow({
        id: "v2",
        sku: "A-2",
        product: { id: "p1", title: "Pompă" },
        optionValues: [{ option: null, value: null }],
      }),
    ]);
    const sources = await store.loadSources(input);
    expect(sources.map((s) => [s.variantId, s.variantLabel])).toEqual([
      ["v1", "Albastru · XL"],
      ["v2", null],
    ]);
  });
});

describe("getSource: aceeași regulă", () => {
  it("un rând normal se întoarce; unul fără produs dă null (ca o variantă inexistentă)", async () => {
    const normal = storeWith([
      variantRow({ id: "v1", sku: "A-1", product: { id: "p1", title: "P" } }),
    ]);
    await expect(normal.getSource("v1", "w1")).resolves.toMatchObject({
      variantId: "v1",
      sku: "A-1",
    });
    const gone = storeWith([variantRow({ id: "v1", sku: "A-1", product: null })]);
    await expect(gone.getSource("v1", "w1")).resolves.toBeNull();
  });
});
