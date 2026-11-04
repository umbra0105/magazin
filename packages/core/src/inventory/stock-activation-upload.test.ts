import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { IntegrationError } from "@ecom/shared";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import { MemoryCounterStore } from "../auth/counter-store";
import { MediaUploadGuard } from "../media/upload-guard";
import type { PermissionSubject } from "../rbac/can";
import { settingGroups } from "../settings/registry";
import type { ActivationApplyResult, StockActivationPreview } from "./stock-activation";
import {
  handleStockActivationUpload,
  type StockActivationUploadDeps,
} from "./stock-activation-upload";
import { STOCK_UPLOAD_MAX_BYTES } from "./stock-report-upload";
import { StockError } from "./stock-errors";

const APP = "https://magazin.test";

const importSettings = (attempts = 3) => ({
  ...z.object(settingGroups.import).parse({}),
  uploadMaxAttempts: attempts,
  uploadWindowMinutes: 10,
  refusedAuditMaxAttempts: 2,
});

const subject = (permissions: string[], id = "user-1"): PermissionSubject => ({
  userId: id,
  email: `${id}@example.test`,
  roles: ["depozit"],
  permissions: new Set(["admin.access", ...permissions]),
});
const both = subject(["products.write", "inventory.write"]);
const onlyInventory = subject(["inventory.write"], "u-inv");
const onlyProducts = subject(["products.write"], "u-prod");

const HASH = "b".repeat(64);
const preview = { status: "ready", planHash: HASH } as unknown as StockActivationPreview;
const applied: ActivationApplyResult = {
  snapshotId: "snap-1",
  enabledProducts: 4,
  enabledVariants: 5,
  startedAtZero: 2,
  applied: 7,
  mirrored: 0,
};

let store: MemoryCounterStore;
beforeEach(() => {
  store = new MemoryCounterStore();
});

function setup(
  options: {
    subject?: PermissionSubject | null;
    preview?: () => Promise<StockActivationPreview>;
    apply?: () => Promise<ActivationApplyResult>;
    attempts?: number;
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
  const deps: StockActivationUploadDeps = {
    getSubject: async () => (options.subject === undefined ? both : options.subject),
    getSettings: async () => ({ import: importSettings(options.attempts), trustedProxyHops: 0 }),
    appUrl: APP,
    createGuard: (settings) => new MediaUploadGuard(store, settings, "stock-activation"),
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
  return new Request(`${APP}/api/admin/stock-activations${query}`, {
    method: "POST",
    headers,
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
};

const APPLY = (extra = "") =>
  `?mode=apply&takenAt=2026-10-28T09%3A30%3A00.000Z&planHash=${HASH}&confirmProducts=4&confirmVariants=5&confirmZero=2${extra}`;

describe("handleStockActivationUpload: acces", () => {
  it("origine străină → 403, fără să atingă serviciul", async () => {
    const { deps, calls } = setup();
    const res = await handleStockActivationUpload(
      request("?mode=preview", { origin: "https://evil.test" }),
      deps,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "ORIGIN_INVALID" });
    expect(calls).toHaveLength(0);
  });

  it("fără sesiune → 401", async () => {
    const { deps } = setup({ subject: null });
    expect((await handleStockActivationUpload(request("?mode=preview"), deps)).status).toBe(401);
  });

  it("are nevoie de AMBELE permisiuni: products.write și inventory.write", async () => {
    for (const who of [onlyInventory, onlyProducts, subject(["inventory.read", "products.read"])]) {
      const { deps, calls } = setup({ subject: who });
      const res = await handleStockActivationUpload(request("?mode=preview"), deps);
      expect(res.status, who.userId).toBe(403);
      expect(await res.json()).toMatchObject({ code: "AUTH_FORBIDDEN" });
      expect(calls).toHaveLength(0);
    }
    const { deps } = setup({ subject: both });
    expect((await handleStockActivationUpload(request("?mode=preview"), deps)).status).toBe(200);
  });

  it("refuzurile se înregistrează în audit, fără numele fișierului", async () => {
    const { deps, rows } = setup({ subject: onlyInventory });
    await handleStockActivationUpload(
      request("?mode=preview", { headers: { "x-file-name": "secret.xlsx" } }),
      deps,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "stock.activation.upload",
      outcome: "denied",
      actorId: "u-inv",
    });
    expect(JSON.stringify(rows[0])).not.toContain("secret");
  });

  it("peste limita de încărcări → 429 cu Retry-After", async () => {
    const { deps } = setup();
    for (let i = 0; i < 3; i += 1) {
      expect((await handleStockActivationUpload(request("?mode=preview"), deps)).status).toBe(200);
    }
    const res = await handleStockActivationUpload(request("?mode=preview"), deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});

describe("handleStockActivationUpload: fișier", () => {
  it("fără corp → 400; peste mărimea maximă → 413", async () => {
    const { deps, calls } = setup();
    expect(
      (await handleStockActivationUpload(request("?mode=preview", { body: null }), deps)).status,
    ).toBe(400);
    const big = Buffer.alloc(STOCK_UPLOAD_MAX_BYTES + 1, 1);
    const res = await handleStockActivationUpload(request("?mode=preview", { body: big }), deps);
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
    const res = await handleStockActivationUpload(
      request("?mode=preview"),
      make("STOCK_REPORT_FILE_NOT_SPREADSHEET").deps,
    );
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({
      code: "STOCK_REPORT_FILE_NOT_SPREADSHEET",
      message: "Fișierul nu este un registru Excel.",
    });
    expect(
      (
        await handleStockActivationUpload(
          request("?mode=preview"),
          make("STOCK_REPORT_FILE_HEADER_NOT_FOUND").deps,
        )
      ).status,
    ).toBe(422);
  });
});

describe("handleStockActivationUpload: previzualizare", () => {
  it("opțiunea «cu stoc 0» ajunge la serviciu doar când e cerută", async () => {
    const { deps, calls } = setup();
    await handleStockActivationUpload(request("?mode=preview"), deps);
    await handleStockActivationUpload(request("?mode=preview&start=1"), deps);
    expect(calls[0]?.input["startUnmatched"]).toBe(false);
    expect(calls[1]?.input["startUnmatched"]).toBe(true);
  });

  it("întoarce raportul; ora trebuie să fie validă", async () => {
    const { deps, calls } = setup();
    const ok = await handleStockActivationUpload(
      request("?mode=preview&takenAt=2026-10-28T09%3A30%3A00.000Z"),
      deps,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ preview: { planHash: HASH } });
    expect((calls[0]?.input["takenAt"] as Date).toISOString()).toBe("2026-10-28T09:30:00.000Z");
    const bad = await handleStockActivationUpload(request("?mode=preview&takenAt=nu-e-data"), deps);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("opțiunile de aplicare la previzualizare, un mod necunoscut sau parametri străini → 400", async () => {
    const { deps, calls } = setup({ attempts: 100 });
    for (const q of [
      `?mode=preview&planHash=${HASH}`,
      "?mode=preview&ack=1",
      "?mode=preview&confirmProducts=1",
      "?mode=sterge",
      "",
      "?mode=preview&altceva=1",
    ]) {
      expect((await handleStockActivationUpload(request(q), deps)).status, q).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("handleStockActivationUpload: aplicare", () => {
  it("trece opțiunile către serviciu: ora, amprenta, bifa orei, opțiunea și numerele confirmate", async () => {
    const { deps, calls } = setup();
    const res = await handleStockActivationUpload(request(APPLY("&ack=1&start=1")), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      result: { snapshotId: "snap-1", enabledProducts: 4, startedAtZero: 2 },
    });
    expect(calls[0]?.kind).toBe("apply");
    expect(calls[0]?.input).toMatchObject({
      planHash: HASH,
      acknowledgeTimeWarnings: true,
      startUnmatched: true,
      confirm: { products: 4, variants: 5, zero: 2 },
    });
    expect((calls[0]?.input["takenAt"] as Date).toISOString()).toBe("2026-10-28T09:30:00.000Z");
  });

  it("fără bife: nici ack, nici opțiunea", async () => {
    const { deps, calls } = setup();
    await handleStockActivationUpload(request(APPLY()), deps);
    expect(calls[0]?.input["acknowledgeTimeWarnings"]).toBe(false);
    expect(calls[0]?.input["startUnmatched"]).toBe(false);
  });

  it("numerele confirmate lipsă sau invalide → 400, nimic aplicat", async () => {
    const { deps, calls } = setup({ attempts: 100 });
    const base = `?mode=apply&takenAt=2026-10-28T09%3A30%3A00.000Z&planHash=${HASH}`;
    for (const q of [
      base,
      `${base}&confirmProducts=4&confirmVariants=5`,
      `${base}&confirmProducts=4&confirmVariants=5&confirmZero=-1`,
      `${base}&confirmProducts=x&confirmVariants=5&confirmZero=2`,
      "?mode=apply",
    ]) {
      expect((await handleStockActivationUpload(request(q), deps)).status, q).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("lipsa numerelor confirmate are mesaj propriu, înainte de orice altă validare", async () => {
    const { deps } = setup();
    const res = await handleStockActivationUpload(
      request(`?mode=apply&takenAt=2026-10-28T09%3A30%3A00.000Z&planHash=${HASH}`),
      deps,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      "Confirmarea cere numerele",
    );
  });

  it("amprenta schimbată sau numerele neconfirmate → 409; alte refuzuri de regulă → 422", async () => {
    for (const code of [
      "STOCK_IMPORT_PLAN_CHANGED",
      "STOCK_IMPORT_NOT_NEWER",
      "STOCK_ACTIVATION_COUNT_MISMATCH",
    ]) {
      const { deps } = setup({
        attempts: 100,
        apply: async () => {
          throw new StockError(code, "S-a schimbat ceva.");
        },
      });
      const res = await handleStockActivationUpload(request(APPLY()), deps);
      expect(res.status, code).toBe(409);
      expect(await res.json()).toEqual({ code, message: "S-a schimbat ceva." });
    }
    for (const code of ["STOCK_ACTIVATION_TOO_MANY", "STOCK_ACTIVATION_NOT_APPLICABLE"]) {
      const { deps } = setup({
        attempts: 100,
        apply: async () => {
          throw new StockError(code, "Nu se poate.");
        },
      });
      expect((await handleStockActivationUpload(request(APPLY()), deps)).status, code).toBe(422);
    }
  });

  it("o eroare neașteptată nu scapă mesajul intern: 500 cu mesaj general", async () => {
    const { deps } = setup({
      apply: async () => {
        throw new Error("conexiune la baza de date: parola=secret");
      },
    });
    const res = await handleStockActivationUpload(request(APPLY()), deps);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("STOCK_ACTIVATION_FAILED");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("răspunsurile nu se pun în cache", async () => {
    const { deps } = setup();
    const res = await handleStockActivationUpload(request("?mode=preview"), deps);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
