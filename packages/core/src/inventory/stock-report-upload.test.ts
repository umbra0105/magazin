import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { IntegrationError } from "@ecom/shared";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import { MemoryCounterStore } from "../auth/counter-store";
import { MediaUploadGuard } from "../media/upload-guard";
import type { PermissionSubject } from "../rbac/can";
import { settingGroups } from "../settings/registry";
import { StockError } from "./stock-errors";
import type { ApplyResult, StockReportPreview } from "./stock-report-import";
import {
  handleStockReportUpload,
  STOCK_UPLOAD_MAX_BYTES,
  type StockReportUploadDeps,
} from "./stock-report-upload";

const APP = "https://magazin.test";

const importSettings = () => ({
  ...z.object(settingGroups.import).parse({}),
  uploadMaxAttempts: 3,
  uploadWindowMinutes: 10,
  refusedAuditMaxAttempts: 2,
});

const subject = (permissions: string[], id = "user-1"): PermissionSubject => ({
  userId: id,
  email: `${id}@example.test`,
  roles: ["depozit"],
  permissions: new Set(["admin.access", ...permissions]),
});
const writer = subject(["inventory.read", "inventory.write"]);
const reader = subject(["inventory.read"], "u-read");

const HASH = "a".repeat(64);
const preview = { status: "ready", planHash: HASH } as unknown as StockReportPreview;
const applied: ApplyResult = {
  snapshotId: "snap-1",
  applied: 3,
  zeroed: 0,
  mirrored: 0,
  counters: {} as ApplyResult["counters"],
};

let store: MemoryCounterStore;
beforeEach(() => {
  store = new MemoryCounterStore();
});

function setup(
  options: {
    subject?: PermissionSubject | null;
    preview?: () => Promise<StockReportPreview>;
    apply?: () => Promise<ApplyResult>;
  } = {},
) {
  const rows: Omit<AuditRow, "id" | "createdAt">[] = [];
  const auditStore: AuditStore = {
    async append(row) {
      rows.push(row);
    },
    async list() {
      return [];
    },
  };
  const calls: Array<{ kind: "preview" | "apply"; input: Record<string, unknown> }> = [];
  const deps: StockReportUploadDeps = {
    getSubject: async () => (options.subject === undefined ? writer : options.subject),
    getSettings: async () => ({ import: importSettings(), trustedProxyHops: 0 }),
    appUrl: APP,
    createGuard: (settings) => new MediaUploadGuard(store, settings, "stock-import"),
    service: {
      preview: async (_s, input) => {
        calls.push({ kind: "preview", input: { ...input } });
        return options.preview ? options.preview() : preview;
      },
      apply: async (_s, input) => {
        calls.push({ kind: "apply", input: { ...input } });
        return options.apply ? options.apply() : applied;
      },
    },
    audit: new AuditService(auditStore),
  };
  return { deps, rows, calls };
}

const FILE = Buffer.from("octeti-de-proba");
const request = (
  query: string,
  init: { origin?: string | null; body?: Buffer | null; headers?: Record<string, string> } = {},
): Request => {
  const headers = new Headers(init.headers);
  const origin = init.origin === undefined ? APP : init.origin;
  if (origin) headers.set("origin", origin);
  const body = init.body === undefined ? FILE : init.body;
  return new Request(`${APP}/api/admin/stock-imports${query}`, {
    method: "POST",
    headers,
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
};

const APPLY_QUERY = (extra = "") =>
  `?mode=apply&takenAt=2026-10-28T09%3A30%3A00.000Z&planHash=${HASH}${extra}`;

describe("handleStockReportUpload: acces", () => {
  it("origine străină → 403, fără să atingă serviciul", async () => {
    const { deps, calls } = setup();
    const res = await handleStockReportUpload(
      request("?mode=preview", { origin: "https://evil.test" }),
      deps,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "ORIGIN_INVALID" });
    expect(calls).toHaveLength(0);
  });

  it("fără sesiune → 401; fără inventory.write → 403", async () => {
    const anonymous = setup({ subject: null });
    expect((await handleStockReportUpload(request("?mode=preview"), anonymous.deps)).status).toBe(
      401,
    );
    const readOnly = setup({ subject: reader });
    const res = await handleStockReportUpload(request("?mode=preview"), readOnly.deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(readOnly.calls).toHaveLength(0);
  });

  it("refuzurile se înregistrează în audit cu motivul, fără numele fișierului", async () => {
    const { deps, rows } = setup({ subject: reader });
    await handleStockReportUpload(
      request("?mode=preview", { headers: { "x-file-name": "secret.xlsx" } }),
      deps,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "stock.import.upload",
      outcome: "denied",
      actorId: "u-read",
    });
    expect(JSON.stringify(rows[0])).not.toContain("secret");
  });

  it("peste limita de încărcări → 429 cu Retry-After", async () => {
    const { deps } = setup();
    for (let i = 0; i < 3; i += 1) {
      expect((await handleStockReportUpload(request("?mode=preview"), deps)).status).toBe(200);
    }
    const res = await handleStockReportUpload(request("?mode=preview"), deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});

describe("handleStockReportUpload: fișier", () => {
  it("fără corp → 400; peste mărimea maximă → 413", async () => {
    const { deps, calls } = setup();
    expect(
      (await handleStockReportUpload(request("?mode=preview", { body: null }), deps)).status,
    ).toBe(400);
    const big = Buffer.alloc(STOCK_UPLOAD_MAX_BYTES + 1, 1);
    const res = await handleStockReportUpload(request("?mode=preview", { body: big }), deps);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "STOCK_REPORT_FILE_TOO_LARGE" });
    expect(calls).toHaveLength(0);
  });

  it("erorile cititorului de fișier: cod și mesaj în română, statusul potrivit", async () => {
    const make = (code: string) =>
      setup({
        preview: async () => {
          throw new IntegrationError(code, "Fișierul nu este un registru Excel.");
        },
      });
    const notSheet = make("STOCK_REPORT_FILE_NOT_SPREADSHEET");
    const res = await handleStockReportUpload(request("?mode=preview"), notSheet.deps);
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({
      code: "STOCK_REPORT_FILE_NOT_SPREADSHEET",
      message: "Fișierul nu este un registru Excel.",
    });
    const header = make("STOCK_REPORT_FILE_HEADER_NOT_FOUND");
    expect((await handleStockReportUpload(request("?mode=preview"), header.deps)).status).toBe(422);
  });

  it("numele fișierului vine curățat în X-File-Name (UTF-8, percent-encoded)", async () => {
    const { deps, calls } = setup();
    await handleStockReportUpload(
      request("?mode=preview", {
        headers: { "x-file-name": encodeURIComponent("Raport_la_zi_ștoc.xls") },
      }),
      deps,
    );
    expect(calls[0]?.input["fileName"]).toBe("Raport_la_zi_ștoc.xls");
  });
});

describe("handleStockReportUpload: previzualizare", () => {
  it("întoarce raportul; ora e opțională, dar dacă vine trebuie să fie validă", async () => {
    const { deps, calls } = setup();
    const ok = await handleStockReportUpload(request("?mode=preview"), deps);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ preview: { planHash: HASH } });
    expect(calls[0]?.input["takenAt"]).toBeUndefined();

    const withTime = await handleStockReportUpload(
      request("?mode=preview&takenAt=2026-10-28T09%3A30%3A00.000Z"),
      deps,
    );
    expect(withTime.status).toBe(200);
    expect((calls[1]?.input["takenAt"] as Date).toISOString()).toBe("2026-10-28T09:30:00.000Z");

    const bad = await handleStockReportUpload(request("?mode=preview&takenAt=nu-e-data"), deps);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("opțiunile de aplicare la o previzualizare → 400, fără să atingă serviciul", async () => {
    const { deps, calls } = setup();
    for (const extra of [`&planHash=${HASH}`, "&ack=1", "&zeroConfirm=1&zeroCount=2"]) {
      const res = await handleStockReportUpload(request(`?mode=preview${extra}`), deps);
      expect(res.status, extra).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("un mod necunoscut sau un parametru străin → 400", async () => {
    const { deps } = setup();
    expect((await handleStockReportUpload(request("?mode=sterge"), deps)).status).toBe(400);
    expect((await handleStockReportUpload(request(""), deps)).status).toBe(400);
    expect((await handleStockReportUpload(request("?mode=preview&altceva=1"), deps)).status).toBe(
      400,
    );
  });
});

describe("handleStockReportUpload: aplicare", () => {
  it("trece opțiunile către serviciu: ora, amprenta, bifa orei, confirmarea «lipsă → 0»", async () => {
    const { deps, calls } = setup();
    const res = await handleStockReportUpload(
      request(APPLY_QUERY("&ack=1&zeroConfirm=1&zeroCount=12")),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: { snapshotId: "snap-1", applied: 3 } });
    expect(calls[0]?.kind).toBe("apply");
    expect(calls[0]?.input).toMatchObject({
      planHash: HASH,
      acknowledgeTimeWarnings: true,
      zeroMissing: { confirm: true, expectedCount: 12 },
    });
    expect((calls[0]?.input["takenAt"] as Date).toISOString()).toBe("2026-10-28T09:30:00.000Z");
  });

  it("fără bife: nici ack, nici zeroMissing", async () => {
    const { deps, calls } = setup();
    await handleStockReportUpload(request(APPLY_QUERY()), deps);
    expect(calls[0]?.input["acknowledgeTimeWarnings"]).toBe(false);
    expect(calls[0]?.input["zeroMissing"]).toBeUndefined();
  });

  it("«lipsă → 0» fără numărul văzut sau cu număr invalid → 400, nimic aplicat", async () => {
    const { deps, calls } = setup();
    expect(
      (await handleStockReportUpload(request(APPLY_QUERY("&zeroConfirm=1")), deps)).status,
    ).toBe(400);
    expect(
      (await handleStockReportUpload(request(APPLY_QUERY("&zeroConfirm=1&zeroCount=-1")), deps))
        .status,
    ).toBe(400);
    expect((await handleStockReportUpload(request(APPLY_QUERY("&zeroCount=3")), deps)).status).toBe(
      400,
    );
    expect(calls).toHaveLength(0);
  });

  it("lipsa amprentei sau a orei → 400", async () => {
    const { deps } = setup();
    expect((await handleStockReportUpload(request("?mode=apply"), deps)).status).toBe(400);
    expect(
      (await handleStockReportUpload(request(`?mode=apply&planHash=${HASH}`), deps)).status,
    ).toBe(400);
  });

  it("amprenta schimbată sau poza prea veche → 409; alte refuzuri de regulă → 422", async () => {
    const changed = setup({
      apply: async () => {
        throw new StockError("STOCK_IMPORT_PLAN_CHANGED", "S-a schimbat ceva.");
      },
    });
    const res = await handleStockReportUpload(request(APPLY_QUERY()), changed.deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: "STOCK_IMPORT_PLAN_CHANGED",
      message: "S-a schimbat ceva.",
    });

    const notNewer = setup({
      apply: async () => {
        throw new StockError("STOCK_IMPORT_NOT_NEWER", "Poza e veche.");
      },
    });
    expect((await handleStockReportUpload(request(APPLY_QUERY()), notNewer.deps)).status).toBe(409);

    const hasErrors = setup({
      apply: async () => {
        throw new StockError("STOCK_IMPORT_PLAN_HAS_ERRORS", "Are erori.");
      },
    });
    expect((await handleStockReportUpload(request(APPLY_QUERY()), hasErrors.deps)).status).toBe(
      422,
    );
  });

  it("o eroare neașteptată nu scapă mesajul intern: 500 cu mesaj general", async () => {
    const { deps } = setup({
      apply: async () => {
        throw new Error("conexiune la baza de date: parola=secret");
      },
    });
    const res = await handleStockReportUpload(request(APPLY_QUERY()), deps);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("STOCK_IMPORT_FAILED");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("răspunsurile nu se pun în cache", async () => {
    const { deps } = setup();
    const res = await handleStockReportUpload(request("?mode=preview"), deps);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
