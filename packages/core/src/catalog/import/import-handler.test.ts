import { unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditService, type AuditRow, type AuditStore } from "../../audit/audit-service";
import { MemoryCounterStore } from "../../auth/counter-store";
import { MediaUploadGuard } from "../../media/upload-guard";
import type { PermissionSubject } from "../../rbac/can";
import { settingGroups } from "../../settings/registry";
import {
  handleProductImportReport,
  handleProductImportTemplate,
  handleProductImportUpload,
  type ImportSettingsGroup,
  type ProductImportUploadDeps,
} from "./import-handler";
import { ImportFileError } from "./import-file";
import { ImportError, type ImportAnalysis } from "./import-service";
import { parseImportFile, DEFAULT_IMPORT_LIMITS } from "./import-file";

const APP = "https://magazin.test";

const defaults = (): ImportSettingsGroup => ({
  ...z.object(settingGroups.import).parse({}),
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

const manager = subject(["manager"], ["admin.access", "products.read", "products.write"]);
const editor = subject(
  ["editor"],
  ["admin.access", "products.read", "products.content.write"],
  "u-ed",
);
const support = subject(["support"], ["admin.access", "orders.read"], "u-su");

const analysis: ImportAnalysis = {
  importId: "imp-1",
  fileName: "f.csv",
  format: "csv",
  delimiter: ";",
  delimiterSource: "detected",
  encoding: "utf-8",
  headers: ["SKU"],
  sample: [],
  rowCount: 1,
  columns: [],
  warnings: [],
};

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
  settings?: Partial<ImportSettingsGroup>;
  register?: (bytes: Uint8Array, name: string) => Promise<ImportAnalysis>;
}) {
  const { rows, audit } = memoryAudit();
  const calls: { bytes: Uint8Array; name: string }[] = [];
  const settings = { ...defaults(), ...options.settings };
  const deps: ProductImportUploadDeps = {
    getSubject: async () => options.subject,
    getSettings: async () => ({ import: settings, trustedProxyHops: 0 }),
    appUrl: APP,
    createGuard: (s) => new MediaUploadGuard(sharedStore, s, "product-import"),
    service: {
      register: async (_subject, file) => {
        calls.push({ bytes: file.bytes, name: file.fileName });
        if (options.register) return options.register(file.bytes, file.fileName);
        return analysis;
      },
    },
    audit,
  };
  return { deps, rows, calls };
}

const request = (
  init: { origin?: string | null; body?: Buffer | null; headers?: Record<string, string> } = {},
): Request => {
  const headers = new Headers(init.headers);
  const origin = init.origin === undefined ? APP : init.origin;
  if (origin) headers.set("origin", origin);
  return new Request(`${APP}/api/admin/product-imports`, {
    method: "POST",
    headers,
    body: init.body === undefined ? Buffer.from("SKU;Titlu\nA1;b\n") : init.body,
  });
};

describe("handleProductImportUpload", () => {
  it("succes: 201 cu analiza; numele fișierului vine din antet, curățat", async () => {
    const { deps, calls, rows } = setup({ subject: manager });
    const response = await handleProductImportUpload(
      request({ headers: { "x-file-name": encodeURIComponent("../produse ăă.csv") } }),
      deps,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ import: analysis });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).not.toContain("..");
    expect(calls[0]?.name).not.toContain("/");
    // succesul nu scrie în audit aici (evenimentul agregat vine la aplicare)
    expect(rows).toHaveLength(0);
  });

  it("refuză o origine străină sau lipsă, fără să citească fișierul", async () => {
    for (const origin of ["https://evil.test", null]) {
      const { deps, calls, rows } = setup({ subject: manager });
      const response = await handleProductImportUpload(request({ origin }), deps);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "ORIGIN_INVALID" });
      expect(calls).toHaveLength(0);
      expect(rows[0]).toMatchObject({
        action: "product.import.upload",
        outcome: "denied",
        after: { reason: "origin_mismatch" },
      });
    }
  });

  it("fără sesiune 401; fără products.write 403 (Editor, Suport), cu motivul în audit", async () => {
    const anonymous = setup({ subject: null });
    expect((await handleProductImportUpload(request(), anonymous.deps)).status).toBe(401);
    for (const who of [editor, support]) {
      const { deps, calls, rows } = setup({ subject: who });
      const response = await handleProductImportUpload(request(), deps);
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
      expect(rows[0]?.after).toMatchObject({ reason: "forbidden" });
    }
  });

  it("rate limit separat: după limită 429 cu Retry-After", async () => {
    const { deps } = setup({ subject: manager });
    for (let i = 0; i < 3; i++) {
      expect((await handleProductImportUpload(request(), deps)).status).toBe(201);
    }
    const limited = await handleProductImportUpload(request(), deps);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("corpul peste limita din setări: 413, oprit în timpul fluxului; corp gol: 400", async () => {
    const { deps, calls } = setup({ subject: manager });
    const big = await handleProductImportUpload(request({ body: Buffer.alloc(2048, 65) }), deps);
    expect(big.status).toBe(413);
    expect(((await big.json()) as { code: string }).code).toBe("IMPORT_FILE_TOO_LARGE");
    const empty = await handleProductImportUpload(request({ body: Buffer.alloc(0) }), deps);
    expect(empty.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("erorile de fișier au status și cod stabil: 415 pentru .xls și macro-uri, 413 pentru prea multe rânduri", async () => {
    const cases: [string, number][] = [
      ["IMPORT_FILE_UNSUPPORTED", 415],
      ["IMPORT_FILE_MACROS", 415],
      ["IMPORT_FILE_TOO_MANY_ROWS", 413],
      ["IMPORT_FILE_CORRUPT", 400],
    ];
    for (const [code, status] of cases) {
      const { deps, rows } = setup({
        subject: manager,
        settings: { uploadMaxAttempts: 100 },
        register: async () => {
          throw new ImportFileError(code, "mesaj pentru administrator");
        },
      });
      const response = await handleProductImportUpload(request(), deps);
      expect(response.status, code).toBe(status);
      expect(await response.json()).toEqual({ code, message: "mesaj pentru administrator" });
      expect(rows[0]).toMatchObject({ outcome: "denied" });
    }
  });

  it("o eroare neașteptată: 500 generic, fără detalii, auditat ca «failed»", async () => {
    const { deps, rows } = setup({
      subject: manager,
      register: async () => {
        throw new Error("parola bazei de date e xyz");
      },
    });
    const response = await handleProductImportUpload(request(), deps);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("xyz");
    expect(rows[0]).toMatchObject({ outcome: "failed" });
  });

  it("jurnalul refuzat e limitat: după `refusedAuditMaxAttempts` încercări refuzate nu se mai înregistrează", async () => {
    // fără IP de încredere există un singur bucket comun, cu limita de 10× mai mare
    const { deps, rows } = setup({ subject: null, settings: { refusedAuditMaxAttempts: 1 } });
    for (let i = 0; i < 15; i++) {
      expect((await handleProductImportUpload(request(), deps)).status).toBe(401);
    }
    expect(rows).toHaveLength(10);
  });
});

describe("șablon și raport", () => {
  const getSubject = (s: PermissionSubject | null) => async () => s;
  const templateRequest = (format: string) =>
    new Request(`${APP}/api/admin/product-imports/template?format=${format}`);

  it("șablonul se descarcă doar cu products.write, ca atașament, în ambele formate", async () => {
    const csv = await handleProductImportTemplate(templateRequest("csv"), {
      getSubject: getSubject(manager),
    });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-disposition")).toContain(
      'filename="sablon-import-produse.csv"',
    );
    expect(csv.headers.get("x-content-type-options")).toBe("nosniff");
    const csvBytes = new Uint8Array(await csv.arrayBuffer());
    // BOM UTF-8 (EF BB BF), apoi antetul
    expect([...csvBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(csvBytes.subarray(3, 21))).toBe(
      "sep=;" + String.fromCharCode(13, 10) + "SKU;Titlu;S",
    );

    const xlsx = await handleProductImportTemplate(templateRequest("xlsx"), {
      getSubject: getSubject(manager),
    });
    const bytes = new Uint8Array(await xlsx.arrayBuffer());
    expect(Object.keys(unzipSync(bytes))).toContain("xl/workbook.xml");
    // șablonul se citește înapoi de import: antetul, două rânduri de exemplu
    const table = await parseImportFile(bytes, DEFAULT_IMPORT_LIMITS);
    expect(table.headers[0]).toBe("SKU");
    expect(table.rows).toHaveLength(2);

    for (const who of [editor, support, null]) {
      const response = await handleProductImportTemplate(templateRequest("csv"), {
        getSubject: getSubject(who),
      });
      expect([401, 403]).toContain(response.status);
    }
    const bad = await handleProductImportTemplate(templateRequest("exe"), {
      getSubject: getSubject(manager),
    });
    expect(bad.status).toBe(400);
  });

  it("raportul: 401/403 fără drepturi, 404 pentru import străin, CSV cu antete de descărcare", async () => {
    const service = {
      async reportCsv(_s: PermissionSubject | null, id: string) {
        if (id === "lipsa") throw new ImportError("IMPORT_NOT_FOUND", "nu există");
        if (id === "gol") throw new ImportError("IMPORT_STATE_INVALID", "fără raport");
        return { csv: "﻿Rând;SKU\r\n", fileName: "raport-import-produse.csv" };
      },
    };
    const ok = await handleProductImportReport("imp-1", {
      getSubject: getSubject(manager),
      service,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/csv");
    expect(ok.headers.get("content-disposition")).toContain("attachment");
    expect(
      (await handleProductImportReport("lipsa", { getSubject: getSubject(manager), service }))
        .status,
    ).toBe(404);
    expect(
      (await handleProductImportReport("gol", { getSubject: getSubject(manager), service })).status,
    ).toBe(409);
    expect(
      (await handleProductImportReport("imp-1", { getSubject: getSubject(null), service })).status,
    ).toBe(401);
    expect(
      (await handleProductImportReport("imp-1", { getSubject: getSubject(editor), service }))
        .status,
    ).toBe(403);
  });
});
