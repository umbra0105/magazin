import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { MediaInUseError, MediaLibraryService } from "../media/library";
import { createPrismaLibraryStore } from "../media/library-store";
import { createPrismaProcessingStore } from "../media/processing-store";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  createMediaUsageRegistry,
  createProductMediaUsageProvider,
  MEDIA_REFERENCING_MODELS,
  PRODUCT_MEDIA_USAGE_PROVIDER,
} from "./media-usage";

const db = getDb();
let base: string;
let storage: LocalStorageDriver;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "ecom-media-usage-"));
  storage = new LocalStorageDriver({
    rootDir: join(base, "s"),
    appUrl: "https://magazin.test",
    signingKey: deriveSigningKey(Buffer.alloc(32, 7).toString("base64")),
  });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

async function newMedia(tx: TestTx): Promise<{ id: string; key: string }> {
  const key = `public/media/usage-${uid()}/original.jpg`;
  await storage.put(key, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]), { contentType: "image/jpeg" });
  const row = await tx.media.create({
    data: {
      mime: "image/jpeg",
      sizeBytes: 5,
      checksum: uid(),
      originalName: "poza.jpg",
      storageKey: key,
      status: "ready",
    },
  });
  return { id: row.id, key };
}

async function newProduct(tx: TestTx, title: string) {
  return tx.product.create({ data: { slug: `p-${uid()}`, title } });
}

async function withLibrary<T>(
  fn: (c: {
    tx: TestTx;
    service: MediaLibraryService;
    owner: Awaited<ReturnType<PermissionService["loadSubject"]>> & object;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const service = new MediaLibraryService({
      store: createPrismaLibraryStore(tx),
      storage,
      audit: new AuditService(createPrismaAuditStore(tx)),
      // registrul REAL al nucleului, nu unul gol: exact ce primește aplicația
      usage: createMediaUsageRegistry(tx),
      processing: createPrismaProcessingStore(tx),
      queue: { enqueueProcess: async () => undefined },
    });
    const user = await tx.user.create({
      data: { id: `usage-${uid()}`, name: "Owner", email: `usage-${uid()}@test.invalid` },
    });
    const role = await tx.role.findUniqueOrThrow({ where: { key: "owner" } });
    await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const owner = await new PermissionService(tx).loadSubject(user.id);
    if (!owner) throw new Error("subject lipsă");
    return fn({ tx, service, owner });
  });
}

describe("ProductMediaUsageProvider", () => {
  it("raportează produsul și varianta care referă fișierul, cu link spre produs; fișierele libere lipsesc", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const used = await newMedia(tx);
      const onVariant = await newMedia(tx);
      const free = await newMedia(tx);
      const product = await newProduct(tx, "Pompă de căldură X");
      const variant = await tx.productVariant.create({
        data: { productId: product.id, sku: `SKU-${uid()}`, price: 100 },
      });
      await tx.productMedia.create({ data: { productId: product.id, mediaId: used.id } });
      await tx.productMedia.create({
        data: { productId: product.id, variantId: variant.id, mediaId: onVariant.id },
      });

      const provider = createProductMediaUsageProvider(tx);
      const result = await provider.findUsages([used.id, onVariant.id, free.id]);

      expect(result.get(used.id)).toEqual([
        {
          kind: "product",
          label: "Produs: Pompă de căldură X",
          href: `/admin/produse/${product.id}`,
        },
      ]);
      expect(result.get(onVariant.id)).toEqual([
        {
          kind: "product_variant",
          label: `Produs: Pompă de căldură X, varianta ${variant.sku}`,
          href: `/admin/produse/${product.id}`,
        },
      ]);
      expect(result.has(free.id)).toBe(false);
      expect((await provider.findUsages([])).size).toBe(0);
    });
  });

  it("un fișier folosit de mai multe produse le listează pe toate", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const m = await newMedia(tx);
      const a = await newProduct(tx, "Aaa");
      const b = await newProduct(tx, "Bbb");
      await tx.productMedia.create({ data: { productId: a.id, mediaId: m.id } });
      await tx.productMedia.create({ data: { productId: b.id, mediaId: m.id } });
      const usages = (await createProductMediaUsageProvider(tx).findUsages([m.id])).get(m.id);
      expect(usages?.map((u) => u.label)).toEqual(["Produs: Aaa", "Produs: Bbb"]);
    });
  });
});

describe("ștergerea din bibliotecă cu produse care referă fișierul", () => {
  it("fișierul folosit de un produs NU se poate șterge (refuz cu lista produselor); după ce e scos din produs, se șterge", async () => {
    await withLibrary(async ({ tx, service, owner }) => {
      const m = await newMedia(tx);
      const product = await newProduct(tx, "Liner albastru");
      const link = await tx.productMedia.create({
        data: { productId: product.id, mediaId: m.id },
      });

      const error = await service.delete(owner, m.id).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(MediaInUseError);
      const inUse = error as MediaInUseError;
      expect(inUse.code).toBe("MEDIA_IN_USE");
      expect(inUse.usages).toEqual([
        { kind: "product", label: "Produs: Liner albastru", href: `/admin/produse/${product.id}` },
      ]);
      // nimic nu s-a șters: nici rândul, nici obiectul din storage
      expect(await tx.media.count({ where: { id: m.id } })).toBe(1);
      expect(await storage.stat(m.key)).not.toBeNull();

      await tx.productMedia.delete({ where: { id: link.id } });
      await service.delete(owner, m.id);
      expect(await tx.media.count({ where: { id: m.id } })).toBe(0);
      expect(await storage.stat(m.key)).toBeNull();
    });
  });

  it("un produs șters (soft delete) tot blochează ștergerea, cu mesaj clar, nu cu o eroare de bază", async () => {
    await withLibrary(async ({ tx, service, owner }) => {
      const m = await newMedia(tx);
      const product = await newProduct(tx, "Produs vechi");
      await tx.productMedia.create({ data: { productId: product.id, mediaId: m.id } });
      await tx.product.update({ where: { id: product.id }, data: { deletedAt: new Date() } });

      const error = await service.delete(owner, m.id).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(MediaInUseError);
      expect((error as MediaInUseError).usages[0]?.label).toBe("Produs: Produs vechi (șters)");
    });
  });
});

describe("arhitectură: orice model care referă Media are provider înregistrat", () => {
  // Modelele din schema.prisma care DEȚIN o cheie străină spre `Media` (câmp `Media` cu `@relation(fields:`);
  // relațiile inverse (`User.mediaUploads`, `MediaFolder.media`) nu referă un fișier pentru folosire.
  const schema = readFileSync(
    fileURLToPath(new URL("../../../db/prisma/schema.prisma", import.meta.url)),
    "utf8",
  );
  const referencing = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
    .filter(
      ([, name, body]) =>
        name !== "Media" && /^\s+\w+\s+Media\??\s+@relation\(fields:/m.test(body ?? ""),
    )
    .map(([, name]) => name as string)
    .sort();

  it("modelele Prisma cu relație spre Media sunt toate în MEDIA_REFERENCING_MODELS", () => {
    // Dacă pică: un model nou referă fișiere din bibliotecă. Adaugă-i un MediaUsageProvider și
    // înregistrează-l în createMediaUsageRegistry, apoi trece-l în MEDIA_REFERENCING_MODELS.
    expect(referencing).toContain("ProductMedia");
    expect(referencing).toEqual(Object.keys(MEDIA_REFERENCING_MODELS).sort());
  });

  it("registrul real conține providerul fiecărui model care referă Media", () => {
    const registry = createMediaUsageRegistry(db);
    for (const model of referencing) {
      const provider = MEDIA_REFERENCING_MODELS[model];
      expect(provider, `model ${model} fără provider`).toBeDefined();
      expect(registry.names, `provider lipsă pentru ${model}`).toContain(provider);
    }
    expect(registry.names).toContain(PRODUCT_MEDIA_USAGE_PROVIDER);
  });
});
