import { describe, expect, it } from "vitest";
import { createProductMediaUsageProvider } from "./media-usage";
import { createPrismaPartsDiagramStore } from "./parts-diagram-service";
import { createPrismaProductLifecycleStore } from "./product-lifecycle-store";
import { createPrismaProductStore } from "./product-store";

/**
 * Blocul C, C-34. Prisma citește relațiile imbricate ale unui rând în interogări separate: dacă entitatea referită a fost
 * ștearsă între citiri (golirea coșului, ștergerea unei fișe sau a unei opțiuni), rândul vine cu relația `null`, deși tipurile
 * spun «nenul». Măsurat pe Postgres real, în paralel cu ștergerea produsului: citirea unei fișe explodate a dat TypeError în
 * 25 din 300 de încercări, iar lista de folosiri a unui fișier media în 269 din 300. Fiecare loc omite acum rândul fără
 * referință (care oricum dispare odată cu ea), în loc să arunce. Aici baza e simulată cu exact acel rezultat (determinist).
 */

const cast = <T>(value: unknown) => value as T;

const productRow = (id: string) => ({
  id,
  title: `Produs ${id}`,
  status: "active",
  deletedAt: null,
  variants: [{ sku: `SKU-${id}` }],
});

describe("fișe explodate: produs asociat șters în timpul citirii", () => {
  it("get() omite produsele fără rând și hotspot-urile cu produs lipsă, fără excepție", async () => {
    const store = createPrismaPartsDiagramStore(
      cast({
        partsDiagram: {
          findUnique: async () => ({
            id: "d1",
            title: "Fișa 1",
            media: { id: "m1" },
            hotspots: [
              { id: "h1", number: 1, xBp: 1, yBp: 1, label: "a", product: productRow("p1") },
              { id: "h2", number: 2, xBp: 2, yBp: 2, label: "b", product: null },
            ],
            products: [{ product: productRow("p2") }, { product: null }],
          }),
        },
      }),
    );
    const diagram = await store.get("d1");
    expect(diagram?.products.map((p) => p.id)).toEqual(["p2"]);
    expect(diagram?.hotspots.map((h) => h.product?.id ?? null)).toEqual(["p1", null]);
  });
});

describe("folosirile unui fișier media: produs șters în timpul citirii", () => {
  it("findUsages() omite rândurile al căror produs a dispărut", async () => {
    const provider = createProductMediaUsageProvider(
      cast({
        productMedia: {
          findMany: async () => [
            {
              mediaId: "m1",
              product: { id: "p1", title: "Pompa", deletedAt: null },
              variant: null,
            },
            { mediaId: "m1", product: null, variant: null },
          ],
        },
      }),
    );
    const usages = await provider.findUsages(["m1"]);
    expect(usages.get("m1")?.map((u) => u.label)).toEqual(["Produs: Pompa"]);
  });
});

describe("impactul ștergerii definitive: fișă ștearsă în timpul citirii", () => {
  it("purgeImpact() omite fișele și hotspot-urile fără fișă", async () => {
    const store = createPrismaProductLifecycleStore(
      cast({
        product: {
          findUnique: async () => ({
            id: "p1",
            slug: "p-1",
            title: "Produs",
            deletedAt: new Date(),
            _count: {
              variants: 1,
              media: 0,
              documents: 0,
              categories: 0,
              attributes: 0,
              relations: 0,
              relatedTo: 0,
              collections: 0,
              channelListings: 0,
            },
            channelListings: [],
            partsDiagrams: [{ diagram: { id: "d1", title: "Fișa 1" } }, { diagram: null }],
            hotspots: [
              { number: 1, diagram: { id: "d1", title: "Fișa 1" } },
              { number: 2, diagram: null },
            ],
          }),
        },
      }),
    );
    const impact = await store.purgeImpact("p1");
    expect(impact?.diagrams).toEqual([{ id: "d1", title: "Fișa 1" }]);
    expect(impact?.hotspots).toEqual([{ diagramId: "d1", diagramTitle: "Fișa 1", number: 1 }]);
  });
});

describe("opțiunile variantelor: opțiune sau valoare ștearsă în timpul citirii", () => {
  const variantRow = (optionValues: unknown[]) => ({
    id: "v1",
    productId: "p1",
    sku: "S1",
    optionValues,
  });
  const ok = { option: { name: "Culoare", position: 0 }, value: { value: "Roșu" } };

  it("listVariantCombinationKeys() ignoră perechile cu opțiunea sau valoarea lipsă", async () => {
    const store = createPrismaProductStore(
      cast({
        productVariant: {
          findMany: async () => [
            variantRow([
              ok,
              { option: null, value: { value: "X" } },
              { option: { name: "M", position: 1 }, value: null },
            ]),
          ],
        },
      }),
    );
    const keys = await store.listVariantCombinationKeys("p1");
    expect(keys).toHaveLength(1);
  });

  it("listVariantsDetailed() ignoră perechile cu opțiunea sau valoarea lipsă", async () => {
    const store = createPrismaProductStore(
      cast({
        productVariant: {
          findMany: async () => [
            {
              id: "v1",
              productId: "p1",
              sku: "S1",
              position: 0,
              isDefault: true,
              optionValues: [ok, { option: null, value: { value: "X" } }],
            },
          ],
        },
      }),
    );
    const variants = await store.listVariantsDetailed("p1");
    expect(variants[0]?.selections).toEqual([{ option: "Culoare", value: "Roșu" }]);
  });
});
