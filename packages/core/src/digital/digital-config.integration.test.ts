import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type { FetchLike, StorageDriver } from "@ecom/integrations";
import { DIGITAL_INTEGRATION_TYPE, DeliveryConfigService } from "./digital-config";

/**
 * Faza 14b, configurarea livrării: `bunny` și `s3` nu se pot activa și nu se construiesc fără confirmarea lui Owner («am testat cu
 * un cont real»); schimbarea cheilor șterge confirmarea; cheile nu se întorc niciodată spre interfață. Rândurile `integration` de
 * tip «digital_delivery» sunt comise (serviciul lucrează pe clientul bazei), deci fișierul le curăță înainte și după fiecare test.
 */
const db = getDb();
const APP_KEY = randomBytes(32).toString("base64");
const SECRET = "cheie-api-super-secreta-12345";
const TOKEN_SECRET = "cheie-token-super-secreta-67890";

const clean = () => db.integration.deleteMany({ where: { type: DIGITAL_INTEGRATION_TYPE } });
beforeEach(clean);
afterAll(async () => {
  await clean();
  await db.$disconnect();
});

const storage = { kind: "local" } as unknown as StorageDriver;
const ok: FetchLike = async () => new Response("{}", { status: 200 });

const service = (fetch: FetchLike = ok) =>
  new DeliveryConfigService({
    db,
    appKey: APP_KEY,
    appUrl: "https://magazin.exemplu.test",
    platformStorage: storage,
    fetch,
  });

const bunnyKeys = { apiKey: SECRET, libraryId: "4242", tokenAuthKey: TOKEN_SECRET };

describe("DeliveryConfigService", () => {
  it("starea publică nu conține valorile cheilor, doar «salvat / nesalvat»", async () => {
    const config = service();
    await config.save("bunny", bunnyKeys);
    const state = await config.state("bunny");
    expect(state).toMatchObject({
      code: "bunny",
      configured: true,
      isActive: false,
      verifiedInSandboxAt: null,
      saved: { apiKey: true, libraryId: true, tokenAuthKey: true },
    });
    const json = JSON.stringify(await config.list());
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(TOKEN_SECRET);
    // cheile sunt criptate în bază
    const row = await db.integration.findUniqueOrThrow({
      where: { type_provider: { type: DIGITAL_INTEGRATION_TYPE, provider: "bunny" } },
    });
    expect(row.credentials).not.toContain(SECRET);
  });

  it("fără confirmarea lui Owner nu se poate activa, iar driverul nu se construiește", async () => {
    const config = service();
    await config.save("bunny", bunnyKeys);
    await expect(config.setActive("bunny", true)).rejects.toMatchObject({
      code: "DIGITAL_LIVE_NOT_VERIFIED",
    });
    await expect(config.provider("bunny")).rejects.toMatchObject({
      code: "DIGITAL_PROVIDER_UNAVAILABLE",
    });
    expect((await config.state("bunny")).isActive).toBe(false);
  });

  it("confirmarea cere chei complete; după confirmare și activare driverul se construiește", async () => {
    const config = service();
    await config.save("bunny", { apiKey: SECRET });
    await expect(config.confirmVerified("bunny")).rejects.toMatchObject({
      code: "DIGITAL_CONFIG_INVALID",
    });
    await config.save("bunny", bunnyKeys);
    await config.confirmVerified("bunny");
    await config.setActive("bunny", true);
    const provider = await config.provider("bunny");
    expect(provider.code).toBe("bunny");
    expect((await config.state("bunny")).verifiedInSandboxAt).not.toBeNull();
  });

  it("activarea cere chei complete chiar dacă marca ar exista", async () => {
    const config = service();
    await expect(config.setActive("s3", true)).rejects.toMatchObject({
      code: "DIGITAL_CONFIG_INVALID",
    });
  });

  it("schimbarea unei chei șterge confirmarea și dezactivează furnizorul (blocare pe server din nou)", async () => {
    const config = service();
    await config.save("bunny", bunnyKeys);
    await config.confirmVerified("bunny");
    await config.setActive("bunny", true);
    const result = await config.save("bunny", { apiKey: "o-cheie-noua-de-api" });
    expect(result).toMatchObject({
      changedFields: ["apiKey"],
      verifiedCleared: true,
      deactivated: true,
    });
    expect(await config.state("bunny")).toMatchObject({
      isActive: false,
      verifiedInSandboxAt: null,
    });
    await expect(config.provider("bunny")).rejects.toMatchObject({
      code: "DIGITAL_PROVIDER_UNAVAILABLE",
    });
  });

  it("o salvare fără nicio schimbare nu atinge confirmarea", async () => {
    const config = service();
    await config.save("bunny", bunnyKeys);
    await config.confirmVerified("bunny");
    const result = await config.save("bunny", { ...bunnyKeys });
    expect(result).toEqual({ changedFields: [], verifiedCleared: false, deactivated: false });
    expect((await config.state("bunny")).verifiedInSandboxAt).not.toBeNull();
  });

  it("un câmp gol păstrează valoarea salvată", async () => {
    const config = service();
    await config.save("bunny", bunnyKeys);
    const result = await config.save("bunny", { apiKey: "", libraryId: "777" });
    expect(result.changedFields).toEqual(["libraryId"]);
    expect((await config.state("bunny")).saved.apiKey).toBe(true);
  });

  it("local e mereu disponibil, fără cont; un cod necunoscut e refuzat", async () => {
    const config = service();
    expect((await config.provider("local")).code).toBe("local");
    await expect(config.provider("ftp")).rejects.toMatchObject({
      code: "DIGITAL_PROVIDER_UNAVAILABLE",
    });
    await expect(config.state("local")).rejects.toMatchObject({ code: "DIGITAL_CONFIG_INVALID" });
  });

  it("validări: ID bibliotecă numeric, adresă S3 cu https://", async () => {
    const config = service();
    await expect(config.save("bunny", { ...bunnyKeys, libraryId: "abc" })).rejects.toMatchObject({
      code: "DIGITAL_CONFIG_INVALID",
    });
    await expect(config.save("s3", { endpoint: "ftp://x" })).rejects.toMatchObject({
      code: "DIGITAL_CONFIG_INVALID",
    });
    await expect(config.save("bunny", { apiKey: "x".repeat(2001) })).rejects.toMatchObject({
      code: "DIGITAL_CONFIG_INVALID",
    });
  });

  it("testul de conexiune folosește cheile salvate și nu întoarce secrete", async () => {
    const down: FetchLike = async () => new Response("{}", { status: 403 });
    const config = service(down);
    expect((await config.testConnection("bunny")).ok).toBe(false);
    await config.save("bunny", bunnyKeys);
    const result = await config.testConnection("bunny");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect((await service(ok).testConnection("bunny")).ok).toBe(true);
  });

  it("s3 cu stocare simulată: confirmat și activ, se construiește fără cont real", async () => {
    const config = new DeliveryConfigService({
      db,
      appKey: APP_KEY,
      appUrl: "https://magazin.exemplu.test",
      platformStorage: storage,
      s3Storage: storage,
    });
    await config.save("s3", {
      endpoint: "https://s3.exemplu.test",
      bucket: "b",
      accessKeyId: "id",
      secretAccessKey: "secret-s3",
    });
    await expect(config.provider("s3")).rejects.toMatchObject({
      code: "DIGITAL_PROVIDER_UNAVAILABLE",
    });
    await config.confirmVerified("s3");
    await config.setActive("s3", true);
    expect((await config.provider("s3")).code).toBe("s3");
  });
});
