import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { ENERGY_CLASSES, PRODUCT_DOCUMENT_MIME_TYPES, PRODUCT_DOCUMENT_TYPES } from "./constants";
import { createMediaUsageRegistry } from "./media-usage";

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

const newProduct = (tx: TestTx, over: Record<string, unknown> = {}) =>
  tx.product.create({ data: { slug: `p-${uid()}`, title: "Produs", ...over } });

const newMedia = (tx: TestTx) => {
  const id = uid();
  return tx.media.create({
    data: {
      mime: "image/png",
      sizeBytes: 10,
      checksum: id,
      originalName: `${id}.png`,
      storageKey: `public/media/${id}/original`,
    },
  });
};

const docData = (productId: string, over: Record<string, unknown> = {}) => ({
  productId,
  type: "manual",
  title: "Manual de utilizare",
  storageKey: `private/documents/${uid()}.pdf`,
  originalName: "manual.pdf",
  mime: "application/pdf",
  sizeBytes: 1024,
  ...over,
});

/** Rulează într-o tranzacție anulată și cere ca baza să respingă scrierea (opțional: după nume). */
async function violation(fn: (tx: TestTx) => Promise<unknown>, expected?: string): Promise<void> {
  const error = await inRolledBackTransaction(db, async (tx) => {
    try {
      await fn(tx);
      return null;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  });
  expect(error, "baza trebuia să respingă scrierea").not.toBeNull();
  if (expected) expect(JSON.stringify(error) + String(error?.message)).toContain(expected);
}

describe("clasa energetică și EPREL", () => {
  it("acceptă toate clasele din constantă, refuză restul; EPREL doar https", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      for (const energyClass of ENERGY_CLASSES) await newProduct(tx, { energyClass });
      const p = await newProduct(tx, {
        energyClass: "A+++",
        eprelUrl: "https://eprel.ec.europa.eu/screen/product/heatpumps/123456",
      });
      expect(p.energyClass).toBe("A+++");
      expect((await newProduct(tx)).energyClass).toBeNull();
    });
    await violation((tx) => newProduct(tx, { energyClass: "H" }), "product_energyClass_check");
    await violation((tx) => newProduct(tx, { energyClass: "a" }), "product_energyClass_check");
    await violation(
      (tx) => newProduct(tx, { eprelUrl: "http://eprel.ec.europa.eu/x" }),
      "product_eprelUrl_check",
    );
    await violation(
      (tx) => newProduct(tx, { eprelUrl: "javascript:alert(1)" }),
      "product_eprelUrl_check",
    );
  });
});

describe("GPSR și câmpuri pregătitoare", () => {
  it("câmpurile GPSR sunt opționale și se păstrează; backorder implicit oprit", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const bare = await newProduct(tx);
      expect(bare).toMatchObject({
        gpsrManufacturerName: null,
        gpsrResponsibleName: null,
        safetyWarnings: null,
        expectedRestockDate: null,
        allowBackorder: false,
      });
      const full = await newProduct(tx, {
        gpsrManufacturerName: "Producător SRL",
        gpsrManufacturerContact: "Str. Exemplu 1, București; contact@producator.example",
        gpsrResponsibleName: "Reprezentant UE GmbH",
        gpsrResponsibleContact: "Musterstr. 2, Berlin",
        safetyWarnings: "A nu se folosi fără împământare.",
        expectedRestockDate: new Date("2026-12-01"),
        allowBackorder: true,
      });
      expect(full.gpsrResponsibleName).toBe("Reprezentant UE GmbH");
      expect(full.allowBackorder).toBe(true);
    });
  });

  it("variantă cu codul producătorului: nu sunt unice (aceeași piesă la mai mulți furnizori)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const p = await newProduct(tx);
      const code = `SP-1400-${uid()}`;
      for (const sku of ["A", "B"]) {
        await tx.productVariant.create({
          data: {
            productId: p.id,
            sku: `${sku}-${uid()}`,
            price: 100,
            manufacturerPartNumber: code,
            manufacturerName: "Producător",
          },
        });
      }
      const found = await tx.productVariant.findMany({
        where: { manufacturerPartNumber: { equals: code.toLowerCase(), mode: "insensitive" } },
      });
      expect(found).toHaveLength(2);
    });
  });
});

describe("documente de produs", () => {
  it("toate tipurile și tipurile de fișier din constante sunt acceptate; implicit ro, vizibil în tab", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const p = await newProduct(tx);
      for (const type of PRODUCT_DOCUMENT_TYPES) {
        await tx.productDocument.create({ data: docData(p.id, { type }) });
      }
      for (const mime of PRODUCT_DOCUMENT_MIME_TYPES) {
        await tx.productDocument.create({ data: docData(p.id, { mime }) });
      }
      const d = await tx.productDocument.create({ data: docData(p.id) });
      expect(d).toMatchObject({ language: "ro", showInTab: true, position: 0 });
    });
  });

  it("refuză tip necunoscut, fișier executabil, dimensiune nulă, cod de limbă greșit, cheie dublă", async () => {
    await violation(async (tx) => {
      const p = await newProduct(tx);
      await tx.productDocument.create({ data: docData(p.id, { type: "brochure" }) });
    }, "product_document_type_check");
    await violation(async (tx) => {
      const p = await newProduct(tx);
      await tx.productDocument.create({
        data: docData(p.id, { mime: "application/x-msdownload" }),
      });
    }, "product_document_mime_check");
    await violation(async (tx) => {
      const p = await newProduct(tx);
      await tx.productDocument.create({ data: docData(p.id, { sizeBytes: 0 }) });
    }, "product_document_sizeBytes_check");
    await violation(async (tx) => {
      const p = await newProduct(tx);
      await tx.productDocument.create({ data: docData(p.id, { language: "romanian" }) });
    }, "product_document_language_check");
    await violation(async (tx) => {
      const p = await newProduct(tx);
      const data = docData(p.id, { storageKey: `private/documents/${uid()}-dup.pdf` });
      await tx.productDocument.create({ data });
      await tx.productDocument.create({ data: { ...data, title: "Alt titlu" } });
    });
  });

  it("documentele dispar odată cu produsul", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const p = await newProduct(tx);
      await tx.productDocument.create({ data: docData(p.id) });
      await tx.product.delete({ where: { id: p.id } });
      expect(await tx.productDocument.count({ where: { productId: p.id } })).toBe(0);
    });
  });
});

describe("fișa explodată", () => {
  it("o fișă se atașează la mai multe produse; rândurile numerotate cu poziție opțională", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const media = await newMedia(tx);
      const diagram = await tx.partsDiagram.create({
        data: { title: "Pompă seria XYZ — vedere explodată", mediaId: media.id },
      });
      const models = [await newProduct(tx), await newProduct(tx), await newProduct(tx)];
      for (const m of models) {
        await tx.partsDiagramProduct.create({ data: { diagramId: diagram.id, productId: m.id } });
      }
      const part = await newProduct(tx, { title: "Garnitură" });
      await tx.partsDiagramHotspot.create({
        data: { diagramId: diagram.id, number: 1, productId: part.id },
      });
      await tx.partsDiagramHotspot.create({
        data: { diagramId: diagram.id, number: 2, productId: part.id, xBp: 2500, yBp: 7550 },
      });
      expect(await tx.partsDiagramProduct.count({ where: { diagramId: diagram.id } })).toBe(3);
      expect(await tx.partsDiagramHotspot.count({ where: { diagramId: diagram.id } })).toBe(2);
      // fișa se șterge cu rândurile și atașările ei
      await tx.partsDiagram.delete({ where: { id: diagram.id } });
      expect(await tx.partsDiagramHotspot.count({ where: { diagramId: diagram.id } })).toBe(0);
      expect(await tx.product.count({ where: { id: { in: models.map((m) => m.id) } } })).toBe(3);
    });
  });

  it("numărul e pozitiv și unic pe fișă; poziția are ambele coordonate, în 0–10000", async () => {
    const setup = async (tx: TestTx) => {
      const media = await newMedia(tx);
      const diagram = await tx.partsDiagram.create({ data: { title: "F", mediaId: media.id } });
      const part = await newProduct(tx);
      return { diagram, part };
    };
    await violation(async (tx) => {
      const { diagram, part } = await setup(tx);
      await tx.partsDiagramHotspot.create({
        data: { diagramId: diagram.id, number: 0, productId: part.id },
      });
    }, "parts_diagram_hotspot_number_check");
    await violation(async (tx) => {
      const { diagram, part } = await setup(tx);
      const data = { diagramId: diagram.id, number: 3, productId: part.id };
      await tx.partsDiagramHotspot.create({ data });
      await tx.partsDiagramHotspot.create({ data });
    });
    await violation(async (tx) => {
      const { diagram, part } = await setup(tx);
      await tx.partsDiagramHotspot.create({
        data: { diagramId: diagram.id, number: 1, productId: part.id, xBp: 500 },
      });
    }, "parts_diagram_hotspot_position_check");
    await violation(async (tx) => {
      const { diagram, part } = await setup(tx);
      await tx.partsDiagramHotspot.create({
        data: { diagramId: diagram.id, number: 1, productId: part.id, xBp: 10001, yBp: 0 },
      });
    }, "parts_diagram_hotspot_position_check");
  });

  it("imaginea fișei e protejată: providerul o raportează, iar baza refuză ștergerea fișierului", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const media = await newMedia(tx);
      const diagram = await tx.partsDiagram.create({
        data: { title: "Fișa pompei", mediaId: media.id },
      });
      const usages = await createMediaUsageRegistry(tx).findUsages([media.id]);
      expect(usages.get(media.id)).toEqual([
        { kind: "parts_diagram", label: "Fișă explodată: Fișa pompei" },
      ]);
      expect(diagram.id).toBeTruthy();
    });
    await violation(async (tx) => {
      const media = await newMedia(tx);
      await tx.partsDiagram.create({ data: { title: "F", mediaId: media.id } });
      await tx.media.delete({ where: { id: media.id } });
    }, "parts_diagram_mediaId_fkey");
  });
});
