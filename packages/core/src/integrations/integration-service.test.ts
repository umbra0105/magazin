import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  IntegrationService,
  type IntegrationRecord,
  type IntegrationStore,
} from "./integration-service";

function fakeStore() {
  const rows = new Map<string, IntegrationRecord>();
  const store: IntegrationStore = {
    async find(type, provider) {
      return rows.get(`${type}:${provider}`) ?? null;
    },
    async upsert(record) {
      rows.set(`${record.type}:${record.provider}`, record);
    },
  };
  return { rows, store };
}

describe("IntegrationService", () => {
  const appKey = randomBytes(32).toString("base64");
  let f: ReturnType<typeof fakeStore>;
  let service: IntegrationService;

  beforeEach(() => {
    f = fakeStore();
    service = new IntegrationService(f.store, appKey);
  });

  it("stochează credențialele criptate (niciodată în clar) și le citește înapoi", async () => {
    await service.save({
      type: "payment",
      provider: "netopia",
      credentials: { apiKey: "sk_live_abcdef1234", signature: "SIG-9876543210" },
      isActive: true,
    });
    const stored = f.rows.get("payment:netopia")?.credentials ?? "";
    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored).not.toContain("abcdef1234");
    expect(await service.getCredentials("payment", "netopia")).toEqual({
      apiKey: "sk_live_abcdef1234",
      signature: "SIG-9876543210",
    });
  });

  it("vederea publică are doar valori mascate", async () => {
    await service.save({
      type: "payment",
      provider: "netopia",
      credentials: { apiKey: "sk_live_abcdef1234" },
    });
    const view = await service.getPublicView("payment", "netopia");
    expect(view?.credentials).toEqual({ apiKey: "****1234" });
    expect(JSON.stringify(view)).not.toContain("abcdef");
  });

  it("păstrează credențialele existente când se salvează doar configul", async () => {
    await service.save({
      type: "shipping",
      provider: "sameday",
      credentials: { user: "contract-1" },
    });
    await service.save({
      type: "shipping",
      provider: "sameday",
      config: { sandbox: true },
      isActive: true,
    });
    expect(await service.getCredentials("shipping", "sameday")).toEqual({ user: "contract-1" });
    expect(f.rows.get("shipping:sameday")).toMatchObject({
      config: { sandbox: true },
      isActive: true,
    });
  });

  it("întoarce null pentru integrări sau credențiale inexistente", async () => {
    expect(await service.getCredentials("x", "y")).toBeNull();
    expect(await service.getPublicView("x", "y")).toBeNull();
    await service.save({ type: "invoice", provider: "smartbill" });
    expect(await service.getCredentials("invoice", "smartbill")).toBeNull();
  });

  it("nu poate decripta datele cu altă APP_KEY", async () => {
    await service.save({
      type: "payment",
      provider: "netopia",
      credentials: { apiKey: "abcdefgh1234" },
    });
    const other = new IntegrationService(f.store, randomBytes(32).toString("base64"));
    await expect(other.getCredentials("payment", "netopia")).rejects.toMatchObject({
      code: "CRYPTO_DECRYPT_FAILED",
    });
  });
});
