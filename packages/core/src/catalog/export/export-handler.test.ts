import { unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditService, type AuditRow, type AuditStore } from "../../audit/audit-service";
import { MemoryCounterStore } from "../../auth/counter-store";
import { MediaUploadGuard } from "../../media/upload-guard";
import type { PermissionSubject } from "../../rbac/can";
import { settingGroups } from "../../settings/registry";
import { handleProductExport, type ProductExportRouteDeps } from "./export-handler";
import { exportHeaders, type ExportRow } from "./export-rows";
import { ExportError, type PreparedExport } from "./export-service";

const APP = "https://magazin.test";

const settingsGroup = (over: Partial<z.output<typeof exportSchema>> = {}) => ({
  ...exportSchema.parse({}),
  uploadMaxAttempts: 3,
  refusedAuditMaxAttempts: 2,
  ...over,
});
const exportSchema = z.object(settingGroups.productExport);

const subject = (permissions: string[], id = "user-1"): PermissionSubject => ({
  userId: id,
  email: `${id}@example.test`,
  roles: ["manager"],
  permissions: new Set(permissions),
});
const manager = subject(["admin.access", "products.read", "products.write", "products.export"]);
const readOnly = subject(["admin.access", "products.read"], "u-ro");

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

const text = (value: string) => ({ kind: "text", value }) as const;
const ROWS: ExportRow[] = [
  [text("SKU-1"), text("=HYPERLINK(x)"), text("-5°C")],
  [text("SKU-2"), text("Pompă; cu „ghilimele”"), text("")],
];

function prepared(format: "csv" | "xlsx" = "csv"): PreparedExport {
  async function* rows(): AsyncGenerator<ExportRow> {
    for (const row of ROWS) yield row;
  }
  return {
    format,
    fileName: format === "csv" ? "export-test.csv" : "export-test.xlsx",
    headers: ["SKU", "Titlu", "Subtitlu"],
    rows: rows(),
    counts: { rows: 2, products: 2, withoutVariants: 0 },
    about: {
      exportedAt: "2026-10-17 12:00:00",
      scope: "Tot catalogul",
      filters: [],
      trash: "Exclus",
      rows: 2,
      products: 2,
      withoutVariants: 0,
    },
  };
}

let counters: MemoryCounterStore;
beforeEach(() => {
  counters = new MemoryCounterStore();
});

function setup(options: {
  subject: PermissionSubject | null;
  settings?: Partial<z.output<typeof exportSchema>>;
  prepare?: (input: unknown) => Promise<PreparedExport>;
}) {
  const { rows, audit } = memoryAudit();
  const prepareCalls: unknown[] = [];
  const settings = settingsGroup(options.settings);
  const deps: ProductExportRouteDeps = {
    getSubject: async () => options.subject,
    getSettings: async () => ({ productExport: settings, trustedProxyHops: 0 }),
    appUrl: APP,
    createGuard: (s) => new MediaUploadGuard(counters, s, "product-export"),
    service: {
      prepare: async (_subject, input) => {
        prepareCalls.push(input);
        return options.prepare ? options.prepare(input) : prepared();
      },
    },
    audit,
  };
  return { deps, rows, prepareCalls };
}

const request = (
  body: unknown = { format: "csv", scope: "all" },
  init: { origin?: string | null; raw?: string; headers?: Record<string, string> } = {},
): Request => {
  const headers = new Headers({ "content-type": "application/json", ...init.headers });
  const origin = init.origin === undefined ? APP : init.origin;
  if (origin) headers.set("origin", origin);
  return new Request(`${APP}/api/admin/product-exports`, {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(body),
  });
};

const bytesOf = async (response: Response): Promise<Uint8Array> =>
  new Uint8Array(await response.arrayBuffer());

describe("POST /api/admin/product-exports", () => {
  it("CSV: BOM + «sep=;» + antet + rânduri, în flux, cu formulele neutralizate și fără cache", async () => {
    const { deps, prepareCalls } = setup({ subject: manager });
    const response = await handleProductExport(request({ format: "csv", scope: "all" }), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="export-test.csv"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(prepareCalls).toEqual([{ format: "csv", scope: "all" }]);

    const bytes = await bytesOf(response);
    // octeții, nu textul: `Response.text()` scoate BOM-ul
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // TextDecoder scoate singur BOM-ul
    const body = new TextDecoder().decode(bytes);
    expect(body).toBe(
      [
        "sep=;",
        "SKU;Titlu;Subtitlu",
        "SKU-1;'=HYPERLINK(x);'-5°C",
        'SKU-2;"Pompă; cu „ghilimele”";',
        "",
      ].join(String.fromCharCode(13, 10)),
    );
  });

  it("XLSX: arhivă validă cu foile «Produse» și «Despre export», tip și nume de atașament corecte", async () => {
    const { deps } = setup({ subject: manager, prepare: async () => prepared("xlsx") });
    const response = await handleProductExport(request({ format: "xlsx", scope: "all" }), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="export-test.xlsx"',
    );
    const entries = unzipSync(await bytesOf(response));
    const workbook = new TextDecoder().decode(entries["xl/workbook.xml"]);
    expect(workbook).toContain('name="Produse"');
    expect(workbook).toContain('name="Despre export"');
    const strings = new TextDecoder().decode(entries["xl/sharedStrings.xml"]);
    expect(strings).toContain("SKU-1");
    expect(strings).toContain("'=HYPERLINK(x)");
    expect(strings).not.toMatch(/<t>=HYPERLINK/);
  });

  it("refuză fără origine corectă (403), fără sesiune (401) și fără products.export (403), fără să pregătească nimic", async () => {
    const wrongOrigin = setup({ subject: manager });
    expect(
      (
        await handleProductExport(
          request(undefined, { origin: "https://evil.test" }),
          wrongOrigin.deps,
        )
      ).status,
    ).toBe(403);
    expect(
      (await handleProductExport(request(undefined, { origin: null }), wrongOrigin.deps)).status,
    ).toBe(403);
    expect(wrongOrigin.prepareCalls).toHaveLength(0);

    const anonymous = setup({ subject: null });
    const unauth = await handleProductExport(request(), anonymous.deps);
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ code: "AUTH_UNAUTHENTICATED" });

    // products.read (și chiar products.write) nu ajung: trebuie products.export
    const noExport = setup({ subject: readOnly });
    const forbidden = await handleProductExport(request(), noExport.deps);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ code: "AUTH_FORBIDDEN" });
    expect(noExport.prepareCalls).toHaveLength(0);
  });

  it("rate limit propriu: peste limită 429 cu Retry-After, iar refuzurile intră în audit cu plafon", async () => {
    const { deps, rows } = setup({ subject: manager, settings: { uploadMaxAttempts: 2 } });
    expect((await handleProductExport(request(), deps)).status).toBe(200);
    expect((await handleProductExport(request(), deps)).status).toBe(200);
    const limited = await handleProductExport(request(), deps);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(rows.at(-1)).toMatchObject({
      action: "product.export",
      outcome: "denied",
      after: { reason: "rate_limited" },
    });

    // contorul e separat: o altă instalare de contoare (alt spațiu de nume) nu e afectată
    const other = new MediaUploadGuard(counters, settingsGroup(), "product-import");
    await expect(other.checkUpload(manager.userId, null)).resolves.toBeUndefined();
  });

  it("înregistrările refuzate sunt plafonate pe IP (jurnalul de audit nu se umple)", async () => {
    // fără IP de încredere există un singur bucket comun, cu limită de 10× mai mare
    const { deps, rows } = setup({ subject: null, settings: { refusedAuditMaxAttempts: 1 } });
    for (let i = 0; i < 15; i += 1) await handleProductExport(request(), deps);
    expect(rows.filter((r) => r.outcome === "denied")).toHaveLength(10);
  });

  it("cerere ilizibilă sau prea mare: 400, nu ajunge la serviciu", async () => {
    const { deps, prepareCalls } = setup({ subject: manager });
    const garbage = await handleProductExport(request(undefined, { raw: "{nu e json" }), deps);
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toMatchObject({ code: "EXPORT_INVALID" });
    const huge = await handleProductExport(
      request(undefined, { raw: JSON.stringify({ ids: "x".repeat(40_000) }) }),
      deps,
    );
    expect(huge.status).toBe(400);
    expect(prepareCalls).toHaveLength(0);
  });

  it("erorile serviciului: peste limită 413, domeniu gol 422, cu cod și mesaj în română; erori neașteptate 500 fără detalii", async () => {
    const tooMany = setup({
      subject: manager,
      prepare: async () => {
        throw new ExportError("EXPORT_TOO_MANY_ROWS", "Exportul ar avea 30000 de rânduri");
      },
    });
    const a = await handleProductExport(request(), tooMany.deps);
    expect(a.status).toBe(413);
    expect(await a.json()).toEqual({
      code: "EXPORT_TOO_MANY_ROWS",
      message: "Exportul ar avea 30000 de rânduri",
    });

    const empty = setup({
      subject: manager,
      prepare: async () => {
        throw new ExportError("EXPORT_EMPTY", "Nu există produse de exportat");
      },
    });
    expect((await handleProductExport(request(), empty.deps)).status).toBe(422);

    const broken = setup({
      subject: manager,
      prepare: async () => {
        throw new Error("conexiune la baza de date: parola=secret123");
      },
    });
    const c = await handleProductExport(request(), broken.deps);
    expect(c.status).toBe(500);
    const body = JSON.stringify(await c.json());
    expect(body).toContain("EXPORT_FAILED");
    expect(body).not.toContain("secret123");
  });

  it("antetele reale ale exportului se pot trimite (nu depinde de lista fixă din test)", () => {
    expect(exportHeaders().length).toBe(29);
  });
});
