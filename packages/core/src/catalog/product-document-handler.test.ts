import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import { MemoryCounterStore } from "../auth/counter-store";
import { MediaUploadGuard } from "../media/upload-guard";
import type { PermissionSubject } from "../rbac/can";
import { settingGroups } from "../settings/registry";
import {
  handleProductDocumentDownload,
  handleProductDocumentUpload,
  type DocumentSettings,
  type ProductDocumentUploadDeps,
} from "./product-document-handler";
import { DocumentError, type DocumentRecord } from "./product-documents";

const APP = "https://magazin.test";

const defaults = (): DocumentSettings => ({
  ...z.object(settingGroups.documents).parse({}),
  maxUploadBytes: 1024,
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

const editor = subject(["editor"], ["admin.access", "products.read", "products.content.write"]);
const reader = subject(["warehouse"], ["admin.access", "products.read"], "user-wh");
const support = subject(["support"], ["admin.access", "orders.read"], "user-su");

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

let sharedStore: MemoryCounterStore;
beforeEach(() => {
  sharedStore = new MemoryCounterStore();
});

function setup(options: {
  subject: PermissionSubject | null;
  settings?: Partial<DocumentSettings>;
  upload?: (bytes: Buffer, name: string, meta: unknown) => Promise<DocumentRecord>;
}) {
  const { rows, audit } = memoryAudit();
  const calls: { bytes: Buffer; name: string; meta: unknown }[] = [];
  const settings = { ...defaults(), ...options.settings };
  const deps: ProductDocumentUploadDeps = {
    getSubject: async () => options.subject,
    getSettings: async () => ({ documents: settings, trustedProxyHops: 0 }),
    appUrl: APP,
    createGuard: (s) => new MediaUploadGuard(sharedStore, s, "documents"),
    service: {
      replace: async (_subject, _productId, documentId, file) => ({
        id: documentId,
        productId: "p1",
        type: "manual",
        title: "Manual",
        originalName: file.originalName,
        mime: "application/pdf",
        sizeBytes: file.bytes.length,
        language: "ro",
        position: 0,
        showInTab: true,
        createdAt: new Date(),
      }),
      upload: async (_subject, _productId, file, meta) => {
        calls.push({ bytes: file.bytes, name: file.originalName, meta });
        if (options.upload) return options.upload(file.bytes, file.originalName, meta);
        return {
          id: "d1",
          productId: "p1",
          type: "manual",
          title: "Manual",
          originalName: file.originalName,
          mime: "application/pdf",
          sizeBytes: file.bytes.length,
          language: "ro",
          position: 0,
          showInTab: true,
          createdAt: new Date(),
        };
      },
    },
    audit,
  };
  return { deps, rows, calls };
}

const request = (
  init: {
    origin?: string | null;
    body?: Buffer | null;
    url?: string;
    headers?: Record<string, string>;
  } = {},
): Request => {
  const headers = new Headers(init.headers);
  const origin = init.origin === undefined ? APP : init.origin;
  if (origin) headers.set("origin", origin);
  return new Request(init.url ?? `${APP}/api/admin/products/p1/documents?type=manual`, {
    method: "POST",
    headers,
    body: init.body === undefined ? Buffer.alloc(100, 7) : init.body,
  });
};

describe("POST /api/admin/products/<id>/documents", () => {
  it("fără origine potrivită: 403 ORIGIN_INVALID, audit denied, serviciul nu e chemat", async () => {
    const { deps, rows, calls } = setup({ subject: editor });
    for (const origin of [null, "https://rau.example"]) {
      const response = await handleProductDocumentUpload(request({ origin }), "p1", deps);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "ORIGIN_INVALID" });
    }
    expect(calls).toEqual([]);
    expect(rows[0]).toMatchObject({
      action: "product.document.upload",
      outcome: "denied",
      after: { reason: "origin_mismatch" },
    });
  });

  it("fără sesiune: 401; fără products.content.write (Depozit, Suport): 403; nimic nu ajunge la serviciu", async () => {
    for (const [who, status] of [
      [null, 401],
      [reader, 403],
      [support, 403],
    ] as const) {
      const { deps, calls } = setup({ subject: who });
      const response = await handleProductDocumentUpload(request(), "p1", deps);
      expect(response.status).toBe(status);
      expect(calls).toEqual([]);
    }
  });

  it("succes: 201 cu documentul; numele sanitizat ajunge la serviciu; nosniff + no-store", async () => {
    const { deps, calls } = setup({ subject: editor });
    const response = await handleProductDocumentUpload(
      request({
        headers: { "x-file-name": encodeURIComponent("../../Manual Pompă.pdf") },
        url: `${APP}/api/admin/products/p1/documents?type=manual&title=Manual&language=ro&showInTab=false`,
      }),
      "p1",
      deps,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls[0]?.name).toBe("Manual Pompă.pdf");
    expect(calls[0]?.meta).toMatchObject({
      type: "manual",
      title: "Manual",
      language: "ro",
      showInTab: false,
    });
    const body = (await response.json()) as { document: Record<string, unknown> };
    expect(body.document).not.toHaveProperty("storageKey");
  });

  it("peste limită: 413 în timpul stream-ului, înainte de serviciu; audit fără conținut", async () => {
    const { deps, rows, calls } = setup({ subject: editor, settings: { maxUploadBytes: 50 } });
    const response = await handleProductDocumentUpload(
      request({ body: Buffer.alloc(51, 1) }),
      "p1",
      deps,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "DOCUMENT_TOO_LARGE" });
    expect(calls).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain("AQEB");
    expect(rows.at(-1)).toMatchObject({ outcome: "denied", after: { reason: "too_large" } });
  });

  it("corp gol: 400 DOCUMENT_EMPTY", async () => {
    const { deps } = setup({ subject: editor });
    const response = await handleProductDocumentUpload(
      request({ body: Buffer.alloc(0) }),
      "p1",
      deps,
    );
    expect(response.status).toBe(400);
  });

  it("erorile de document au status propriu: 415 tip, 422 conținut activ; auditul păstrează doar motivul și marcajele", async () => {
    const cases: [DocumentError, number][] = [
      [new DocumentError("DOCUMENT_TYPE_UNSUPPORTED", "Tip neacceptat"), 415],
      [new DocumentError("DOCUMENT_ACTIVE_CONTENT", "PDF activ", { markers: ["JavaScript"] }), 422],
    ];
    for (const [error, status] of cases) {
      const { deps, rows } = setup({
        subject: editor,
        upload: async () => {
          throw error;
        },
      });
      const response = await handleProductDocumentUpload(request(), "p1", deps);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code: error.code });
      expect(rows.at(-1)).toMatchObject({ outcome: "denied" });
    }
  });

  it("stocarea căzută: 503 cu Retry-After și audit failed; detaliile tehnice nu ies în răspuns", async () => {
    const { deps, rows } = setup({
      subject: editor,
      upload: async () => {
        throw new DocumentError("DOCUMENT_STORAGE_UNAVAILABLE", "Stocarea nu e disponibilă");
      },
    });
    const response = await handleProductDocumentUpload(request(), "p1", deps);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(rows.at(-1)).toMatchObject({
      outcome: "failed",
      after: { reason: "storage_unavailable" },
    });
  });

  it("rate limit: după limită 429 cu Retry-After; contoarele documentelor nu sunt ale bibliotecii media", async () => {
    const { deps } = setup({ subject: editor });
    for (let i = 0; i < 3; i++) {
      expect((await handleProductDocumentUpload(request(), "p1", deps)).status).toBe(201);
    }
    const limited = await handleProductDocumentUpload(request(), "p1", deps);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();

    // același utilizator, contor „media”: nu e afectat de cel al documentelor
    const mediaGuard = new MediaUploadGuard(sharedStore, defaults(), "media");
    await expect(mediaGuard.checkUpload("user-1", null)).resolves.toBeUndefined();
  });

  it("identificator de produs invalid: 404 fără apel la serviciu", async () => {
    const { deps, calls } = setup({ subject: editor });
    const response = await handleProductDocumentUpload(request(), "../etc", deps);
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("refuzurile repetate nu umplu jurnalul: peste limită se refuză, dar nu se mai înregistrează", async () => {
    // fără IP de încredere există un singur bucket comun, cu limita de 10× (aici 2 × 10)
    const { deps, rows } = setup({ subject: null });
    for (let i = 0; i < 25; i++) {
      expect((await handleProductDocumentUpload(request(), "p1", deps)).status).toBe(401);
    }
    expect(rows).toHaveLength(20);
  });
});

describe("GET descărcare", () => {
  const link = {
    downloadLink: async () => ({ url: "https://magazin.test/storage/signed/x?sig=1" }),
  };

  it("sesiune + products.read: 302 la linkul semnat, fără cache", async () => {
    const response = await handleProductDocumentDownload("p1", "d1", {
      getSubject: async () => reader,
      service: link,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/storage/signed/");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("fără sesiune 401, fără products.read 403, document străin 404", async () => {
    expect(
      (
        await handleProductDocumentDownload("p1", "d1", {
          getSubject: async () => null,
          service: link,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await handleProductDocumentDownload("p1", "d1", {
          getSubject: async () => support,
          service: link,
        })
      ).status,
    ).toBe(403);
    const missing = await handleProductDocumentDownload("p1", "d1", {
      getSubject: async () => reader,
      service: {
        downloadLink: async () => {
          throw new DocumentError("DOCUMENT_NOT_FOUND", "nu există");
        },
      },
    });
    expect(missing.status).toBe(404);
  });
});
