import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { buildMediaUrls } from "./urls";
import { serveSignedObject, servePublicObject } from "./serve";

const signingKey = deriveSigningKey(Buffer.alloc(32, 4).toString("base64"));
let base: string;
let storage: LocalStorageDriver;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "ecom-serve-"));
  storage = new LocalStorageDriver({
    rootDir: join(base, "root"),
    appUrl: "https://magazin.test",
    signingKey,
  });
  await storage.put("public/media/abc/thumb.1234abcd.jpg", JPEG, { contentType: "image/jpeg" });
  await storage.put("public/media/abc/script.html", Buffer.from("<script>1</script>"), {
    contentType: "text/html",
  });
  await storage.put("private/digital/curs.pdf", Buffer.from("%PDF-secret"), {
    contentType: "application/pdf",
  });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const params = (query: Record<string, string>) => new URLSearchParams(query);
const bytes = async (r: Response) => Buffer.from(await r.arrayBuffer());

describe("/media (public)", () => {
  it("servește imaginea cu Content-Type corect, nosniff și cache imutabil", async () => {
    const res = await servePublicObject(storage, ["media", "abc", "thumb.1234abcd.jpg"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-length")).toBe(String(JPEG.length));
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect((await bytes(res)).equals(JPEG)).toBe(true);
  });

  it("nu servește un tip care nu e imagine, chiar dacă e sub public/ (404)", async () => {
    const res = await servePublicObject(storage, ["media", "abc", "script.html"]);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("fișierul privat nu se poate cere pe /media, în nicio formă", async () => {
    const attempts: string[][] = [
      ["private", "digital", "curs.pdf"], // → public/private/digital/curs.pdf: nu există
      ["..", "private", "digital", "curs.pdf"],
      ["media", "..", "..", "private", "digital", "curs.pdf"],
      ["%2e%2e", "private", "digital", "curs.pdf"],
      [".", "..", "private", "digital", "curs.pdf"],
      ["media\\..\\..\\private\\digital\\curs.pdf"],
    ];
    for (const segments of attempts) {
      const res = await servePublicObject(storage, segments);
      expect(res.status, segments.join("/")).toBe(404);
      expect((await bytes(res)).includes("%PDF-secret")).toBe(false);
    }
  });

  it.each([
    [[]],
    [[""]],
    [["media", "", "x"]],
    [["media", "a\0b.jpg"]],
    [["media", "a%00b.jpg"]],
    [["media", "x.jpg.meta.json"]],
    [["media", "con"]],
    [["media", "a".repeat(600)]],
    [["media", "a b.jpg"]],
    [["media", "ș.jpg"]],
  ])("cheie periculoasă %j → 404", async (segments) => {
    const res = await servePublicObject(storage, segments);
    expect(res.status).toBe(404);
  });

  it("obiect inexistent → 404", async () => {
    expect((await servePublicObject(storage, ["media", "nu", "exista.jpg"])).status).toBe(404);
  });
});

describe("/storage/signed (privat)", () => {
  const key = "private/digital/curs.pdf";
  const segments = key.split("/");

  async function signed(extra: { dl?: string; expiresInSeconds?: number } = {}) {
    const url = new URL(
      await storage.signedUrl(key, {
        expiresInSeconds: extra.expiresInSeconds ?? 60,
        ...(extra.dl ? { downloadFilename: extra.dl } : {}),
      }),
    );
    return url.searchParams;
  }

  it("cu semnătură validă: 200, no-store, nosniff, descărcare cu nume", async () => {
    const q = await signed({ dl: "Curs piscine.pdf" });
    const res = await serveSignedObject(storage, segments, q, { signingKey });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect((await bytes(res)).toString()).toBe("%PDF-secret");
  });

  it("fără semnătură, fără expirare sau cu valori goale: 403, fără acces la conținut", async () => {
    const queries = [
      params({}),
      params({ exp: "9999999999" }),
      params({ sig: "x" }),
      params({ exp: "abc", sig: "x" }),
    ];
    for (const q of queries) {
      const res = await serveSignedObject(storage, segments, q, { signingKey });
      expect(res.status).toBe(403);
      expect((await bytes(res)).includes("%PDF")).toBe(false);
    }
  });

  it("semnătură modificată, cheie schimbată, expirare prelungită sau nume schimbat: 403", async () => {
    const q = await signed({ dl: "a.pdf" });
    const tweak = (patch: Record<string, string>) => {
      const c = new URLSearchParams(q);
      for (const [k, v] of Object.entries(patch)) c.set(k, v);
      return c;
    };
    const sig = q.get("sig") ?? "";
    const cases: [string[], URLSearchParams][] = [
      [segments, tweak({ sig: `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}` })],
      [segments, tweak({ exp: String(Number(q.get("exp")) + 3600) })],
      [segments, tweak({ dl: "alt.pdf" })],
      [["private", "digital", "altceva.pdf"], q],
      [["public", "media", "abc", "thumb.1234abcd.jpg"], q], // semnătura unei chei nu valorează pentru alta
    ];
    for (const [segs, query] of cases) {
      const res = await serveSignedObject(storage, segs, query, { signingKey });
      expect(res.status, segs.join("/")).toBe(403);
    }
  });

  it("semnătură expirată: 403", async () => {
    const q = await signed({ expiresInSeconds: 10 });
    const res = await serveSignedObject(storage, segments, q, {
      signingKey,
      now: () => (Number(q.get("exp")) + 1) * 1000,
    });
    expect(res.status).toBe(403);
  });

  it("o semnătură făcută cu altă cheie (altă instalare) nu trece", async () => {
    const q = await signed();
    const other = deriveSigningKey(Buffer.alloc(32, 99).toString("base64"));
    expect((await serveSignedObject(storage, segments, q, { signingKey: other })).status).toBe(403);
  });

  it("chei periculoase nu trec de validarea cheii, chiar cu o semnătură existentă", async () => {
    const bad = [
      ["..", "etc", "passwd"],
      ["private", "..", "..", "x"],
      ["private", "a\\b"],
    ];
    for (const segs of bad) {
      const res = await serveSignedObject(storage, segs, await signed(), { signingKey });
      expect(res.status).toBe(403);
    }
  });
});

describe("buildMediaUrls", () => {
  it("construiește URL-urile prin driver și srcset pe format, sortat după lățime", () => {
    const variant = (name: string, format: string, mime: string, tail: string, width: number) => ({
      name,
      format,
      mime,
      key: `public/media/abc/${tail}`,
      width,
      height: width / 2,
      sizeBytes: 1,
    });
    const urls = buildMediaUrls(
      {
        storageKey: "public/media/abc/original.jpg",
        width: 800,
        height: 400,
        blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
        variants: [
          variant("large", "avif", "image/avif", "large.aa.avif", 800),
          variant("thumb", "avif", "image/avif", "thumb.bb.avif", 320),
          variant("thumb", "jpeg", "image/jpeg", "thumb.cc.jpg", 320),
        ],
      },
      storage,
    );
    expect(urls.original).toBe("https://magazin.test/media/media/abc/original.jpg");
    expect(urls.srcset["avif"]).toBe(
      "https://magazin.test/media/media/abc/thumb.bb.avif 320w, https://magazin.test/media/media/abc/large.aa.avif 800w",
    );
    expect(urls.srcset["jpeg"]).toBe("https://magazin.test/media/media/abc/thumb.cc.jpg 320w");
    expect(urls.blurhash).toBe("LEHV6nWB2yk8pyo0adR*.7kCMdnj");
    expect(urls.variants.map((v) => v.width)).toEqual([320, 320, 800]);
  });

  it("fără variante (încă pending): doar originalul, srcset gol", () => {
    const urls = buildMediaUrls(
      {
        storageKey: "public/media/x/original.png",
        width: null,
        height: null,
        blurhash: null,
        variants: [],
      },
      storage,
    );
    expect(urls.variants).toEqual([]);
    expect(urls.srcset).toEqual({});
  });
});
