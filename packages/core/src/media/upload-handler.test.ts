import { beforeEach, describe, expect, it } from "vitest";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import { MemoryCounterStore } from "../auth/counter-store";
import type { PermissionSubject } from "../rbac/can";
import { settingGroups } from "../settings/registry";
import { StorageError } from "@ecom/integrations";
import { MediaError } from "./errors";
import type { UploadCommand, UploadedMedia } from "./media-service";
import { MediaUploadGuard } from "./upload-guard";
import { handleMediaUpload, type MediaSettings, type MediaUploadDeps } from "./upload-handler";

const APP = "https://magazin.test";

const defaults = (): MediaSettings => ({
  maxUploadBytes: settingGroups.media.maxUploadBytes.parse(undefined),
  maxInputPixels: settingGroups.media.maxInputPixels.parse(undefined),
  allowedMimeTypes: settingGroups.media.allowedMimeTypes.parse(undefined),
  uploadMaxAttempts: 3,
  uploadWindowMinutes: 10,
  refusedAuditMaxAttempts: 2,
});

const subject = (roles: string[], permissions: string[], id = "user-1"): PermissionSubject => ({
  userId: id,
  email: `${id}@example.test`,
  roles,
  permissions: new Set(permissions),
});

const editor = subject(["editor"], ["admin.access", "media.write", "media.read"]);
const warehouse = subject(["warehouse"], ["admin.access", "media.read"], "user-wh");
const support = subject(["support"], ["admin.access", "orders.read"], "user-su");
const owner = subject(["owner"], [], "user-ow");

function memoryAudit() {
  const rows: Omit<AuditRow, "id" | "createdAt">[] = [];
  const store: AuditStore = {
    async append(row) {
      rows.push(row);
    },
    async list() {
      return [];
    },
  };
  return { rows, audit: new AuditService(store) };
}

function setup(options: {
  subject: PermissionSubject | null;
  settings?: Partial<MediaSettings>;
  upload?: (command: UploadCommand) => Promise<UploadedMedia>;
  auditFails?: boolean;
}) {
  const { rows, audit } = memoryAudit();
  const commands: UploadCommand[] = [];
  const settings = { ...defaults(), ...options.settings };
  const deps: MediaUploadDeps = {
    getSubject: async () => options.subject,
    getSettings: async () => ({ media: settings, trustedProxyHops: 0 }),
    appUrl: APP,
    createGuard: (s) => new MediaUploadGuard(sharedStore, s),
    service: {
      upload: async (command) => {
        commands.push(command);
        if (options.upload) return options.upload(command);
        return {
          id: "media-1",
          status: "pending",
          mime: "image/jpeg",
          sizeBytes: command.bytes.length,
          width: 64,
          height: 48,
          storageKey: "public/media/x/original.jpg",
          alt: command.alt ?? "",
          folderId: command.folderId ?? null,
          createdAt: new Date(),
          url: `${APP}/media/media/x/original.jpg`,
        };
      },
    },
    audit: options.auditFails
      ? ({
          record: async () => {
            throw new Error("baza de date căzută");
          },
        } as unknown as AuditService)
      : audit,
  };
  return { deps, rows, commands };
}

let sharedStore: MemoryCounterStore;
beforeEach(() => {
  sharedStore = new MemoryCounterStore();
});

const body = (size = 100) => Buffer.alloc(size, 7);

function request(
  init: {
    origin?: string | null;
    headers?: Record<string, string>;
    body?: Buffer | null;
    url?: string;
  } = {},
): Request {
  const headers = new Headers(init.headers);
  const origin = init.origin === undefined ? APP : init.origin;
  if (origin) headers.set("origin", origin);
  return new Request(init.url ?? `${APP}/api/media`, {
    method: "POST",
    headers,
    body: init.body === undefined ? body() : init.body,
  });
}

describe("POST /api/media: refuzuri (nimic nu ajunge la serviciu)", () => {
  it("fără Origin → 403 ORIGIN_INVALID, auditat ca denied", async () => {
    const { deps, rows, commands } = setup({ subject: editor });
    const res = await handleMediaUpload(request({ origin: null }), deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "ORIGIN_INVALID" });
    expect(commands).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "media.upload",
      outcome: "denied",
      actorId: "user-1",
      after: { reason: "origin_mismatch" },
    });
  });

  it("cu Origin străin → 403, chiar dacă utilizatorul are permisiunea (CSRF)", async () => {
    const { deps, rows, commands } = setup({ subject: owner });
    const res = await handleMediaUpload(request({ origin: "https://evil.test" }), deps);
    expect(res.status).toBe(403);
    expect(commands).toHaveLength(0);
    expect(rows[0]).toMatchObject({ outcome: "denied", after: { reason: "origin_mismatch" } });
  });

  it("cu Sec-Fetch-Site: cross-site → 403", async () => {
    const { deps, commands } = setup({ subject: editor });
    const res = await handleMediaUpload(
      request({ headers: { "sec-fetch-site": "cross-site" } }),
      deps,
    );
    expect(res.status).toBe(403);
    expect(commands).toHaveLength(0);
  });

  it("fără sesiune → 401, auditat denied fără actor", async () => {
    const { deps, rows, commands } = setup({ subject: null });
    const res = await handleMediaUpload(request(), deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "AUTH_UNAUTHENTICATED" });
    expect(commands).toHaveLength(0);
    expect(rows[0]).toMatchObject({
      outcome: "denied",
      actorId: null,
      after: { reason: "unauthenticated" },
    });
  });

  it.each([
    ["Suport (fără media.*)", support],
    ["Depozit (doar media.read)", warehouse],
  ])("%s → 403, cu permisiunea lipsă în jurnal", async (_name, who) => {
    const { deps, rows, commands } = setup({ subject: who });
    const res = await handleMediaUpload(request(), deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "AUTH_FORBIDDEN" });
    expect(commands).toHaveLength(0);
    expect(rows[0]).toMatchObject({
      outcome: "denied",
      actorId: who.userId,
      after: { reason: "forbidden", permission: "media.write" },
    });
  });

  it("fără admin.access nicio permisiune media nu contează", async () => {
    const noAdmin = subject(["editor"], ["media.write"], "user-na");
    const { deps, commands } = setup({ subject: noAdmin });
    expect((await handleMediaUpload(request(), deps)).status).toBe(403);
    expect(commands).toHaveLength(0);
  });

  it("jurnalul nu conține numele sau conținutul fișierului trimis", async () => {
    const { deps, rows } = setup({ subject: support });
    await handleMediaUpload(
      request({
        headers: { "x-file-name": "contract-ion-popescu.jpg" },
        body: Buffer.from("SECRET"),
      }),
      deps,
    );
    const text = JSON.stringify(rows);
    expect(text).not.toContain("contract-ion-popescu");
    expect(text).not.toContain("SECRET");
  });
});

describe("POST /api/media: limite", () => {
  it("fișier peste limită (flux, fără Content-Length) → 413 și serviciul nu e apelat", async () => {
    const { deps, rows, commands } = setup({ subject: editor, settings: { maxUploadBytes: 1024 } });
    const res = await handleMediaUpload(request({ body: body(5000) }), deps);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("MEDIA_TOO_LARGE");
    expect(commands).toHaveLength(0);
    expect(rows[0]).toMatchObject({ outcome: "denied", after: { reason: "too_large" } });
  });

  it("la rate limit → 429 cu Retry-After", async () => {
    const { deps } = setup({ subject: editor, settings: { uploadMaxAttempts: 2 } });
    expect((await handleMediaUpload(request(), deps)).status).toBe(201);
    expect((await handleMediaUpload(request(), deps)).status).toBe(201);
    const third = await handleMediaUpload(request(), deps);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("limita e per utilizator: altcineva poate încărca", async () => {
    const { deps } = setup({ subject: editor, settings: { uploadMaxAttempts: 1 } });
    expect((await handleMediaUpload(request(), deps)).status).toBe(201);
    expect((await handleMediaUpload(request(), deps)).status).toBe(429);
    const other = {
      ...deps,
      getSubject: async () => subject(["editor"], ["admin.access", "media.write"], "user-2"),
    };
    expect((await handleMediaUpload(request(), other)).status).toBe(201);
  });

  it("refuzurile peste limită se refuză tot, dar nu mai umplu jurnalul", async () => {
    const { deps, rows } = setup({ subject: null, settings: { refusedAuditMaxAttempts: 2 } });
    // fără IP de încredere bucketul comun are limita ×10 = 20
    for (let i = 0; i < 30; i++) {
      const res = await handleMediaUpload(request(), deps);
      expect(res.status).toBe(401);
    }
    expect(rows).toHaveLength(20);
  });
});

describe("POST /api/media: erori de conținut", () => {
  it.each([
    ["MEDIA_UNSUPPORTED_TYPE", 415],
    ["MEDIA_IMAGE_TOO_BIG", 422],
    ["MEDIA_CORRUPT", 422],
    ["MEDIA_FOLDER_NOT_FOUND", 422],
    ["MEDIA_EMPTY", 400],
  ] as const)("%s → %i, auditat denied", async (code, status) => {
    const { deps, rows } = setup({
      subject: editor,
      upload: async () => {
        throw new MediaError(code, "mesaj");
      },
    });
    const res = await handleMediaUpload(request(), deps);
    expect(res.status).toBe(status);
    expect(((await res.json()) as { code: string }).code).toBe(code);
    expect(rows[0]).toMatchObject({ outcome: "denied", actorId: "user-1" });
  });

  it("storage indisponibil (ex. bucket lipsă) → 503 cu cod clar și mesaj în română, auditat ca failed", async () => {
    const { deps, rows } = setup({
      subject: editor,
      upload: async () => {
        throw new StorageError("STORAGE_FAILED", "Scrierea în S3 a eșuat", {
          errorName: "NoSuchBucket",
          status: 404,
        });
      },
    });
    const res = await handleMediaUpload(
      request({ headers: { "x-file-name": "contract-ion-popescu.jpg" } }),
      deps,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("retry-after")).toBe("30");
    const text = await res.text();
    const json = JSON.parse(text) as { code: string; message: string };
    expect(json.code).toBe("MEDIA_STORAGE_UNAVAILABLE");
    expect(json.message).toMatch(/Stocarea fișierelor nu este disponibilă/);
    // fără detalii interne: nici furnizor, nici nume de bucket sau de eroare, nici cod intern
    for (const leak of ["S3", "NoSuchBucket", "STORAGE_FAILED", "404", "bucket"]) {
      expect(text).not.toContain(leak);
    }

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "media.upload",
      entity: "media",
      outcome: "failed",
      actorId: "user-1",
      after: { reason: "storage_unavailable", errorCode: "STORAGE_FAILED" },
    });
    expect(JSON.stringify(rows)).not.toContain("contract-ion-popescu");
  });

  it("recunoaște o eroare de storage și când clasa vine dintr-o altă copie a modulului", async () => {
    class ForeignStorageError extends Error {
      readonly code = "STORAGE_FAILED";
    }
    const { deps } = setup({
      subject: editor,
      upload: async () => {
        throw new ForeignStorageError("Scrierea în S3 a eșuat");
      },
    });
    const res = await handleMediaUpload(request(), deps);
    expect(res.status).toBe(503);
  });

  it("o eroare neașteptată → 500 JSON (nu corp gol), auditat ca failed, fără detalii interne", async () => {
    const { deps, rows } = setup({
      subject: editor,
      upload: async () => {
        throw new Error("conexiunea la baza de date a căzut la 10.0.0.5");
      },
    });
    const res = await handleMediaUpload(request(), deps);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ code: "MEDIA_UPLOAD_FAILED" });
    expect(text).not.toContain("10.0.0.5");
    expect(rows[0]).toMatchObject({ outcome: "failed", after: { reason: "unexpected_error" } });
  });

  it("eșecurile de storage repetate nu umplu jurnalul (aceeași limită ca refuzurile)", async () => {
    const { deps, rows } = setup({
      subject: editor,
      settings: { refusedAuditMaxAttempts: 1, uploadMaxAttempts: 1000 },
      upload: async () => {
        throw new StorageError("STORAGE_FAILED", "x");
      },
    });
    for (let i = 0; i < 30; i++) {
      expect((await handleMediaUpload(request(), deps)).status).toBe(503);
    }
    expect(rows).toHaveLength(10); // limita 1 × 10 (bucket comun, fără IP de încredere)
  });
});

describe("POST /api/media: reușită", () => {
  it("201 cu datele publice, audit success și comanda curățată", async () => {
    const { deps, rows, commands } = setup({ subject: editor });
    const res = await handleMediaUpload(
      request({
        url: `${APP}/api/media?folderId=fold-1&alt=Pompa%20de%20c%C4%83ldur%C4%83`,
        headers: {
          "x-file-name": encodeURIComponent("../../poza mea.jpg"),
          "content-type": "text/html",
        },
      }),
      deps,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const json: unknown = await res.json();
    expect(json).toEqual({
      id: "media-1",
      status: "pending",
      mime: "image/jpeg",
      width: 64,
      height: 48,
      sizeBytes: 100,
      url: `${APP}/media/media/x/original.jpg`,
    });
    // nu se expun cheia de storage, suma de control sau numele
    expect(JSON.stringify(json)).not.toContain("storageKey");
    expect(JSON.stringify(json)).not.toContain("poza");

    expect(commands[0]).toMatchObject({
      originalName: "poza mea.jpg",
      folderId: "fold-1",
      alt: "Pompa de căldură",
      uploadedById: "user-1",
    });
    expect(commands[0]?.limits.allowedMimeTypes).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "media.upload",
      entity: "media",
      entityId: "media-1",
      outcome: "success",
      actorId: "user-1",
      after: { mime: "image/jpeg", sizeBytes: 100, width: 64, height: 48 },
    });
    // numele fișierului nu intră în jurnal
    expect(JSON.stringify(rows)).not.toContain("poza");
  });

  it("Owner (fără permisiuni explicite) poate încărca", async () => {
    const { deps } = setup({ subject: owner });
    expect((await handleMediaUpload(request(), deps)).status).toBe(201);
  });

  it("dacă auditul eșuează după salvare → 500 AUDIT_WRITE_FAILED cu mediaId (fișierul rămâne)", async () => {
    const { deps } = setup({ subject: editor, auditFails: true });
    const res = await handleMediaUpload(request(), deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: "AUDIT_WRITE_FAILED", mediaId: "media-1" });
  });

  it("un refuz nu cade dacă jurnalul e indisponibil", async () => {
    const { deps } = setup({ subject: null, auditFails: true });
    const res = await handleMediaUpload(request(), deps);
    expect(res.status).toBe(401);
  });
});
