import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import {
  LocalStorageDriver,
  StorageError,
  deriveSigningKey,
  type StorageDriver,
} from "@ecom/integrations";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { MemoryCounterStore } from "../auth/counter-store";
import { PermissionService } from "../rbac/permission-service";
import { resolveSubject } from "../rbac/resolve-subject";
import { runBaseSeed } from "../seed/base-seed";
import { settingGroups } from "../settings/registry";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { MediaService } from "./media-service";
import { createPrismaMediaStore } from "./media-store";
import { MediaUploadGuard } from "./upload-guard";
import { handleMediaUpload, type MediaSettings } from "./upload-handler";

const db = getDb();
const APP = "https://magazin.test";

let base: string;
let storage: LocalStorageDriver;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "ecom-media-it-"));
  storage = new LocalStorageDriver({
    rootDir: join(base, "storage"),
    appUrl: APP,
    signingKey: deriveSigningKey(Buffer.alloc(32, 5).toString("base64")),
  });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
  await db.$disconnect();
});

const media = (): MediaSettings => ({
  maxUploadBytes: settingGroups.media.maxUploadBytes.parse(undefined),
  maxInputPixels: settingGroups.media.maxInputPixels.parse(undefined),
  allowedMimeTypes: settingGroups.media.allowedMimeTypes.parse(undefined),
  uploadMaxAttempts: 60,
  uploadWindowMinutes: 10,
  refusedAuditMaxAttempts: 20,
});

async function photoWithGps(): Promise<Buffer> {
  return sharp({ create: { width: 120, height: 80, channels: 3, background: "#228899" } })
    .jpeg()
    .withExif({ IFD0: { Copyright: "LOCATIE-SECRETA-44.4268N" } })
    .toBuffer();
}

/** Rulează upload-ul ca utilizator cu rolul dat (sau fără sesiune), pe baza reală, într-o tranzacție anulată. */
async function uploadAs<T>(
  role: string | null,
  options: {
    origin?: string | null;
    body?: Buffer;
    query?: string;
    fileName?: string;
    storage?: StorageDriver;
  },
  check: (ctx: { response: Response; tx: TestTx }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    let userId: string | null = null;
    if (role) {
      const user = await tx.user.create({
        data: { id: `media-${role}`, name: role, email: `media-${role}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      userId = user.id;
    }
    const permissions = new PermissionService(tx);
    const headers = new Headers({
      "x-file-name": encodeURIComponent(options.fileName ?? "poza.jpg"),
    });
    const origin = options.origin === undefined ? APP : options.origin;
    if (origin) headers.set("origin", origin);
    const request = new Request(`${APP}/api/media${options.query ?? ""}`, {
      method: "POST",
      headers,
      body: options.body ?? (await photoWithGps()),
    });
    const response = await handleMediaUpload(request, {
      getSubject: async () => {
        const resolution = await resolveSubject(
          { permissions, adminSessionHours: 8 },
          userId ? { userId, createdAt: new Date() } : null,
        );
        return resolution.status === "ok" ? resolution.subject : null;
      },
      getSettings: async () => ({ media: media(), trustedProxyHops: 0 }),
      appUrl: APP,
      createGuard: (s) => new MediaUploadGuard(new MemoryCounterStore(), s),
      service: new MediaService({
        store: createPrismaMediaStore(tx),
        storage: options.storage ?? storage,
      }),
      audit: new AuditService(createPrismaAuditStore(tx)),
    });
    return check({ response, tx });
  });
}

const objectCount = async (): Promise<number> => {
  try {
    const dirs = await readdir(join(base, "storage", "public", "media"));
    return dirs.length;
  } catch {
    return 0;
  }
};

describe("upload media: rolurile reale din seed, baza reală, storage local", () => {
  it("Editor: 201, rând Media pending, obiect fără EXIF, fără numele fișierului în cheie, audit success", async () => {
    const before = await objectCount();
    await uploadAs(
      "editor",
      { fileName: "poza-ion-popescu.jpg", query: "?alt=Pompa" },
      async ({ response, tx }) => {
        expect(response.status).toBe(201);
        const json = (await response.json()) as { id: string };
        expect(json).toMatchObject({
          status: "pending",
          mime: "image/jpeg",
          width: 120,
          height: 80,
        });

        const row = await tx.media.findUniqueOrThrow({ where: { id: json.id } });
        expect(row).toMatchObject({
          status: "pending",
          mime: "image/jpeg",
          alt: "Pompa",
          originalName: "poza-ion-popescu.jpg",
          uploadedById: "media-editor",
        });
        expect(row.storageKey).toMatch(/^public\/media\/[0-9a-f-]{36}\/original\.jpg$/);
        expect(row.storageKey).not.toContain("ion");
        expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);

        const object = await storage.get(row.storageKey);
        const chunks: Buffer[] = [];
        for await (const chunk of object.stream) chunks.push(Buffer.from(chunk as Buffer));
        const stored = Buffer.concat(chunks);
        expect(stored.length).toBe(row.sizeBytes);
        expect(stored.includes("LOCATIE-SECRETA")).toBe(false);
        expect((await sharp(stored).metadata()).exif).toBeUndefined();
        expect(object.object.contentType).toBe("image/jpeg");

        const audit = await tx.auditLog.findMany({ where: { entity: "media", entityId: row.id } });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          action: "media.upload",
          outcome: "success",
          actorId: "media-editor",
        });
      },
    );
    expect(await objectCount()).toBe(before + 1);
  });

  it("Owner poate încărca", async () => {
    await uploadAs("owner", {}, async ({ response }) => {
      expect(response.status).toBe(201);
    });
  });

  it.each(["manager", "warehouse", "support", "accountant"])(
    "%s nu are media.write: 403, nimic scris în storage sau în media, audit denied",
    async (role) => {
      const before = await objectCount();
      await uploadAs(role, {}, async ({ response, tx }) => {
        expect(response.status).toBe(403);
        expect(await tx.media.count({ where: { uploadedById: `media-${role}` } })).toBe(0);
        const denied = await tx.auditLog.findMany({
          where: { action: "media.upload", actorId: `media-${role}` },
        });
        expect(denied).toHaveLength(1);
        expect(denied[0]).toMatchObject({ outcome: "denied", entity: "media" });
        expect(denied[0]?.after).toMatchObject({ reason: "forbidden", permission: "media.write" });
      });
      expect(await objectCount()).toBe(before);
    },
  );

  it("fără sesiune: 401, nimic scris, audit denied fără actor", async () => {
    const before = await objectCount();
    await uploadAs(null, {}, async ({ response, tx }) => {
      expect(response.status).toBe(401);
      expect(await tx.media.count()).toBe(0);
      const rows = await tx.auditLog.findMany({ where: { action: "media.upload" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: "denied", actorId: null });
    });
    expect(await objectCount()).toBe(before);
  });

  it("Owner cu Origin străin: 403, nimic scris (CSRF)", async () => {
    const before = await objectCount();
    await uploadAs("owner", { origin: "https://evil.test" }, async ({ response, tx }) => {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "ORIGIN_INVALID" });
      expect(await tx.media.count()).toBe(0);
    });
    expect(await objectCount()).toBe(before);
  });

  it("fără Origin: 403", async () => {
    await uploadAs("editor", { origin: null }, async ({ response }) => {
      expect(response.status).toBe(403);
    });
  });

  it("fișier care nu e imagine (HTML cu extensie .jpg): 415, nimic scris", async () => {
    const before = await objectCount();
    await uploadAs(
      "editor",
      { body: Buffer.from("<html><script>alert(1)</script></html>"), fileName: "poza.jpg" },
      async ({ response, tx }) => {
        expect(response.status).toBe(415);
        expect(await tx.media.count()).toBe(0);
      },
    );
    expect(await objectCount()).toBe(before);
  });

  it("folder inexistent: 422 și niciun obiect rămas în storage", async () => {
    const before = await objectCount();
    await uploadAs("editor", { query: "?folderId=nu-exista" }, async ({ response, tx }) => {
      expect(response.status).toBe(422);
      expect(((await response.json()) as { code: string }).code).toBe("MEDIA_FOLDER_NOT_FOUND");
      expect(await tx.media.count()).toBe(0);
    });
    expect(await objectCount()).toBe(before);
  });

  it("storage indisponibil (bucket lipsă): 503 JSON, nicio înregistrare Media, audit cu rezultat failed", async () => {
    const broken = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async () => {
            throw new StorageError("STORAGE_FAILED", "Scrierea în S3 a eșuat", {
              errorName: "NoSuchBucket",
              status: 404,
            });
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    await uploadAs("editor", { storage: broken }, async ({ response, tx }) => {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "MEDIA_STORAGE_UNAVAILABLE" });
      expect(await tx.media.count()).toBe(0);
      const rows = await tx.auditLog.findMany({ where: { action: "media.upload" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: "failed", actorId: "media-editor" });
      expect(JSON.stringify(rows[0]?.after)).not.toContain("poza");
    });
  });

  it("folder existent: rândul îl referă", async () => {
    await uploadAs("editor", {}, async () => undefined); // încălzire
    await inRolledBackTransaction(db, async (tx) => {
      const folder = await tx.mediaFolder.create({ data: { name: "Piscine" } });
      const service = new MediaService({ store: createPrismaMediaStore(tx), storage });
      const out = await service.upload({
        bytes: await photoWithGps(),
        originalName: "a.jpg",
        folderId: folder.id,
        uploadedById: null,
        limits: { allowedMimeTypes: ["image/jpeg"], maxInputPixels: 40_000_000 },
      });
      expect(out.folderId).toBe(folder.id);
      expect(out.url).toMatch(
        /^https:\/\/magazin\.test\/media\/media\/[0-9a-f-]{36}\/original\.jpg$/,
      );
      expect(await readFile(join(base, "storage", out.storageKey))).toBeInstanceOf(Buffer);
    });
  });
});
