import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MediaError } from "./errors";
import { sanitizeImage, type ImageLimits } from "./image";

const limits: ImageLimits = {
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/avif"],
  maxInputPixels: 40_000_000,
};

const raw = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#3366aa" } });

const jpeg = (width = 64, height = 48) => raw(width, height).jpeg().toBuffer();

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MediaError) return error.code;
    throw error;
  }
  return "OK";
}

describe("sanitizeImage: tipuri acceptate", () => {
  it.each([
    ["JPEG", () => raw(40, 30).jpeg().toBuffer(), "image/jpeg", "jpg"],
    ["PNG", () => raw(40, 30).png().toBuffer(), "image/png", "png"],
    ["WebP", () => raw(40, 30).webp().toBuffer(), "image/webp", "webp"],
    ["AVIF", () => raw(40, 30).avif({ effort: 0 }).toBuffer(), "image/avif", "avif"],
  ] as const)(
    "%s: tipul vine din conținut, cu dimensiuni și sumă de control",
    async (_n, make, mime, ext) => {
      const out = await sanitizeImage(await make(), limits);
      expect(out.mime).toBe(mime);
      expect(out.extension).toBe(ext);
      expect(out.width).toBe(40);
      expect(out.height).toBe(30);
      expect(out.checksum).toMatch(/^[0-9a-f]{64}$/);
      // rezultatul e o imagine validă de același tip
      expect((await sharp(out.buffer).metadata()).width).toBe(40);
    },
  );
});

describe("sanitizeImage: tipuri respinse (după conținut, nu după nume)", () => {
  it("GIF, SVG, HTML, text și octeți aleatorii → MEDIA_UNSUPPORTED_TYPE", async () => {
    const gif = await raw(10, 10).gif().toBuffer();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    const text = Buffer.from("nu sunt o imagine");
    const random = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37 + 11) % 251));
    for (const bytes of [gif, svg, html, text, random]) {
      expect(await codeOf(sanitizeImage(bytes, limits))).toBe("MEDIA_UNSUPPORTED_TYPE");
    }
  });

  it("un tip suportat, dar scos din setări, e respins", async () => {
    const only = { ...limits, allowedMimeTypes: ["image/png"] };
    expect(await codeOf(sanitizeImage(await jpeg(), only))).toBe("MEDIA_UNSUPPORTED_TYPE");
    expect(await codeOf(sanitizeImage(await raw(8, 8).png().toBuffer(), only))).toBe("OK");
  });

  it("fișier gol → MEDIA_EMPTY", async () => {
    expect(await codeOf(sanitizeImage(Buffer.alloc(0), limits))).toBe("MEDIA_EMPTY");
  });

  it("JPEG trunchiat sau cu antet bun și corp stricat → MEDIA_CORRUPT", async () => {
    const full = await raw(300, 300).jpeg({ quality: 100 }).toBuffer();
    expect(await codeOf(sanitizeImage(full.subarray(0, 40), limits))).toBe("MEDIA_CORRUPT");
    const broken = Buffer.concat([full.subarray(0, 200), Buffer.alloc(300, 0xff)]);
    expect(await codeOf(sanitizeImage(broken, limits))).toBe("MEDIA_CORRUPT");
  });
});

describe("sanitizeImage: limita de pixeli", () => {
  it("o imagine peste limită e refuzată din antet, cu MEDIA_IMAGE_TOO_BIG", async () => {
    const big = await raw(2000, 1500).png().toBuffer(); // 3 MP, mic pe disc
    const small = { ...limits, maxInputPixels: 1_000_000 };
    expect(await codeOf(sanitizeImage(big, small))).toBe("MEDIA_IMAGE_TOO_BIG");
  });

  it("exact la limită trece", async () => {
    const exact = await raw(1000, 1000).png().toBuffer();
    expect(await codeOf(sanitizeImage(exact, { ...limits, maxInputPixels: 1_000_000 }))).toBe("OK");
  });
});

describe("sanitizeImage: curățare", () => {
  it("scoate EXIF-ul (inclusiv textul din el) din JPEG", async () => {
    const withExif = await raw(64, 48)
      .jpeg()
      .withExif({ IFD0: { Copyright: "PROPRIETAR-SECRET-GPS", Artist: "Ion Popescu" } })
      .toBuffer();
    expect(withExif.includes("PROPRIETAR-SECRET-GPS")).toBe(true); // dovada că intrarea chiar îl are

    const out = await sanitizeImage(withExif, limits);
    expect(out.buffer.includes("PROPRIETAR-SECRET-GPS")).toBe(false);
    expect(out.buffer.includes("Ion Popescu")).toBe(false);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
  });

  it("aplică orientarea EXIF și scoate eticheta", async () => {
    const rotated = await raw(40, 20).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(rotated).metadata()).orientation).toBe(6);

    const out = await sanitizeImage(rotated, limits);
    expect(out.width).toBe(20);
    expect(out.height).toBe(40);
    expect((await sharp(out.buffer).metadata()).orientation).toBeUndefined();
  });

  it("neutralizează conținutul „poliglot”: HTML lipit după o imagine validă dispare", async () => {
    const polyglot = Buffer.concat([
      await jpeg(),
      Buffer.from("<html><script>alert('xss')</script></html>"),
    ]);
    const out = await sanitizeImage(polyglot, limits);
    expect(out.buffer.includes("<script>")).toBe(false);
    expect(out.mime).toBe("image/jpeg");
  });

  it("suma de control corespunde octeților curățați", async () => {
    const { createHash } = await import("node:crypto");
    const out = await sanitizeImage(await jpeg(), limits);
    expect(out.checksum).toBe(createHash("sha256").update(out.buffer).digest("hex"));
  });
});
