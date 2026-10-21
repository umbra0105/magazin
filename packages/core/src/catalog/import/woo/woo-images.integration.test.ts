import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb, type PrismaClient } from "@ecom/db";
import {
  LocalStorageDriver,
  S3StorageDriver,
  deriveSigningKey,
  ensureS3Bucket,
  type StorageDriver,
} from "@ecom/integrations";
import { assertTestBucket } from "../../../../../../test/support/test-env";
import { createLogger } from "@ecom/shared";
import { wooCsv, type WooFixtureRow } from "../../../../test/woo-fixture";
import { AuditService } from "../../../audit/audit-service";
import { RowAuditCollector } from "../row-audit";
import { createPrismaAuditStore } from "../../../audit/prisma-store";
import { MemoryDecodeLimiter } from "../../../media/decode-limiter";
import { MediaService } from "../../../media/media-service";
import { createPrismaMediaStore } from "../../../media/media-store";
import { MediaProcessor, defaultMediaSettings } from "../../../media/processing";
import { createPrismaProcessingStore } from "../../../media/processing-store";
import {
  safeFetchImage,
  type ConnectRequest,
  type ConnectResponse,
  type ResolvedAddress,
} from "../../../media/safe-fetch";
import { PermissionService } from "../../../rbac/permission-service";
import { runBaseSeed } from "../../../seed/base-seed";
import { createMediaUsageRegistry } from "../../media-usage";
import { settingGroups } from "../../../settings/registry";
import { inRolledBackTransaction, type TestTx } from "../../../test-utils/rollback";
import {
  ProductAssignmentsService,
  createPrismaProductAssignmentStore,
} from "../../product-assignments";
import { createProductImportService } from "../import-runtime";
import { createPrismaProductImportStore } from "../import-store";
import type { ImageJobQueue, ImportValidation } from "../import-service";
import {
  ProductImageImporter,
  imageFailureMessage,
  type ImageImportPolicy,
} from "./image-importer";

/**
 * Importul de imagini WooCommerce pe baza reală. Rețeaua e falsă (rezolvator și conector injectați), dar
 * descărcarea trece prin `safeFetchImage` REAL, deci verificările SSRF (listă de domenii, IP public, redirect,
 * limite) rulează de-adevăratelea. Se dovedește: dry-run fără rețea, sarcini create la aplicare, descărcare în
 * ordinea din fișier, idempotență, eșec pe imagine (nu pe produs), reluare, drepturi și erori fără scurgeri.
 */

const db = getDb();
const HOST = "exemplu.invalid";
const silent = createLogger({ destination: { write() {} } });
const importDefaults = z.object(settingGroups.import).parse({});

let base: string;
let mediaStorage: StorageDriver;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "ecom-woo-images-"));
  mediaStorage = new LocalStorageDriver({
    rootDir: join(base, "storage"),
    appUrl: "https://magazin.test",
    signingKey: deriveSigningKey(Buffer.alloc(32, 7).toString("base64")),
  });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
  await db.$disconnect();
});

function memoryStorage(): StorageDriver {
  const files = new Map<string, Buffer>();
  return {
    async put(key: string, body: Buffer) {
      files.set(key, body);
      return { key, size: body.length, contentType: "application/octet-stream" };
    },
    async get(key: string) {
      const body = files.get(key);
      if (!body) throw new Error("STORAGE_NOT_FOUND");
      return {
        stream: Readable.from([body]),
        object: { key, size: body.length, contentType: "application/octet-stream" },
      };
    },
    async delete(key: string) {
      files.delete(key);
    },
  } as unknown as StorageDriver;
}

const png = (r: number, g: number, b: number, size = 24): Promise<Buffer> =>
  sharp({ create: { width: size, height: size, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();

async function* once(body: Buffer): AsyncGenerator<Uint8Array> {
  yield body;
}

const answer = (
  body: Buffer,
  headers: Record<string, string> = {},
  status = 200,
): ConnectResponse => ({ status, headers, body: once(body), close: () => undefined });

type Subject = Awaited<ReturnType<PermissionService["loadSubject"]>>;
const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 };

async function setup() {
  const pages = new Map<string, () => Promise<ConnectResponse>>();
  const net = {
    resolves: 0,
    connects: 0,
    requests: [] as ConnectRequest[],
    addresses: [PUBLIC] as ResolvedAddress[],
  };
  const policy: ImageImportPolicy & { maxImagesPerProduct: number; maxImagesPerImport: number } = {
    ...z.object(settingGroups.imageImport).parse({ allowedHosts: [HOST] }),
  };
  const mediaLimits = {
    allowedMimeTypes: defaultMediaSettings().allowedMimeTypes,
    maxInputPixels: 40_000_000,
  };
  return { pages, net, policy, mediaLimits };
}

type World = Awaited<ReturnType<typeof setup>>;

async function withImages<T>(
  fn: (c: {
    tx: TestTx;
    world: World;
    queued: string[];
    service: ReturnType<typeof createProductImportService>;
    importer: ProductImageImporter;
    as: (role: string) => Promise<Subject>;
    page: (path: string, body: Buffer | (() => Promise<ConnectResponse>)) => void;
  }) => Promise<T>,
  options: { storage?: StorageDriver } = {},
): Promise<T> {
  const world = await setup();
  const storage = options.storage ?? mediaStorage;
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const queued: string[] = [];
    const imageQueue: ImageJobQueue = {
      async enqueue(id) {
        queued.push(id);
      },
    };
    const dbx = tx as unknown as PrismaClient;
    const service = createProductImportService({
      db: dbx,
      storage: memoryStorage(),
      settings: {
        async getGroup(group: string) {
          if (group === "import") return importDefaults;
          if (group === "inventory") return { manageStock: true };
          if (group === "catalog") return { defaultWarrantyMonths: 24 };
          if (group === "regional") return { timezone: "Europe/Bucharest" };
          throw new Error(`grup neașteptat: ${group}`);
        },
        async getGroupUncached(group: string) {
          if (group === "imageImport") return world.policy;
          throw new Error(`grup neașteptat: ${group}`);
        },
      } as never,
      audit: new AuditService(createPrismaAuditStore(tx)),
      imageQueue,
      logger: silent,
    });

    const store = createPrismaProductImportStore(dbx);
    const processor = new MediaProcessor({
      store: createPrismaProcessingStore(dbx),
      storage,
      limiter: new MemoryDecodeLimiter(),
      getSettings: async () => defaultMediaSettings(),
      logger: silent,
    });
    const permissions = new PermissionService(tx);
    // Blocul C, C-12: atașarea imaginilor la produse lasă urme pe entitate, marcate cu importul
    const rowAudit = new RowAuditCollector(new AuditService(createPrismaAuditStore(tx)), silent);
    const importer = new ProductImageImporter({
      rowAudit,
      tasks: store.images,
      imports: store,
      fetchImage: (url, fetchPolicy) =>
        safeFetchImage(url, fetchPolicy, {
          resolve: async () => {
            world.net.resolves++;
            return world.net.addresses;
          },
          connect: async (request) => {
            world.net.connects++;
            world.net.requests.push(request);
            const handler = world.pages.get(`${request.host}${request.path}`);
            if (!handler) return answer(Buffer.from("nu există"), {}, 404);
            return handler();
          },
        }),
      media: new MediaService({ store: createPrismaMediaStore(dbx), storage }),
      processMedia: async (mediaId) => {
        try {
          const outcome = await processor.process(mediaId, { finalAttempt: true });
          return outcome.status === "ready" ? "ready" : "failed";
        } catch {
          return "failed";
        }
      },
      assignments: new ProductAssignmentsService({
        store: createPrismaProductAssignmentStore(dbx),
        audit: rowAudit.audit,
        logger: silent,
        storage,
      }),
      getPolicy: async () => world.policy,
      getMediaLimits: async () => world.mediaLimits,
      loadSubject: (userId) => permissions.loadSubject(userId),
      audit: new AuditService(createPrismaAuditStore(tx)),
      logger: silent,
    });

    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `img-${role}-${n++}`, name: role, email: `img-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      return permissions.loadSubject(user.id);
    };
    const page = (path: string, body: Buffer | (() => Promise<ConnectResponse>)) => {
      world.pages.set(
        `${HOST}${path}`,
        typeof body === "function"
          ? body
          : async () => answer(body, { "content-type": "image/png" }),
      );
    };
    return fn({ tx, world, queued, service, importer, as, page });
  });
}

const row = (sku: string, images: string, extra: WooFixtureRow = {}): WooFixtureRow => ({
  ID: String(100 + Number(sku.replace(/\D/g, "") || 0)),
  Tip: "simple",
  SKU: sku,
  Nume: `Produs ${sku}`,
  "Preț obișnuit": "100",
  Imagini: images,
  ...extra,
});
const url = (name: string) => `https://${HOST}/poze/${name}.png`;

async function check(
  service: ReturnType<typeof createProductImportService>,
  subject: Subject,
  rows: WooFixtureRow[],
  overrides: Record<string, unknown> = {},
) {
  const analysis = await service.register(subject, { bytes: wooCsv(rows), fileName: "woo.csv" });
  const validation = await service.validate(subject, {
    importId: analysis.importId,
    profile: "woocommerce",
    options: { ...(analysis.woo?.defaults as object), importImages: true, ...overrides },
  });
  return { analysis, validation };
}

const apply = (
  service: ReturnType<typeof createProductImportService>,
  subject: Subject,
  v: ImportValidation,
) => service.apply(subject, { importId: v.importId, confirm: true, expectedPlanHash: v.planHash });

const mediaOf = async (tx: TestTx, sku: string) => {
  const variant = await tx.productVariant.findFirstOrThrow({ where: { sku } });
  const links = await tx.productMedia.findMany({
    where: { productId: variant.productId, variantId: null },
    orderBy: { position: "asc" },
    include: { media: { select: { id: true, alt: true, sourceHash: true, status: true } } },
  });
  return { productId: variant.productId, links };
};

describe("dry-run: nicio cerere în rețea", () => {
  it("verifică adresele, arată domeniile și respingerile, fără rezolvare DNS, conectare, fișiere sau sarcini", async () => {
    await withImages(async ({ tx, world, service, as }) => {
      const owner = await as("owner");
      const { analysis, validation } = await check(service, owner, [
        row("A-1", `${url("a")}, http://${HOST}/b.png, https://alt-domeniu.invalid/c.png`),
        row("A-2", "https://10.0.0.5/d.png"),
      ]);
      expect(analysis.woo?.images).toMatchObject({
        hasColumn: true,
        total: 4,
        onAllowedHosts: 1,
        onOtherHosts: 1,
        invalid: 2,
        canImport: true,
      });
      expect(analysis.woo?.images.hosts.map((h) => [h.host, h.allowed])).toEqual(
        expect.arrayContaining([
          [HOST, true],
          ["alt-domeniu.invalid", false],
        ]),
      );
      const images = validation.report.woo?.images;
      expect(images?.enabled).toBe(true);
      expect(images?.stats).toMatchObject({ total: 4, accepted: 1, rejected: 3 });
      expect(images?.stats.rejectedByReason).toEqual({
        scheme: 1,
        host_not_allowed: 1,
        ip_literal: 1,
      });
      expect(images?.issues.map((i) => i.message)).toEqual(
        expect.arrayContaining(["domeniu nepermis", "adresă respinsă (doar https)"]),
      );
      // nicio atingere a rețelei, a bibliotecii sau a sarcinilor
      expect(world.net).toMatchObject({ resolves: 0, connects: 0 });
      expect(await tx.media.count({ where: { sourceHash: { not: null } } })).toBe(0);
      expect(await tx.productImportImage.count()).toBe(0);
      expect(await tx.product.count({ where: { variants: { some: { sku: "A-1" } } } })).toBe(0);
    });
  });

  it("lista de domenii goală: mesaj clar, nicio imagine acceptată", async () => {
    await withImages(async ({ world, service, as }) => {
      world.policy.allowedHosts = [];
      const owner = await as("owner");
      const { analysis, validation } = await check(service, owner, [row("A-1", url("a"))]);
      expect(analysis.woo?.defaults.importImages).toBe(false);
      expect(validation.report.woo?.images?.stats.rejectedByReason).toEqual({
        no_hosts_configured: 1,
      });
      expect(validation.report.woo?.images?.issues[0]?.message).toMatch(
        /lista de domenii permise e goală/,
      );
    });
  });

  it("un cont fără media.write (Manager) nu importă imagini, dar importul produselor merge", async () => {
    await withImages(async ({ tx, world, service, as, queued }) => {
      const manager = await as("manager");
      const { analysis, validation } = await check(service, manager, [row("A-1", url("a"))]);
      expect(analysis.woo?.images.canImport).toBe(false);
      expect(validation.report.woo?.images?.enabled).toBe(false);
      expect(validation.report.fileWarnings.join("\n")).toMatch(/media\.write/);
      await apply(service, manager, validation);
      expect(await tx.product.count({ where: { variants: { some: { sku: "A-1" } } } })).toBe(1);
      expect(await tx.productImportImage.count()).toBe(0);
      expect(queued).toEqual([]);
      expect(world.net.connects).toBe(0);
    });
  });
});

describe("aplicare și descărcare în fundal", () => {
  it("la aplicare se creează produsele și sarcinile; imaginile se aduc apoi, în ordinea din fișier, cu alt = titlul", async () => {
    await withImages(async ({ tx, world, service, importer, as, page, queued }) => {
      page("/poze/a.png", await png(255, 0, 0));
      page("/poze/b.png", await png(0, 255, 0));
      page("/poze/c.png", await png(0, 0, 255));
      const owner = await as("owner");
      const { validation } = await check(service, owner, [
        row("A-1", `${url("a")}, ${url("b")}, ${url("c")}`),
      ]);
      const result = await apply(service, owner, validation);
      expect(result.mode).toBe("sync");

      // sarcinile există, produsul nu are încă imagini, jobul a fost pus în coadă
      expect(await tx.productImportImage.count({ where: { status: "pending" } })).toBe(3);
      expect((await mediaOf(tx, "A-1")).links).toHaveLength(0);
      expect(queued).toEqual([validation.importId]);
      expect(world.net.connects).toBe(0);

      const summary = await importer.run(validation.importId);
      expect(summary).toMatchObject({ downloaded: 3, existing: 0, failed: 0, attached: 3 });

      const { links } = await mediaOf(tx, "A-1");
      expect(links.map((l) => l.position)).toEqual([0, 1, 2]);
      expect(links.every((l) => l.media.status === "ready")).toBe(true);
      expect(links.every((l) => l.media.alt === "Produs A-1")).toBe(true);
      expect(links.every((l) => /^[0-9a-f]{64}$/.test(l.media.sourceHash ?? ""))).toBe(true);
      // ordinea din fișier: a, b, c (hash-ul adresei normalizate)
      const hashes = await tx.productImportImage.findMany({
        orderBy: { position: "asc" },
        select: { sourceHash: true },
      });
      expect(links.map((l) => l.media.sourceHash)).toEqual(hashes.map((h) => h.sourceHash));

      // cererile: IP-ul validat, gazda pentru SNI/Host, antete fixe, fără cookie sau autorizare
      expect(world.net.requests).toHaveLength(3);
      for (const request of world.net.requests) {
        expect(request.host).toBe(HOST);
        expect(request.address.address).toBe(PUBLIC.address);
        expect(Object.keys(request.headers).map((h) => h.toLowerCase())).not.toEqual(
          expect.arrayContaining(["cookie"]),
        );
        expect(Object.keys(request.headers).map((h) => h.toLowerCase())).not.toEqual(
          expect.arrayContaining(["authorization"]),
        );
      }

      const status = await service.status(owner, validation.importId);
      expect(status.images).toMatchObject({ total: 3, pending: 0, downloaded: 3, state: "done" });

      // urmărirea utilizării: fiecare imagine adusă apare ca folosită de produs (deci nu se poate șterge din bibliotecă)
      const usages = await createMediaUsageRegistry(tx).findUsages(links.map((l) => l.mediaId));
      expect(usages.size).toBe(3);
      for (const list of usages.values()) expect(list.some((u) => u.kind === "product")).toBe(true);
    });
  });

  it("auditul are numere agregate: la aplicare (imagini) și la sfârșitul descărcării", async () => {
    await withImages(async ({ tx, service, importer, as, page }) => {
      page("/poze/a.png", await png(1, 2, 3));
      const owner = await as("owner");
      const { validation } = await check(service, owner, [
        row("A-1", `${url("a")}, http://${HOST}/x.png`),
      ]);
      await apply(service, owner, validation);
      await importer.run(validation.importId);
      const events = await tx.auditLog.findMany({
        where: { entityId: validation.importId },
        orderBy: { createdAt: "asc" },
      });
      const applied = events.find((e) => e.action === "product.import");
      const finished = events.find((e) => e.action === "product.import.images");
      expect(applied?.after).toMatchObject({ imagesTotal: 2, imagesRejected: 1, imagesQueued: 1 });
      expect(finished?.after).toMatchObject({ downloaded: 1, existing: 0, failed: 0, attached: 1 });
      expect(JSON.stringify(events)).not.toContain(HOST);
      // atașarea imaginii la produs: un eveniment pe entitate, cu importul ca origine (C-12)
      const mediaEvents = (
        await tx.auditLog.findMany({ where: { action: "product.media.update" } })
      ).filter((e) => (e.after as { importId?: string } | null)?.importId === validation.importId);
      expect(mediaEvents).toHaveLength(1);
      expect(JSON.stringify(mediaEvents)).not.toContain(HOST);
    });
  });

  it("idempotență: a doua rulare nu descarcă nimic; fără imagini lipsă, importul nu are ce aplica", async () => {
    await withImages(async ({ tx, world, service, importer, as, page }) => {
      page("/poze/a.png", await png(9, 9, 9));
      const owner = await as("owner");
      const rows = [row("A-1", url("a"))];
      const first = await check(service, owner, rows);
      await apply(service, owner, first.validation);
      await importer.run(first.validation.importId);
      const connects = world.net.connects;
      const mediaCount = await tx.media.count();

      const second = await check(service, owner, rows);
      expect(second.validation.report.woo?.images?.stats).toMatchObject({
        accepted: 1,
        alreadyAttached: 1,
      });
      await expect(apply(service, owner, second.validation)).rejects.toMatchObject({
        code: "IMPORT_NOTHING_TO_APPLY",
      });
      expect(world.net.connects).toBe(connects);
      expect(await tx.media.count()).toBe(mediaCount);
    });
  });

  it("aceeași adresă nu produce un al doilea fișier: dacă imaginea a fost scoasă din produs, se reatașează fără descărcare", async () => {
    await withImages(async ({ tx, world, service, importer, as, page }) => {
      page("/poze/a.png", await png(9, 8, 7));
      const owner = await as("owner");
      const rows = [row("A-1", url("a"))];
      const first = await check(service, owner, rows);
      await apply(service, owner, first.validation);
      await importer.run(first.validation.importId);
      const { productId } = await mediaOf(tx, "A-1");
      await tx.productMedia.deleteMany({ where: { productId } });
      const connects = world.net.connects;
      const mediaCount = await tx.media.count();

      const second = await check(service, owner, rows);
      expect(second.validation.report.woo?.images?.stats).toMatchObject({ alreadyInLibrary: 1 });
      await apply(service, owner, second.validation);
      const summary = await importer.run(second.validation.importId);
      expect(summary).toMatchObject({ downloaded: 0, existing: 1, attached: 1 });
      expect(world.net.connects).toBe(connects);
      expect(await tx.media.count()).toBe(mediaCount);
      expect((await mediaOf(tx, "A-1")).links).toHaveLength(1);
    });
  });

  it("aceeași adresă la mai multe produse: o singură descărcare, un singur fișier, atașat tuturor", async () => {
    await withImages(async ({ tx, world, service, importer, as, page }) => {
      page("/poze/comun.png", await png(5, 5, 5));
      const owner = await as("owner");
      const { validation } = await check(service, owner, [
        row("A-1", url("comun")),
        row("A-2", url("comun")),
        row("A-3", url("comun")),
      ]);
      await apply(service, owner, validation);
      await importer.run(validation.importId);
      expect(world.net.connects).toBe(1);
      expect(await tx.media.count({ where: { sourceHash: { not: null } } })).toBe(1);
      for (const sku of ["A-1", "A-2", "A-3"]) {
        expect((await mediaOf(tx, sku)).links).toHaveLength(1);
      }
    });
  });

  it("imaginile noi se adaugă DUPĂ cele existente; prima rămâne principală; nimic nu se șterge", async () => {
    await withImages(async ({ tx, service, importer, as, page }) => {
      page("/poze/a.png", await png(10, 0, 0));
      page("/poze/b.png", await png(0, 10, 0));
      const owner = await as("owner");
      // produsul există deja, cu o imagine încărcată manual
      const first = await check(service, owner, [row("A-1", "")]);
      await apply(service, owner, first.validation);
      const { productId } = await mediaOf(tx, "A-1");
      const manual = await tx.media.create({
        data: {
          mime: "image/png",
          sizeBytes: 10,
          width: 1,
          height: 1,
          checksum: "c".repeat(64),
          originalName: "manual.png",
          storageKey: "public/media/manual/original.png",
          status: "ready",
        },
      });
      await tx.productMedia.create({ data: { productId, mediaId: manual.id, position: 0 } });

      const second = await check(service, owner, [row("A-1", `${url("a")}, ${url("b")}`)], {});
      await apply(service, owner, second.validation);
      await importer.run(second.validation.importId);
      const { links } = await mediaOf(tx, "A-1");
      expect(links).toHaveLength(3);
      expect(links[0]?.mediaId).toBe(manual.id); // principala rămâne cea veche
      expect(links.slice(1).every((l) => l.media.sourceHash !== null)).toBe(true);
    });
  });
});

describe("o imagine eșuată nu strică produsul", () => {
  it("eșecul rămâne pe imagine, cu motiv în română; produsul și celelalte imagini rămân; reîncercarea aduce ce lipsește", async () => {
    await withImages(async ({ tx, service, importer, as, page, queued }) => {
      page("/poze/a.png", await png(1, 1, 1));
      // b.png lipsește (404)
      page("/poze/c.png", await png(3, 3, 3));
      const owner = await as("owner");
      const { validation } = await check(service, owner, [
        row("A-1", `${url("a")}, ${url("b")}, ${url("c")}`),
      ]);
      await apply(service, owner, validation);
      const summary = await importer.run(validation.importId);
      expect(summary).toMatchObject({ downloaded: 2, failed: 1, attached: 2 });
      expect((await mediaOf(tx, "A-1")).links).toHaveLength(2);

      const failures = await service.imageFailures(owner, validation.importId);
      expect(failures).toEqual([
        { row: 2, sku: "A-1", host: HOST, message: "descărcare eșuată (răspuns neașteptat)" },
      ]);
      const status = await service.status(owner, validation.importId);
      expect(status.images).toMatchObject({ total: 3, downloaded: 2, failed: 1, state: "done" });
      const csv = await service.reportRows(owner, validation.importId);
      expect(csv.rows.some((r) => r[2] === "imagine eșuată" && r[3]?.includes(HOST))).toBe(true);

      // se repară pagina, se reia: se aduce doar b.png, la sfârșitul listei
      page("/poze/b.png", await png(2, 2, 2));
      queued.length = 0;
      await service.retryImages(owner, validation.importId);
      expect(queued).toEqual([validation.importId]);
      const again = await importer.run(validation.importId);
      expect(again).toMatchObject({ downloaded: 1, failed: 0 });
      expect((await mediaOf(tx, "A-1")).links).toHaveLength(3);
    });
  });

  it.each([
    [
      "HTML deghizat în .png",
      () =>
        answer(Buffer.from("<html><body>nu sunt imagine</body></html>"), {
          "content-type": "image/png",
        }),
      "not_image",
    ],
    [
      "SVG",
      () =>
        answer(
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
          { "content-type": "image/svg+xml" },
        ),
      "not_image",
    ],
    [
      "fișier corupt",
      () => answer(Buffer.from("PNG-fals-dar-lung-".repeat(10)), { "content-type": "image/png" }),
      "not_image",
    ],
    ["corp gol", () => answer(Buffer.alloc(0), { "content-type": "image/png" }), "empty"],
  ])("%s → imagine eșuată (%s), produsul rămâne", async (_name, make, reason) => {
    await withImages(async ({ tx, service, importer, as, page }) => {
      page("/poze/rea.png", async () => make());
      const owner = await as("owner");
      const { validation } = await check(service, owner, [row("A-1", url("rea"))]);
      await apply(service, owner, validation);
      await importer.run(validation.importId);
      const task = await tx.productImportImage.findFirstOrThrow();
      expect(task).toMatchObject({ status: "failed", reason });
      expect(await tx.product.count({ where: { variants: { some: { sku: "A-1" } } } })).toBe(1);
      expect(await tx.media.count({ where: { sourceHash: { not: null } } })).toBe(0);
    });
  });

  it("fișier mai mare decât limita → «prea mare», chiar dacă Content-Length minte", async () => {
    await withImages(async ({ tx, world, service, importer, as, page }) => {
      world.policy.maxDownloadBytes = 2048;
      const big = Buffer.alloc(100_000, 1);
      page("/poze/mare.png", async () =>
        answer(big, { "content-type": "image/png", "content-length": "10" }),
      );
      const owner = await as("owner");
      const { validation } = await check(service, owner, [row("A-1", url("mare"))]);
      await apply(service, owner, validation);
      await importer.run(validation.importId);
      expect(await tx.productImportImage.findFirstOrThrow()).toMatchObject({
        status: "failed",
        reason: "too_large",
      });
    });
  });

  it("imagine peste limita de pixeli → eșec pe imagine", async () => {
    await withImages(async ({ tx, world, service, importer, as, page }) => {
      world.mediaLimits.maxInputPixels = 1_000_000;
      page("/poze/uriasa.png", await png(4, 4, 4, 1200));
      const owner = await as("owner");
      const { validation } = await check(service, owner, [row("A-1", url("uriasa"))]);
      await apply(service, owner, validation);
      await importer.run(validation.importId);
      expect(await tx.productImportImage.findFirstOrThrow()).toMatchObject({
        status: "failed",
        reason: "image_too_big",
      });
    });
  });
});

describe("verificările SSRF se aplică din nou la descărcare", () => {
  it("domeniu scos din listă între verificare și descărcare → «domeniu nepermis», fără nicio conectare", async () => {
    await withImages(async ({ tx, world, service, importer, as, page }) => {
      page("/poze/a.png", await png(1, 2, 3));
      const owner = await as("owner");
      const { validation } = await check(service, owner, [row("A-1", url("a"))]);
      await apply(service, owner, validation);
      world.policy.allowedHosts = ["alt-domeniu.invalid"];
      await importer.run(validation.importId);
      expect(await tx.productImportImage.findFirstOrThrow()).toMatchObject({
        status: "failed",
        reason: "host_not_allowed",
      });
      expect(world.net).toMatchObject({ resolves: 0, connects: 0 });
    });
  });

  it("domeniu permis care duce la IP privat → «adresă respinsă», fără conectare, fără IP în mesaje", async () => {
    await withImages(async ({ tx, world, service, importer, as, page }) => {
      page("/poze/a.png", await png(1, 2, 3));
      world.net.addresses = [{ address: "10.0.0.5", family: 4 }];
      const owner = await as("owner");
      const { validation } = await check(service, owner, [row("A-1", url("a"))]);
      await apply(service, owner, validation);
      await importer.run(validation.importId);
      const task = await tx.productImportImage.findFirstOrThrow();
      expect(task).toMatchObject({ status: "failed", reason: "address_not_public" });
      expect(world.net.connects).toBe(0);

      const failures = await service.imageFailures(owner, validation.importId);
      const everything = JSON.stringify([
        failures,
        await service.status(owner, validation.importId),
        await service.getHistory(owner, validation.importId),
        (await service.reportRows(owner, validation.importId)).rows,
        await tx.auditLog.findMany({ where: { entityId: validation.importId } }),
        task,
      ]);
      expect(everything).not.toContain("10.0.0.5");
    });
  });

  it("una dintre adresele rezolvate e privată → tot numele se respinge", async () => {
    await withImages(async ({ tx, world, service, importer, as, page }) => {
      page("/poze/a.png", await png(1, 2, 3));
      world.net.addresses = [PUBLIC, { address: "169.254.169.254", family: 4 }];
      const owner = await as("owner");
      const { validation } = await check(service, owner, [row("A-1", url("a"))]);
      await apply(service, owner, validation);
      await importer.run(validation.importId);
      expect(await tx.productImportImage.findFirstOrThrow()).toMatchObject({
        status: "failed",
        reason: "address_not_public",
      });
      expect(world.net.connects).toBe(0);
    });
  });

  it("redirect către alt domeniu (permis sau nu), către http sau către IP privat → respins; redirect în aceeași gazdă → urmat", async () => {
    await withImages(async ({ tx, world, service, importer, as, page }) => {
      const redirectTo = (location: string) => async (): Promise<ConnectResponse> =>
        answer(Buffer.alloc(0), { location }, 302);
      world.policy.allowedHosts = [HOST, "cdn.exemplu.invalid"];
      page("/poze/altpermis.png", redirectTo("https://cdn.exemplu.invalid/x.png"));
      page("/poze/alt.png", redirectTo("https://alt-domeniu.invalid/x.png"));
      page("/poze/http.png", redirectTo(`http://${HOST}/poze/ok.png`));
      page("/poze/privat.png", redirectTo("https://10.0.0.5/x.png"));
      page("/poze/intern.png", redirectTo(`https://${HOST}/poze/ok.png`));
      page("/poze/ok.png", await png(6, 6, 6));
      const owner = await as("owner");
      const { validation } = await check(service, owner, [
        row(
          "A-1",
          `${url("altpermis")}, ${url("alt")}, ${url("http")}, ${url("privat")}, ${url("intern")}`,
        ),
      ]);
      await apply(service, owner, validation);
      await importer.run(validation.importId);
      const tasks = await tx.productImportImage.findMany({ orderBy: { position: "asc" } });
      expect(tasks.map((t) => [t.status, t.reason])).toEqual([
        ["failed", "redirect_refused"],
        ["failed", "host_not_allowed"],
        ["failed", "scheme"],
        ["failed", "ip_literal"],
        ["downloaded", null],
      ]);
      expect(
        world.net.requests.some(
          (r) => r.host === "alt-domeniu.invalid" || r.host === "cdn.exemplu.invalid",
        ),
      ).toBe(false);
    });
  });
});

describe("drepturi", () => {
  it("rolul pierdut între aplicare și descărcare → imaginile eșuează cu «permission», fără nicio cerere", async () => {
    await withImages(async ({ tx, world, service, importer, as, page }) => {
      page("/poze/a.png", await png(1, 2, 3));
      const admin = await as("admin");
      const { validation } = await check(service, admin, [row("A-1", url("a"))]);
      await apply(service, admin, validation);
      // contul rămâne doar cu drepturi de Manager (products.write, fără media.write)
      await tx.userRole.deleteMany({ where: { userId: admin?.userId } });
      const manager = await tx.role.findUniqueOrThrow({ where: { key: "manager" } });
      await tx.userRole.create({ data: { userId: admin?.userId as string, roleId: manager.id } });
      const summary = await importer.run(validation.importId);
      expect(summary).toMatchObject({ downloaded: 0, failed: 1 });
      expect(await tx.productImportImage.findFirstOrThrow()).toMatchObject({
        status: "failed",
        reason: "permission",
      });
      expect(world.net).toMatchObject({ resolves: 0, connects: 0 });
    });
  });

  it("reluarea imaginilor cere products.write și media.write, și doar utilizatorul care a pornit importul", async () => {
    await withImages(async ({ service, importer, as, page }) => {
      page("/poze/b.png", await png(1, 2, 3));
      const owner = await as("owner");
      const { validation } = await check(service, owner, [row("A-1", url("b"))]);
      await apply(service, owner, validation);
      await importer.run(validation.importId);
      const manager = await as("manager");
      await expect(service.retryImages(manager, validation.importId)).rejects.toMatchObject({
        code: "AUTH_FORBIDDEN",
      });
      const otherAdmin = await as("admin");
      await expect(service.retryImages(otherAdmin, validation.importId)).rejects.toMatchObject({
        code: "IMPORT_IMAGES_OWNER",
      });
      await expect(service.retryImages(null, validation.importId)).rejects.toBeDefined();
    });
  });
});

describe("tabela sarcinilor: constrângeri", () => {
  it("starea, poziția, rândul, hash-ul și motivul sunt validate de baza de date (inclusiv cazul «una setată, una nulă»)", async () => {
    await withImages(async ({ tx, service, as }) => {
      const owner = await as("owner");
      const { validation } = await check(service, owner, [row("A-1", url("a"))]);
      await apply(service, owner, validation);
      const variant = await tx.productVariant.findFirstOrThrow({ where: { sku: "A-1" } });
      const data = {
        importId: validation.importId,
        productId: variant.productId,
        row: 2,
        sku: "A-1",
        position: 0,
        sourceUrl: url("x"),
        sourceHash: "a".repeat(64),
        host: HOST,
      };
      const attempt = async (over: Record<string, unknown>) => {
        await tx.$executeRawUnsafe("SAVEPOINT chk");
        try {
          await tx.productImportImage.create({ data: { ...data, ...over } as never });
          return "acceptat";
        } catch {
          return "refuzat";
        } finally {
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT chk");
        }
      };
      expect(await attempt({})).toBe("acceptat");
      expect(await attempt({ status: "inventat" })).toBe("refuzat");
      expect(await attempt({ position: -1 })).toBe("refuzat");
      expect(await attempt({ row: 0 })).toBe("refuzat");
      expect(await attempt({ sourceHash: "nu-e-hash" })).toBe("refuzat");
      expect(await attempt({ sourceHash: "A".repeat(64) })).toBe("refuzat");
      expect(await attempt({ reason: "Cod Cu Spații" })).toBe("refuzat");
      expect(await attempt({ reason: "too_large", status: "failed" })).toBe("acceptat");
      expect(await attempt({ reason: null })).toBe("acceptat");

      const mediaAttempt = async (sourceHash: string | null) => {
        await tx.$executeRawUnsafe("SAVEPOINT chk");
        try {
          await tx.media.create({
            data: {
              mime: "image/png",
              sizeBytes: 1,
              checksum: "b".repeat(64),
              originalName: "x.png",
              storageKey: `public/media/${Math.random()}/original.png`,
              sourceHash,
            },
          });
          return "acceptat";
        } catch {
          return "refuzat";
        } finally {
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT chk");
        }
      };
      expect(await mediaAttempt(null)).toBe("acceptat");
      expect(await mediaAttempt("c".repeat(64))).toBe("acceptat");
      expect(await mediaAttempt("hash-prost")).toBe("refuzat");
    });
  });

  it("aceeași adresă sursă nu poate avea două fișiere (indexul unic)", async () => {
    await withImages(async ({ tx }) => {
      const make = (storageKey: string) =>
        tx.media.create({
          data: {
            mime: "image/png",
            sizeBytes: 1,
            checksum: "b".repeat(64),
            originalName: "x.png",
            storageKey,
            sourceHash: "d".repeat(64),
          },
        });
      await make("public/media/u1/original.png");
      await tx.$executeRawUnsafe("SAVEPOINT uq");
      await expect(make("public/media/u2/original.png")).rejects.toBeDefined();
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT uq");
    });
  });
});

describe("pe stocarea S3 reală (MinIO, bucket de test)", () => {
  const bucket = process.env["S3_BUCKET"];
  assertTestBucket(bucket);

  function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} lipsește: testul cere MinIO pornit și variabilele S3_*.`);
    return value;
  }
  const connection = () => ({
    endpoint: requireEnv("S3_ENDPOINT"),
    region: process.env["S3_REGION"] ?? "us-east-1",
    accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
    forcePathStyle: (process.env["S3_FORCE_PATH_STYLE"] ?? "true") === "true",
  });

  it("imaginile aduse din adrese ajung în bucket (original + variante), se pot citi înapoi și se atașează produsului", async () => {
    await ensureS3Bucket({ ...connection(), bucket });
    const storage = new S3StorageDriver({
      ...connection(),
      bucket: bucket as string,
      appUrl: "https://magazin.test",
    });
    const keys: string[] = [];
    try {
      await withImages(
        async ({ tx, service, importer, as, page }) => {
          page("/poze/a.png", await png(200, 10, 10, 400));
          page("/poze/b.png", await png(10, 200, 10, 400));
          const owner = await as("owner");
          const { validation } = await check(service, owner, [
            row("S3-1", `${url("a")}, ${url("b")}`),
          ]);
          await apply(service, owner, validation);
          const summary = await importer.run(validation.importId);
          expect(summary).toMatchObject({ downloaded: 2, failed: 0, attached: 2 });

          const rows = await tx.media.findMany({
            where: { sourceHash: { not: null } },
            select: { storageKey: true, variants: true, status: true, mime: true },
          });
          expect(rows).toHaveLength(2);
          for (const media of rows) {
            expect(media.status).toBe("ready");
            keys.push(media.storageKey);
            const variants = media.variants as unknown as { key: string }[];
            expect(variants.length).toBeGreaterThan(0);
            for (const v of variants) keys.push(v.key);
          }
          // fiecare obiect e în bucket și are conținut
          for (const key of keys) {
            const { stream, object } = await storage.get(key);
            let size = 0;
            for await (const chunk of stream) size += (chunk as Buffer).length;
            expect(size).toBeGreaterThan(0);
            expect(object.contentType).toMatch(/^image\//);
          }
          expect((await mediaOf(tx, "S3-1")).links).toHaveLength(2);
        },
        { storage },
      );
    } finally {
      // bucketul de test e partajat între rulări, iar tranzacția se anulează: obiectele se șterg explicit
      for (const key of keys) await storage.delete(key).catch(() => undefined);
    }
  });
});

describe("mesaje", () => {
  it("fiecare cod de eșec are un mesaj în română, fără adrese sau detalii tehnice", () => {
    for (const code of [
      "host_not_allowed",
      "address_not_public",
      "not_image",
      "too_large",
      "timeout",
      "bad_status",
      "permission",
    ]) {
      const message = imageFailureMessage(code);
      expect(message).toMatch(/[a-zăâîșț]/);
      expect(message).not.toMatch(/https?:|\d+\.\d+\.\d+\.\d+/);
    }
    expect(imageFailureMessage("cod-necunoscut")).toBe("descărcare eșuată");
  });
});
