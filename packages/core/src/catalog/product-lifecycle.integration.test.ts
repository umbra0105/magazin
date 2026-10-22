import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@ecom/db";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { ProductLifecycleService } from "./product-lifecycle";
import { createPrismaProductLifecycleStore } from "./product-lifecycle-store";
import { createPrismaProductListStore, parseProductListQuery } from "./product-list";
import { createPrismaProductStore } from "./product-store";

/**
 * Ciclul de viață al produsului pe baza reală: duplicarea (ce se copiază și, mai ales, ce NU),
 * arhivarea și coșul de gunoi cu tot-sau-nimic, ștergerea definitivă cu hotspot-urile rămase fără
 * produs și plasa de siguranță a cheilor străine RESTRICT.
 */

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

async function withService<T>(
  fn: (c: {
    tx: TestTx;
    service: ProductLifecycleService;
    deleteFiles: ReturnType<typeof vi.fn>;
    as: (role: string) => ReturnType<PermissionService["loadSubject"]>;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const deleteFiles = vi.fn<(keys: readonly string[]) => Promise<void>>(async () => {});
    const service = new ProductLifecycleService({
      store: createPrismaProductLifecycleStore(tx),
      products: createPrismaProductStore(tx),
      audit: new AuditService(createPrismaAuditStore(tx)),
      deleteFiles,
      logger: createLogger({ destination: { write() {} } }),
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `lc-${role}-${n++}`, name: role, email: `lc-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      return new PermissionService(tx).loadSubject(user.id);
    };
    return fn({ tx, service, deleteFiles, as });
  });
}

const media = (tx: TestTx) =>
  tx.media.create({
    data: {
      mime: "image/png",
      sizeBytes: 5,
      checksum: uid(),
      originalName: "poza.png",
      storageKey: `public/media/${uid()}/original.png`,
      status: "ready",
      width: 100,
      height: 100,
    },
  });

const selection = (ids: string[]) => ({ ids, confirm: true, expectedCount: ids.length });

/** Un produs complet, cu tot ce poate avea, ca duplicarea să fie probată pe cazul cel mai greu. */
async function fullProduct(tx: TestTx) {
  const tag = uid();
  const brand = await tx.brand.create({ data: { slug: `lc-brand-${tag}`, name: `Brand ${tag}` } });
  const category = await tx.category.create({
    data: { slug: `lc-cat-${tag}`, name: `Categorie ${tag}`, path: `lc-cat-${tag}`, depth: 0 },
  });
  const image = await media(tx);
  const productImage = await media(tx);
  const mpUnit = await tx.measureUnit.upsert({
    where: { code: "mp" },
    create: { code: "mp", name: "Metru pătrat", symbol: "mp", decimals: 4, isSystem: true },
    update: {},
  });
  const part = await tx.product.create({ data: { slug: `lc-part-${tag}`, title: "Piesă" } });
  const other = await tx.product.create({ data: { slug: `lc-other-${tag}`, title: "Alt produs" } });

  const source = await tx.product.create({
    data: {
      slug: `lc-src-${tag}`,
      title: `Pompă ${tag}`,
      subtitle: "Subtitlu",
      description: "Descriere lungă",
      status: "active",
      brandId: brand.id,
      shippingClass: "pallet",
      requiresInstallation: true,
      energyClass: "A++",
      eprelUrl: "https://eprel.ec.europa.eu/qr/123456",
      gpsrManufacturerName: "Producător SRL",
      gpsrManufacturerContact: "contact@producator.test",
      safetyWarnings: "Atenție",
      seoTitle: "SEO titlu",
      legacyId: `woo-${tag}`,
      legacyUrl: `https://vechi.test/${tag}`,
      publishedAt: new Date("2026-01-01T00:00:00Z"),
      manageStock: true,
      stockStatus: "instock",
      // configurarea de vânzare (D11): se copiază, ca o copie a mozaicului să rămână mozaic
      measureUnitId: mpUnit.id,
      priceBasis: "step",
      saleStep: 20_300,
      minSteps: 2,
      showStepPrice: true,
    },
  });
  await tx.productCategory.create({
    data: { productId: source.id, categoryId: category.id, isPrimary: true },
  });

  const option = await tx.productOption.create({
    data: { productId: source.id, name: "Mărime", position: 0 },
  });
  const small = await tx.optionValue.create({
    data: { optionId: option.id, value: "S", position: 0 },
  });
  const large = await tx.optionValue.create({
    data: { optionId: option.id, value: "L", position: 1 },
  });

  const at = new Date("2026-10-01T00:00:00Z");
  const variants = [];
  for (const [index, value] of [small, large].entries()) {
    const variant = await tx.productVariant.create({
      data: {
        productId: source.id,
        sku: `LC-${tag}-${index}`,
        ean: `590000000000${index}`,
        legacyId: `woo-var-${tag}-${index}`,
        price: 100_00 + index * 10_00,
        salePrice: index === 0 ? 90_00 : null,
        saleStartsAt: index === 0 ? new Date("2026-09-01T00:00:00Z") : null,
        saleEndsAt: index === 0 ? new Date("2027-09-01T00:00:00Z") : null,
        costPrice: 55_00,
        costPriceDate: at,
        weightGrams: 4200,
        lengthMm: 500,
        warrantyMonths: 24,
        manufacturerPartNumber: `MPN-${tag}-${index}`,
        manufacturerName: "Producător",
        position: index,
        isDefault: index === 0,
        saleStep: index === 0 ? 412_500 : null,
        minSteps: index === 0 ? 1 : null,
        smartbillMode: index === 0 ? "ratio" : null,
        smartbillRatio: index === 0 ? 412_500 : null,
        smartbillUnitName: index === 0 ? "rolă" : null,
      },
    });
    await tx.variantOptionValue.create({
      data: {
        variantId: variant.id,
        productId: source.id,
        optionId: option.id,
        optionValueId: value.id,
      },
    });
    await tx.costPriceHistory.create({
      data: { variantId: variant.id, costPrice: 55_00, effectiveDate: at, source: "manual" },
    });
    await tx.priceHistory.create({
      data: { variantId: variant.id, price: variant.price, effectiveFrom: at },
    });
    variants.push(variant);
  }

  await tx.productMedia.create({
    data: { productId: source.id, mediaId: productImage.id, position: 0 },
  });
  await tx.productMedia.create({
    data: {
      productId: source.id,
      mediaId: image.id,
      variantId: variants[1]?.id ?? null,
      position: 1,
    },
  });

  const numberAttr = await tx.attribute.create({
    data: {
      code: `lc_debit_${tag.replace(/-/g, "")}`,
      name: "Debit",
      type: "number",
      unit: "m³/h",
    },
  });
  const textAttr = await tx.attribute.create({
    data: { code: `lc_nota_${tag.replace(/-/g, "")}`, name: "Notă", type: "text" },
  });
  await tx.attributeValue.create({
    data: { productId: source.id, attributeId: numberAttr.id, numberValue: "12.3456" },
  });
  await tx.attributeValue.create({
    data: { productId: source.id, attributeId: textAttr.id, textValue: "ceva" },
  });

  await tx.productRelation.create({
    data: { productId: source.id, relatedProductId: part.id, type: "spare_part", position: 0 },
  });
  // relație care duce SPRE sursă: nu trebuie să apară și pe copie
  await tx.productRelation.create({
    data: { productId: other.id, relatedProductId: source.id, type: "accessory", position: 0 },
  });

  await tx.productDocument.create({
    data: {
      productId: source.id,
      type: "manual",
      title: "Manual",
      storageKey: `private/product-documents/${uid()}.pdf`,
      originalName: "manual.pdf",
      mime: "application/pdf",
      sizeBytes: 10,
    },
  });
  const collection = await tx.collection.create({
    data: { slug: `lc-col-${tag}`, name: "Colecție" },
  });
  await tx.collectionProduct.create({
    data: { collectionId: collection.id, productId: source.id },
  });

  const diagram = await tx.partsDiagram.create({
    data: { title: `Fișa ${tag}`, mediaId: image.id },
  });
  await tx.partsDiagramProduct.create({ data: { diagramId: diagram.id, productId: source.id } });
  const channel = await tx.salesChannel.create({
    data: { code: `lc_${tag.replace(/-/g, "")}`, name: "Canal" },
  });
  await tx.channelListing.create({
    data: {
      channelId: channel.id,
      productId: source.id,
      variantId: variants[0]?.id as string,
      status: "draft",
    },
  });

  return {
    tag,
    source,
    variants,
    option,
    brand,
    category,
    image,
    productImage,
    part,
    other,
    diagram,
    channel,
  };
}

describe("duplicare pe baza reală", () => {
  it("copiază conținutul și structura, dar niciodată costul, EAN-ul, stocul, identificatorii vechi și documentele", async () => {
    await withService(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const f = await fullProduct(tx);
      const mediaBefore = await tx.media.count();

      const result = await service.duplicate(manager, f.source.id);

      // produsul: ciornă, titlu și adresă noi, fără urme din magazinul vechi
      const copy = await tx.product.findUniqueOrThrow({ where: { id: result.product.id } });
      expect(copy).toMatchObject({
        status: "draft",
        title: `${f.source.title} (copie)`,
        publishedAt: null,
        deletedAt: null,
        legacyId: null,
        legacyUrl: null,
        energyClass: null,
        eprelUrl: null,
        // se copiază: conținutul, structura și datele GPSR
        subtitle: "Subtitlu",
        description: "Descriere lungă",
        brandId: f.brand.id,
        shippingClass: "pallet",
        requiresInstallation: true,
        gpsrManufacturerName: "Producător SRL",
        safetyWarnings: "Atenție",
        seoTitle: "SEO titlu",
        // și configurarea de vânzare
        measureUnitId: f.source.measureUnitId,
        priceBasis: "step",
        saleStep: 20_300,
        minSteps: 2,
        showStepPrice: true,
      });
      expect(copy.slug).not.toBe(f.source.slug);
      expect(copy.slug).toMatch(/copie/);

      // variantele: același preț și aceleași promoții, coduri noi, fără EAN, cost, identificatori
      const copied = await tx.productVariant.findMany({
        where: { productId: copy.id },
        orderBy: { position: "asc" },
      });
      expect(copied).toHaveLength(2);
      // configurarea de vânzare a variantelor (pas, minim, conversie SmartBill) se copiază
      expect(copied[0]).toMatchObject({
        saleStep: 412_500,
        minSteps: 1,
        smartbillMode: "ratio",
        smartbillRatio: 412_500,
        smartbillUnitName: "rolă",
      });
      expect(copied[1]).toMatchObject({
        saleStep: null,
        smartbillMode: null,
        smartbillRatio: null,
      });
      for (const [index, variant] of copied.entries()) {
        const original = f.variants[index];
        expect(variant.id).not.toBe(original?.id);
        expect(variant.sku).toBe(`${original?.sku}-COPIE`);
        expect(variant).toMatchObject({
          ean: null,
          legacyId: null,
          costPrice: null,
          costPriceDate: null,
          manufacturerPartNumber: null,
          price: original?.price,
          salePrice: original?.salePrice,
          saleStartsAt: original?.saleStartsAt,
          weightGrams: 4200,
          warrantyMonths: 24,
          manufacturerName: "Producător",
          isDefault: index === 0,
        });
      }
      // istoricul de cost nu se copiază; sursa îl păstrează neatins
      expect(
        await tx.costPriceHistory.count({ where: { variantId: { in: copied.map((v) => v.id) } } }),
      ).toBe(0);
      expect(
        await tx.costPriceHistory.count({
          where: { variantId: { in: f.variants.map((v) => v.id) } },
        }),
      ).toBe(2);
      const sourceAfter = await tx.productVariant.findMany({
        where: { productId: f.source.id },
        orderBy: { position: "asc" },
      });
      expect(sourceAfter.map((v) => v.costPrice)).toEqual([55_00, 55_00]);

      // istoricul de prețuri (Omnibus) pornește de la zero: câte un rând, cu prețul efectiv de acum
      const history = await tx.priceHistory.findMany({
        where: { variantId: { in: copied.map((v) => v.id) } },
      });
      expect(history).toHaveLength(2);
      expect(history.every((h) => h.effectiveFrom.getTime() > Date.now() - 60_000)).toBe(true);

      // opțiunile: copiate cu id-uri noi, iar variantele legate de valorile COPIEI
      const options = await tx.productOption.findMany({
        where: { productId: copy.id },
        include: { values: { orderBy: { position: "asc" } } },
      });
      expect(options).toHaveLength(1);
      expect(options[0]?.id).not.toBe(f.option.id);
      expect(options[0]?.values.map((v) => v.value)).toEqual(["S", "L"]);
      const links = await tx.variantOptionValue.findMany({
        where: { productId: copy.id },
        include: { value: true },
      });
      expect(links).toHaveLength(2);
      expect(links.every((l) => l.optionId === options[0]?.id)).toBe(true);

      // imaginile: aceleași fișiere din bibliotecă; cea de variantă merge pe varianta COPIEI
      const copiedMedia = await tx.productMedia.findMany({
        where: { productId: copy.id },
        orderBy: { position: "asc" },
      });
      expect(copiedMedia.map((m) => m.mediaId)).toEqual([f.productImage.id, f.image.id]);
      expect(copiedMedia[1]?.variantId).toBe(copied[1]?.id);
      expect(await tx.media.count()).toBe(mediaBefore);

      // atributele cu valoarea exactă, categoriile cu cea principală, relațiile ieșite
      const attributes = await tx.attributeValue.findMany({ where: { productId: copy.id } });
      expect(attributes).toHaveLength(2);
      expect(attributes.find((a) => a.numberValue !== null)?.numberValue?.toFixed(4)).toBe(
        "12.3456",
      );
      expect(await tx.productCategory.findMany({ where: { productId: copy.id } })).toEqual([
        expect.objectContaining({ categoryId: f.category.id, isPrimary: true }),
      ]);
      expect(await tx.productRelation.findMany({ where: { productId: copy.id } })).toEqual([
        expect.objectContaining({ relatedProductId: f.part.id, type: "spare_part" }),
      ]);
      expect(await tx.productRelation.count({ where: { relatedProductId: copy.id } })).toBe(0);

      // ce NU se copiază, și raportul o spune
      expect(await tx.productDocument.count({ where: { productId: copy.id } })).toBe(0);
      expect(await tx.collectionProduct.count({ where: { productId: copy.id } })).toBe(0);
      expect(await tx.partsDiagramProduct.count({ where: { productId: copy.id } })).toBe(0);
      expect(await tx.channelListing.count({ where: { productId: copy.id } })).toBe(0);
      expect(result.skipped).toEqual({
        documents: 1,
        collections: 1,
        diagrams: 1,
        channelListings: 1,
      });

      // sursa rămâne neatinsă
      expect(await tx.productDocument.count({ where: { productId: f.source.id } })).toBe(1);
      expect(await tx.product.findUniqueOrThrow({ where: { id: f.source.id } })).toMatchObject({
        status: "active",
        energyClass: "A++",
        legacyId: f.source.legacyId,
      });

      // un singur eveniment de audit, fără valori de cost
      const events = await tx.auditLog.findMany({
        where: { action: "product.duplicate", entityId: copy.id },
      });
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0]).toLowerCase()).not.toContain("cost");
    });
  });

  it("adresa nouă e unică și față de produsele ȘTERSE; codurile față de toate variantele", async () => {
    await withService(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const tag = uid();
      const source = await tx.product.create({
        data: { slug: `lc-s-${tag}`, title: `Sursă ${tag}` },
      });
      await tx.productVariant.create({
        data: { productId: source.id, sku: `S-${tag}`, price: 100, isDefault: true },
      });
      // un produs șters deține deja adresa așteptată, iar altul deține codul așteptat
      await tx.product.create({
        data: {
          // adresa pe care ar primi-o prima copie: titlul „Sursă <tag> (copie)” devine «sursa-<tag>-copie»
          slug: `sursa-${tag.toLowerCase()}-copie`,
          title: "Șters",
          deletedAt: new Date(),
        },
      });
      const first = await service.duplicate(manager, source.id);
      const second = await service.duplicate(manager, source.id);

      // «-copie» e luat de produsul șters, deci prima copie primește -2, iar a doua -3
      expect(first.product.slug).toBe(`sursa-${tag.toLowerCase()}-copie-2`);
      expect(second.product.slug).toBe(`sursa-${tag.toLowerCase()}-copie-3`);
      expect(first.variants[0]?.sku).toBe(`S-${tag}-COPIE`);
      expect(second.variants[0]?.sku).toBe(`S-${tag}-COPIE-2`);
    });
  });

  it("Editorul nu poate duplica; produsul din coșul de gunoi nu se duplică", async () => {
    await withService(async ({ tx, service, as }) => {
      const editor = await as("editor");
      const manager = await as("manager");
      const p = await tx.product.create({ data: { slug: `lc-${uid()}`, title: "P" } });
      await expect(service.duplicate(editor, p.id)).rejects.toMatchObject({
        code: "AUTH_FORBIDDEN",
      });
      await tx.product.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
      await expect(service.duplicate(manager, p.id)).rejects.toMatchObject({
        code: "CATALOG_PRODUCT_DELETED",
      });
    });
  });
});

describe("arhivare și coș de gunoi pe baza reală", () => {
  it("arhivează și restaurează o selecție; coșul de gunoi are propria vedere în listă", async () => {
    await withService(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const tag = uid();
      const a = await tx.product.create({
        data: { slug: `lc-a-${tag}`, title: `Alfa ${tag}`, status: "active" },
      });
      const b = await tx.product.create({
        data: { slug: `lc-b-${tag}`, title: `Beta ${tag}`, status: "draft" },
      });

      await service.archive(manager, selection([a.id, b.id]));
      expect(
        (await tx.product.findMany({ where: { id: { in: [a.id, b.id] } } })).map((p) => p.status),
      ).toEqual(["archived", "archived"]);

      await service.unarchive(manager, selection([a.id, b.id]));
      expect(
        (await tx.product.findMany({ where: { id: { in: [a.id, b.id] } } })).map((p) => p.status),
      ).toEqual(["draft", "draft"]);

      await service.softDelete(manager, selection([a.id]));
      const listStore = createPrismaProductListStore(tx);
      const activeView = await listStore.list(parseProductListQuery({ q: tag }));
      expect(activeView.rows.map((r) => r.id)).toEqual([b.id]);
      const deletedView = await listStore.list(parseProductListQuery({ q: tag, view: "deleted" }));
      expect(deletedView.rows.map((r) => r.id)).toEqual([a.id]);
      expect(deletedView.rows[0]?.deletedAt).toBeInstanceOf(Date);

      await service.restore(manager, selection([a.id]));
      expect((await listStore.list(parseProductListQuery({ q: tag, view: "deleted" }))).total).toBe(
        0,
      );

      // baza de test poate avea evenimente comise de alte rulări (jurnalul nu se șterge): se filtrează
      // pe id-urile acestui test, care apar în `after.ids` al evenimentului agregat
      const events = await tx.auditLog.findMany({
        where: {
          action: {
            in: ["product.archive", "product.unarchive", "product.delete", "product.restore"],
          },
          OR: [{ entityId: a.id }, { after: { path: ["ids"], array_contains: [a.id] } }],
        },
        orderBy: { createdAt: "asc" },
      });
      expect(events.map((e) => e.action)).toEqual([
        "product.archive",
        "product.unarchive",
        "product.delete",
        "product.restore",
      ]);
    });
  });

  it("tot sau nimic pe baza reală: un produs neeligibil în selecție nu lasă nicio modificare", async () => {
    await withService(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const tag = uid();
      const ok = await tx.product.create({
        data: { slug: `lc-ok-${tag}`, title: "Ok", status: "active" },
      });
      const already = await tx.product.create({
        data: { slug: `lc-ar-${tag}`, title: "Deja", status: "archived" },
      });
      await expect(service.archive(manager, selection([ok.id, already.id]))).rejects.toMatchObject({
        code: "CATALOG_LIFECYCLE_INVALID",
      });
      expect((await tx.product.findUniqueOrThrow({ where: { id: ok.id } })).status).toBe("active");
      expect(
        await tx.auditLog.count({
          where: { action: "product.archive", after: { path: ["ids"], array_contains: [ok.id] } },
        }),
      ).toBe(0);
    });
  });
});

describe("ștergere definitivă pe baza reală", () => {
  it("șterge produsul și ce atârnă de el; hotspot-ul rămâne în fișă, fără produs; documentele pleacă din storage", async () => {
    await withService(async ({ tx, service, deleteFiles, as }) => {
      const manager = await as("manager");
      const f = await fullProduct(tx);
      await tx.partsDiagramHotspot.create({
        data: { diagramId: f.diagram.id, number: 1, productId: f.source.id, xBp: 100, yBp: 200 },
      });
      const documents = await tx.productDocument.findMany({ where: { productId: f.source.id } });

      // înainte să fie în coșul de gunoi, ștergerea definitivă e refuzată
      await expect(
        service.purge(manager, { id: f.source.id, confirm: true, confirmSlug: f.source.slug }),
      ).rejects.toMatchObject({ code: "CATALOG_PRODUCT_NOT_DELETED" });

      await service.softDelete(manager, selection([f.source.id]));

      // rezumatul spune ce se întâmplă cu fișele
      const impact = await service.describePurge(manager, f.source.id);
      expect(impact.deleted).toBe(true);
      expect(impact.counts).toMatchObject({ variants: 2, documents: 1, media: 2, attributes: 2 });
      expect(impact.diagrams).toEqual([{ id: f.diagram.id, title: f.diagram.title }]);
      expect(impact.hotspots).toEqual([
        { diagramId: f.diagram.id, diagramTitle: f.diagram.title, number: 1 },
      ]);

      // adresa greșită nu șterge nimic
      await expect(
        service.purge(manager, { id: f.source.id, confirm: true, confirmSlug: "altceva" }),
      ).rejects.toMatchObject({ code: "CATALOG_PURGE_CONFIRM_MISMATCH" });
      expect(await tx.product.count({ where: { id: f.source.id } })).toBe(1);

      await service.purge(manager, {
        id: f.source.id,
        confirm: true,
        confirmSlug: f.source.slug.toUpperCase(),
      });

      expect(await tx.product.count({ where: { id: f.source.id } })).toBe(0);
      expect(await tx.productVariant.count({ where: { productId: f.source.id } })).toBe(0);
      expect(await tx.productDocument.count({ where: { productId: f.source.id } })).toBe(0);
      expect(await tx.partsDiagramProduct.count({ where: { productId: f.source.id } })).toBe(0);
      // fișa și hotspot-ul rămân; hotspot-ul n-are produs
      expect(await tx.partsDiagram.count({ where: { id: f.diagram.id } })).toBe(1);
      expect(await tx.partsDiagramHotspot.findMany({ where: { diagramId: f.diagram.id } })).toEqual(
        [expect.objectContaining({ number: 1, productId: null, xBp: 100, yBp: 200 })],
      );
      // fișierele din bibliotecă nu se ating (le folosesc și alții)
      expect(await tx.media.count({ where: { id: f.image.id } })).toBe(1);
      // fișierele documentelor se șterg din storage
      expect(deleteFiles).toHaveBeenCalledWith(documents.map((d) => d.storageKey));

      const events = await tx.auditLog.findMany({
        where: { action: "product.purge", entityId: f.source.id },
      });
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0]).toLowerCase()).not.toContain("cost");
    });
  });

  it("refuză produsul cu oferte active pe un canal; ofertele în ciornă nu blochează", async () => {
    await withService(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const f = await fullProduct(tx);
      await service.softDelete(manager, selection([f.source.id]));
      const listing = await tx.channelListing.findFirstOrThrow({
        where: { productId: f.source.id },
      });

      await tx.channelListing.update({ where: { id: listing.id }, data: { status: "active" } });
      await expect(
        service.purge(manager, { id: f.source.id, confirm: true, confirmSlug: f.source.slug }),
      ).rejects.toMatchObject({ code: "CATALOG_PRODUCT_REFERENCED" });
      expect(await tx.product.count({ where: { id: f.source.id } })).toBe(1);

      await tx.channelListing.update({ where: { id: listing.id }, data: { status: "draft" } });
      await expect(
        service.purge(manager, { id: f.source.id, confirm: true, confirmSlug: f.source.slug }),
      ).resolves.toMatchObject({ id: f.source.id });
    });
  });

  it("plasa de siguranță: o cheie străină RESTRICT spre produs (comenzile, când există) refuză ștergerea", async () => {
    await withService(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const p = await tx.product.create({
        data: { slug: `lc-ref-${uid()}`, title: "Referit", deletedAt: new Date() },
      });
      // tabel (anulat odată cu tranzacția de test) care imită o comandă: referință RESTRICT spre produs
      await tx.$executeRawUnsafe(
        `CREATE TABLE lc_fake_order_line (id serial PRIMARY KEY, "productId" text NOT NULL REFERENCES product(id) ON DELETE RESTRICT)`,
      );
      await tx.$executeRawUnsafe(`INSERT INTO lc_fake_order_line ("productId") VALUES ('${p.id}')`);
      await tx.$executeRawUnsafe(`SAVEPOINT lc_purge`);

      await expect(
        service.purge(manager, { id: p.id, confirm: true, confirmSlug: p.slug }),
      ).rejects.toMatchObject({ code: "CATALOG_PRODUCT_REFERENCED" });

      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT lc_purge`);
      // produsul e neatins și rămâne în coșul de gunoi
      expect(await tx.product.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({
        deletedAt: expect.any(Date),
      });
    });
  });
});
