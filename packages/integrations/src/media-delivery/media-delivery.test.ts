import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IntegrationError } from "@ecom/shared";
import type { StorageDriver } from "../storage/types";
import { BunnyDeliveryProvider } from "./bunny";
import { buildMediaDelivery } from "./registry";
import { StorageDeliveryProvider } from "./storage-delivery";

const NOW = new Date("2030-01-01T10:00:00.000Z");

function fakeStorage() {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const signed: Array<{ key: string; expiresInSeconds: number; downloadFilename?: string }> = [];
  const storage = {
    kind: "local" as const,
    async put(key: string, body: Buffer, options: { contentType: string }) {
      objects.set(key, { body, contentType: options.contentType });
      return { key, size: body.length, contentType: options.contentType };
    },
    async stat(key: string) {
      const found = objects.get(key);
      return found ? { key, size: found.body.length, contentType: found.contentType } : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async signedUrl(key: string, options: { expiresInSeconds: number; downloadFilename?: string }) {
      signed.push({ key, ...options });
      return `https://app.test/storage/signed/${key}?exp=${options.expiresInSeconds}`;
    },
  } as unknown as StorageDriver;
  return { storage, objects, signed };
}

describe("StorageDeliveryProvider (local, s3)", () => {
  it("stochează în spațiul privat și întoarce cheia, fără adresă publică", async () => {
    const { storage, objects } = fakeStorage();
    const provider = new StorageDeliveryProvider({
      code: "local",
      label: "Local",
      storage,
      newId: () => "abc123",
    });
    const stored = await provider.store({
      type: "file",
      body: Buffer.from("PDF"),
      fileName: "Ghid Piscină.PDF",
      mimeType: "application/pdf",
    });
    expect(stored).toEqual({
      storageKey: "private/digital/abc123.pdf",
      status: "ready",
      fileSize: 3,
      durationSeconds: null,
    });
    expect(objects.get("private/digital/abc123.pdf")?.contentType).toBe("application/pdf");
  });

  it("linkul de descărcare are expirare și nume de fișier; cel de redare, nu", async () => {
    const { storage, signed } = fakeStorage();
    const provider = new StorageDeliveryProvider({ code: "local", label: "Local", storage });
    const asset = {
      type: "file" as const,
      storageKey: "private/digital/x.pdf",
      originalName: "ghid.pdf",
      mimeType: "application/pdf",
    };
    const download = await provider.createAccess({
      asset,
      mode: "download",
      expiresInSeconds: 120,
      viewerEmail: "a@b.test",
      now: NOW,
    });
    expect(download.kind).toBe("url");
    expect(download.watermarked).toBe(false);
    expect(download.expiresAt.toISOString()).toBe("2030-01-01T10:02:00.000Z");
    expect(signed[0]).toEqual({
      key: asset.storageKey,
      expiresInSeconds: 120,
      downloadFilename: "ghid.pdf",
    });
    await provider.createAccess({
      asset,
      mode: "play",
      expiresInSeconds: 120,
      viewerEmail: null,
      now: NOW,
    });
    expect(signed[1]).toEqual({ key: asset.storageKey, expiresInSeconds: 120 });
  });

  it.each([0, 14, 3601, 1.5, -5, Number.NaN])(
    "expirare invalidă (%s) e refuzată",
    async (seconds) => {
      const { storage } = fakeStorage();
      const provider = new StorageDeliveryProvider({ code: "local", label: "Local", storage });
      await expect(
        provider.createAccess({
          asset: {
            type: "file",
            storageKey: "private/digital/x.pdf",
            originalName: null,
            mimeType: null,
          },
          mode: "download",
          expiresInSeconds: seconds,
          viewerEmail: null,
          now: NOW,
        }),
      ).rejects.toMatchObject({ code: "MEDIA_DELIVERY_INVALID_EXPIRY" });
    },
  );

  it("ștergerea e idempotentă și starea reflectă existența", async () => {
    const { storage } = fakeStorage();
    const provider = new StorageDeliveryProvider({ code: "s3", label: "S3", storage });
    const stored = await provider.store({
      type: "file",
      body: Buffer.from("x"),
      fileName: "a.zip",
      mimeType: "application/zip",
    });
    expect(await provider.status(stored.storageKey)).toBe("ready");
    await provider.remove(stored.storageKey);
    await provider.remove(stored.storageKey);
    expect(await provider.status(stored.storageKey)).toBe("failed");
  });

  it("testul de conexiune scrie, citește și șterge", async () => {
    const { storage, objects } = fakeStorage();
    const provider = new StorageDeliveryProvider({ code: "local", label: "Local", storage });
    expect(await provider.testConnection()).toMatchObject({ ok: true });
    expect(objects.size).toBe(0);
  });
});

const API_SECRET = "cheie-api-secreta";
const TOKEN_SECRET = "cheie-token-secreta";
const credentials = { apiKey: API_SECRET, libraryId: "4242", tokenAuthKey: TOKEN_SECRET };

function bunnyFetch(
  handler: (url: string, init: RequestInit) => { status: number; body?: unknown },
) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchLike = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, method: String(init.method) });
    const result = handler(url, init);
    return new Response(JSON.stringify(result.body ?? {}), { status: result.status });
  };
  return { fetchLike, calls };
}

const VIDEO = {
  type: "video" as const,
  storageKey: "guid-1234567",
  originalName: null,
  mimeType: null,
};

describe("BunnyDeliveryProvider (doar răspunsuri simulate)", () => {
  it("încarcă un video (creare + încărcare) și îl lasă «în procesare»", async () => {
    const { fetchLike, calls } = bunnyFetch((_url, init) =>
      init.method === "POST"
        ? { status: 200, body: { guid: "9a8b7c6d-0000-1111-2222-333344445555" } }
        : { status: 200 },
    );
    const provider = new BunnyDeliveryProvider({ credentials, fetch: fetchLike });
    const stored = await provider.store({
      type: "video",
      body: Buffer.from("video"),
      fileName: "lectia-1.mp4",
      mimeType: "video/mp4",
    });
    expect(stored.storageKey).toBe("9a8b7c6d-0000-1111-2222-333344445555");
    expect(stored.status).toBe("processing");
    expect(calls.map((c) => c.method)).toEqual(["POST", "PUT"]);
  });

  it("refuză fișierele care nu sunt video", async () => {
    const provider = new BunnyDeliveryProvider({ credentials });
    await expect(
      provider.store({
        type: "file",
        body: Buffer.from("x"),
        fileName: "a.pdf",
        mimeType: "application/pdf",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_DELIVERY_REJECTED" });
  });

  it.each([
    [0, "processing"],
    [3, "processing"],
    [4, "ready"],
    [5, "failed"],
    [6, "failed"],
  ] as const)("starea Bunny %s înseamnă %s", async (code, expected) => {
    const { fetchLike } = bunnyFetch(() => ({ status: 200, body: { status: code } }));
    const provider = new BunnyDeliveryProvider({ credentials, fetch: fetchLike });
    expect(await provider.status("guid-1234567")).toBe(expected);
  });

  it("tokenul de embed e sha256(cheie + id + expirare), cu expirare scurtă, iar cheile nu apar în adresă", async () => {
    const provider = new BunnyDeliveryProvider({ credentials });
    const grant = await provider.createAccess({
      asset: VIDEO,
      mode: "play",
      expiresInSeconds: 300,
      viewerEmail: "client@exemplu.test",
      now: NOW,
    });
    const expires = Math.floor(NOW.getTime() / 1000) + 300;
    const token = createHash("sha256")
      .update(TOKEN_SECRET + "guid-1234567" + expires)
      .digest("hex");
    expect(grant.kind).toBe("embed");
    expect(grant.watermarked).toBe(true);
    expect(grant.expiresAt.getTime()).toBe(expires * 1000);
    const url = new URL(grant.url);
    expect(url.origin + url.pathname).toBe(
      "https://iframe.mediadelivery.net/embed/4242/guid-1234567",
    );
    expect(url.searchParams.get("token")).toBe(token);
    expect(url.searchParams.get("expires")).toBe(String(expires));
    expect(url.searchParams.get("watermark")).toBe("client@exemplu.test");
    expect(grant.url).not.toContain(TOKEN_SECRET);
    expect(grant.url).not.toContain(API_SECRET);
  });

  it("previzualizarea publică nu poartă filigran", async () => {
    const provider = new BunnyDeliveryProvider({ credentials });
    const grant = await provider.createAccess({
      asset: VIDEO,
      mode: "play",
      expiresInSeconds: 60,
      viewerEmail: null,
      now: NOW,
    });
    expect(grant.watermarked).toBe(false);
    expect(new URL(grant.url).searchParams.has("watermark")).toBe(false);
  });

  it("refuză un fișier (nu video) și expirări în afara intervalului", async () => {
    const provider = new BunnyDeliveryProvider({ credentials });
    await expect(
      provider.createAccess({
        asset: { type: "file", storageKey: "k", originalName: null, mimeType: null },
        mode: "download",
        expiresInSeconds: 60,
        viewerEmail: null,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_DELIVERY_REJECTED" });
    await expect(
      provider.createAccess({
        asset: VIDEO,
        mode: "play",
        expiresInSeconds: 86_400,
        viewerEmail: null,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "MEDIA_DELIVERY_INVALID_EXPIRY" });
  });

  it("configurare incompletă: cod stabil", async () => {
    const provider = new BunnyDeliveryProvider({
      credentials: { apiKey: "", libraryId: "4242", tokenAuthKey: "" },
    });
    const error = await provider
      .createAccess({
        asset: VIDEO,
        mode: "play",
        expiresInSeconds: 60,
        viewerEmail: null,
        now: NOW,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as IntegrationError).code).toBe("MEDIA_DELIVERY_NOT_CONFIGURED");
  });

  it("un refuz de autentificare (401) și o cădere de rețea au coduri stabile, fără chei în mesaj", async () => {
    const denied = bunnyFetch(() => ({ status: 401 }));
    const down = new BunnyDeliveryProvider({
      credentials,
      fetch: async () => {
        throw new Error(`conexiune pierdută pentru ${API_SECRET}`);
      },
    });
    const a = await new BunnyDeliveryProvider({ credentials, fetch: denied.fetchLike })
      .status("guid-1234567")
      .catch((e: unknown) => e as IntegrationError);
    expect(a).toMatchObject({ code: "MEDIA_DELIVERY_REJECTED" });
    const b = await down.status("guid-1234567").catch((e: unknown) => e as IntegrationError);
    expect(b).toMatchObject({ code: "MEDIA_DELIVERY_UNREACHABLE" });
    expect(JSON.stringify([(a as Error).message, (b as Error).message])).not.toContain(API_SECRET);
  });

  it("testul de conexiune spune da/nu, fără secrete", async () => {
    const ok = new BunnyDeliveryProvider({
      credentials,
      fetch: bunnyFetch(() => ({ status: 200 })).fetchLike,
    });
    const bad = new BunnyDeliveryProvider({
      credentials,
      fetch: bunnyFetch(() => ({ status: 403 })).fetchLike,
    });
    expect(await ok.testConnection()).toMatchObject({ ok: true });
    const failed = await bad.testConnection();
    expect(failed.ok).toBe(false);
    expect(failed.message).not.toContain(API_SECRET);
  });
});

describe("buildMediaDelivery", () => {
  const { storage } = fakeStorage();
  const base = { platformStorage: storage, credentials: {}, appUrl: "https://app.test" };

  it("local nu cere credențiale", () => {
    expect(buildMediaDelivery({ ...base, code: "local" }).code).toBe("local");
  });

  it("s3 fără credențiale complete aruncă MEDIA_DELIVERY_NOT_CONFIGURED", () => {
    expect(() => buildMediaDelivery({ ...base, code: "s3" })).toThrowError(
      expect.objectContaining({ code: "MEDIA_DELIVERY_NOT_CONFIGURED" }) as Error,
    );
  });

  it("s3 cu credențiale complete se construiește (fără apel de rețea)", () => {
    const provider = buildMediaDelivery({
      ...base,
      code: "s3",
      credentials: {
        endpoint: "https://s3.exemplu.test",
        bucket: "b",
        accessKeyId: "id",
        secretAccessKey: "secret",
      },
    });
    expect(provider.code).toBe("s3");
  });

  it("bunny se construiește din credențiale", () => {
    expect(buildMediaDelivery({ ...base, code: "bunny", credentials }).code).toBe("bunny");
  });
});
