import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { encrypt, deriveKey, INTEGRATION_CREDENTIALS_KEY_LABEL } from "../crypto";
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

describe("IntegrationService: cazuri suplimentare", () => {
  const appKey = randomBytes(32).toString("base64");
  let f: ReturnType<typeof fakeStore>;
  let service: IntegrationService;

  beforeEach(() => {
    f = fakeStore();
    service = new IntegrationService(f.store, appKey);
  });

  it("salvarea de credențiale noi le ÎNLOCUIEȘTE integral (cheile vechi dispar)", async () => {
    await service.save({
      type: "payment",
      provider: "netopia",
      credentials: { a: "valoare-veche-1", b: "valoare-veche-2" },
    });
    await service.save({
      type: "payment",
      provider: "netopia",
      credentials: { c: "valoare-noua-3" },
    });
    expect(await service.getCredentials("payment", "netopia")).toEqual({ c: "valoare-noua-3" });
  });

  it("integrările sunt izolate între ele (tip + furnizor)", async () => {
    await service.save({
      type: "payment",
      provider: "netopia",
      credentials: { key: "cheie-netopia" },
    });
    await service.save({
      type: "payment",
      provider: "euplatesc",
      credentials: { key: "cheie-euplatesc" },
    });
    await service.save({
      type: "shipping",
      provider: "netopia",
      credentials: { key: "cheie-curier" },
    });
    expect(await service.getCredentials("payment", "netopia")).toEqual({ key: "cheie-netopia" });
    expect(await service.getCredentials("payment", "euplatesc")).toEqual({
      key: "cheie-euplatesc",
    });
    expect(await service.getCredentials("shipping", "netopia")).toEqual({ key: "cheie-curier" });
  });

  it("credențiale goale și caractere speciale se păstrează exact", async () => {
    await service.save({ type: "a", provider: "b", credentials: {} });
    expect(await service.getCredentials("a", "b")).toEqual({});
    await service.save({ type: "a", provider: "c", credentials: { parola: 'ăîșț"\\\n€😀' } });
    expect(await service.getCredentials("a", "c")).toEqual({ parola: 'ăîșț"\\\n€😀' });
  });

  it("vederea publică nu conține nicio valoare în clar, pentru nicio cheie", async () => {
    const secrets = { apiKey: "sk_live_ABCDEFGH1234", signature: "SIG_ZYXWVUTS9876", scurt: "abc" };
    await service.save({
      type: "payment",
      provider: "netopia",
      credentials: secrets,
      config: { sandbox: true },
    });
    const view = await service.getPublicView("payment", "netopia");
    const serialized = JSON.stringify(view);
    for (const value of Object.values(secrets)) expect(serialized).not.toContain(value);
    expect(view?.credentials).toEqual({ apiKey: "****1234", signature: "****9876", scurt: "****" });
    expect(view?.config).toEqual({ sandbox: true });
    expect(f.rows.get("payment:netopia")?.credentials).not.toContain("sk_live");
  });

  it("credențiale stocate care nu sunt un obiect JSON dau ValidationError", async () => {
    const key = deriveKey(appKey, INTEGRATION_CREDENTIALS_KEY_LABEL);
    f.rows.set("x:y", {
      type: "x",
      provider: "y",
      credentials: encrypt(JSON.stringify(["nu", "obiect"]), key),
      config: {},
      isActive: false,
    });
    await expect(service.getCredentials("x", "y")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("valoare stocată în clar (nu v1:) dă eroare tipată, nu se returnează ca atare", async () => {
    f.rows.set("x:z", {
      type: "x",
      provider: "z",
      credentials: '{"apiKey":"in-clar"}',
      config: {},
      isActive: false,
    });
    await expect(service.getCredentials("x", "z")).rejects.toMatchObject({
      code: "CRYPTO_UNSUPPORTED_VERSION",
    });
  });

  it("starea activă și configul se păstrează la actualizarea credențialelor", async () => {
    await service.save({
      type: "t",
      provider: "p",
      credentials: { k: "valoare-1" },
      config: { mod: "live" },
      isActive: true,
    });
    await service.save({ type: "t", provider: "p", credentials: { k: "valoare-2" } });
    expect(f.rows.get("t:p")).toMatchObject({ config: { mod: "live" }, isActive: true });
  });

  it("constructorul respinge o APP_KEY invalidă", () => {
    expect(() => new IntegrationService(f.store, "prea-scurt")).toThrowError(
      expect.objectContaining({ code: "CRYPTO_INVALID_KEY" }),
    );
  });
});
