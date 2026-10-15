import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { createPartsDiagramMediaUsageProvider } from "./media-usage";
import { PartsDiagramService, createPrismaPartsDiagramStore } from "./parts-diagram-service";

/**
 * Fișa explodată pe baza reală: hotspot-uri care supraviețuiesc ștergerii definitive a produsului
 * (migrația `ON DELETE SET NULL`), imaginea folosită (FK `Restrict` + provider), ștergerea în cascadă.
 */

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);
const storage = {
  publicUrl: (key: string) => `/media/${key.slice("public/".length)}`,
} as unknown as StorageDriver;

async function withService<T>(
  fn: (c: {
    tx: TestTx;
    service: PartsDiagramService;
    as: (role: string) => ReturnType<PermissionService["loadSubject"]>;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const service = new PartsDiagramService({
      store: createPrismaPartsDiagramStore(tx),
      storage,
      audit: new AuditService(createPrismaAuditStore(tx)),
      isEnabled: async () => true,
      logger: createLogger({ destination: { write() {} } }),
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `pdg-${role}-${n++}`, name: role, email: `pdg-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      return new PermissionService(tx).loadSubject(user.id);
    };
    return fn({ tx, service, as });
  });
}

const media = (tx: TestTx, status = "ready") =>
  tx.media.create({
    data: {
      mime: "image/png",
      sizeBytes: 5,
      checksum: uid(),
      originalName: "fisa.png",
      storageKey: `public/media/${uid()}/original.png`,
      status,
      width: 1000,
      height: 800,
    },
  });

const product = (tx: TestTx, title: string) =>
  tx.product.create({ data: { slug: `pdg-${uid()}`, title } });

describe("fișa explodată pe baza reală", () => {
  it("creare, hotspot-uri cu poziție exactă, asociere la produse; citire completă", async () => {
    await withService(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const image = await media(tx);
      const pump = await product(tx, "Pompă XYZ");
      const part = await product(tx, "Garnitură 12");

      const { id } = await service.create(manager, {
        title: "Pompă XYZ — vedere explodată",
        mediaId: image.id,
      });
      await service.attachProduct(manager, id, pump.id);
      await service.saveHotspot(manager, id, {
        productId: part.id,
        xBp: 1234,
        yBp: 5678,
        label: "Garnitură",
      });
      await service.saveHotspot(manager, id, { label: "Șurub", xBp: 0, yBp: 10000 });

      const detail = await service.get(manager, id);
      expect(detail.hotspots.map((h) => [h.number, h.xBp, h.yBp])).toEqual([
        [1, 1234, 5678],
        [2, 0, 10000],
      ]);
      expect(detail.hotspots[0]?.product).toMatchObject({
        id: part.id,
        title: "Garnitură 12",
        deleted: false,
      });
      expect(detail.products.map((p) => p.id)).toEqual([pump.id]);
      expect((await service.forProduct(manager, pump.id)).map((d) => d.id)).toEqual([id]);
      expect((await service.list(manager))[0]).toMatchObject({ hotspotCount: 2, productCount: 1 });
    });
  });

  it("ștergerea DEFINITIVĂ a produsului legat nu rupe fișa: hotspot-ul rămâne, fără produs", async () => {
    await withService(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const image = await media(tx);
      const part = await product(tx, "Piesă care dispare");
      const { id } = await service.create(manager, { title: "Fișă", mediaId: image.id });
      const hotspot = await service.saveHotspot(manager, id, {
        productId: part.id,
        label: "Piesă",
        xBp: 2500,
        yBp: 2500,
      });

      await tx.product.delete({ where: { id: part.id } });

      const detail = await service.get(manager, id);
      expect(detail.hotspots).toHaveLength(1);
      expect(detail.hotspots[0]).toMatchObject({
        id: hotspot.id,
        number: 1,
        label: "Piesă",
        xBp: 2500,
        product: null,
      });
      // hotspot-ul fără produs se poate repara: se leagă alt produs
      const replacement = await product(tx, "Piesă nouă");
      await service.saveHotspot(manager, id, { id: hotspot.id, productId: replacement.id });
      expect((await service.get(manager, id)).hotspots[0]?.product?.id).toBe(replacement.id);
    });
  });

  it("produsul șters „soft” rămâne legat și se vede ca șters", async () => {
    await withService(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const image = await media(tx);
      const part = await product(tx, "Piesă arhivată");
      const { id } = await service.create(manager, { title: "Fișă", mediaId: image.id });
      await service.saveHotspot(manager, id, { productId: part.id });
      await tx.product.update({ where: { id: part.id }, data: { deletedAt: new Date() } });
      expect((await service.get(manager, id)).hotspots[0]?.product).toMatchObject({
        id: part.id,
        deleted: true,
      });
    });
  });

  it("imaginea folosită de o fișă apare ca loc de folosire (cu link la editor) și nu se poate șterge", async () => {
    await withService(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const image = await media(tx);
      const { id } = await service.create(manager, { title: "Fișa mea", mediaId: image.id });

      const usages = await createPartsDiagramMediaUsageProvider(tx).findUsages([image.id]);
      expect(usages.get(image.id)).toEqual([
        {
          kind: "parts_diagram",
          label: "Fișă explodată: Fișa mea",
          href: `/admin/fise-explodate/${id}`,
        },
      ]);
    });
    // baza refuză ștergerea (FK Restrict), chiar ocolind biblioteca
    await expect(
      inRolledBackTransaction(db, async (tx) => {
        const image = await media(tx);
        await tx.partsDiagram.create({ data: { title: "F", mediaId: image.id } });
        await tx.media.delete({ where: { id: image.id } });
      }),
    ).rejects.toThrow(/parts_diagram_mediaId_fkey|foreign key|Foreign key/i);
  });

  it("ștergerea fișei (cu confirmare) scoate hotspot-urile și asocierile, nu produsele", async () => {
    await withService(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const image = await media(tx);
      const pump = await product(tx, "Pompă");
      const { id } = await service.create(manager, { title: "Fișă", mediaId: image.id });
      await service.attachProduct(manager, id, pump.id);
      await service.saveHotspot(manager, id, { productId: pump.id });
      await service.saveHotspot(manager, id, { label: "b" });

      await expect(
        service.delete(manager, id, { confirm: true, expectedHotspots: 1 }),
      ).rejects.toMatchObject({ code: "DIAGRAM_DELETE_MISMATCH" });
      await service.delete(manager, id, { confirm: true, expectedHotspots: 2 });

      expect(await tx.partsDiagram.count({ where: { id } })).toBe(0);
      expect(await tx.partsDiagramHotspot.count({ where: { diagramId: id } })).toBe(0);
      expect(await tx.partsDiagramProduct.count({ where: { diagramId: id } })).toBe(0);
      expect(await tx.product.count({ where: { id: pump.id } })).toBe(1);
      expect(await tx.media.count({ where: { id: image.id } })).toBe(1);
    });
  });

  it("baza respinge numărul duplicat și poziția în afara intervalului, chiar ocolind serviciul", async () => {
    for (const second of [
      { number: 1, label: "duplicat" },
      { number: 2, label: "x", xBp: 10001, yBp: 0 },
      { number: 0, label: "zero" },
    ]) {
      await expect(
        inRolledBackTransaction(db, async (tx) => {
          const image = await media(tx);
          const d = await tx.partsDiagram.create({ data: { title: "F", mediaId: image.id } });
          await tx.partsDiagramHotspot.create({ data: { diagramId: d.id, number: 1, label: "a" } });
          await tx.partsDiagramHotspot.create({ data: { diagramId: d.id, ...second } });
        }),
      ).rejects.toThrow();
    }
  });

  it("Editorul vede fișele dar nu le poate modifica (403)", async () => {
    await withService(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const editor = await as("editor");
      const image = await media(tx);
      const { id } = await service.create(manager, { title: "Fișă", mediaId: image.id });
      expect((await service.get(editor, id)).title).toBe("Fișă");
      await expect(service.saveHotspot(editor, id, { label: "x" })).rejects.toMatchObject({
        code: "AUTH_FORBIDDEN",
      });
    });
  });
});
