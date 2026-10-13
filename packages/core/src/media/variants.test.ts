import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MediaError } from "./errors";
import { generateVariants, type VariantSettings } from "./variants";

// Lățimi mici ca testele să fie rapide (AVIF e cel mai lent format).
const settings: VariantSettings = {
  thumbWidth: 64,
  mediumWidth: 200,
  largeWidth: 400,
  avifQuality: 50,
  webpQuality: 70,
  jpegQuality: 70,
  maxInputPixels: 40_000_000,
};

const photo = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .jpeg()
    .toBuffer();

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MediaError) return error.code;
    throw error;
  }
  return "OK";
}

describe("generateVariants", () => {
  it("generează thumb/medium/large × AVIF/WebP/JPEG, cu dimensiuni proporționale și blurhash", async () => {
    const out = await generateVariants(await photo(1000, 500), settings);
    expect(out.width).toBe(1000);
    expect(out.height).toBe(500);
    expect(out.variants).toHaveLength(9);

    const byName = (n: string) => out.variants.filter((v) => v.name === n);
    expect(byName("thumb").map((v) => v.width)).toEqual([64, 64, 64]);
    expect(byName("medium").map((v) => v.width)).toEqual([200, 200, 200]);
    expect(byName("large").map((v) => v.width)).toEqual([400, 400, 400]);
    for (const v of out.variants) {
      expect(v.height).toBe(Math.round(v.width / 2)); // 1000×500 → raport 2:1
      expect(v.hash).toMatch(/^[0-9a-f]{8}$/);
      const meta = await sharp(v.buffer).metadata();
      expect(meta.width).toBe(v.width);
      expect(meta.format).toBe(v.format === "avif" ? "heif" : v.format);
    }
    expect(out.variants.map((v) => v.mime).sort()).toEqual(
      [
        ...Array(3).fill("image/avif"),
        ...Array(3).fill("image/jpeg"),
        ...Array(3).fill("image/webp"),
      ].sort(),
    );
    expect(out.blurhash).toMatch(/^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{6,}$/);
  });

  it("nu mărește imaginea: o dimensiune ≥ originalul se generează o singură dată, la mărimea originalului", async () => {
    const out = await generateVariants(await photo(150, 100), settings);
    // thumb 64 < 150; medium (200) ≥ 150 → la 150; large (400) se sare
    expect(new Set(out.variants.map((v) => v.name))).toEqual(new Set(["thumb", "medium"]));
    expect(out.variants).toHaveLength(6);
    for (const v of out.variants) expect(v.width).toBeLessThanOrEqual(150);
    expect(out.variants.filter((v) => v.name === "medium").every((v) => v.width === 150)).toBe(
      true,
    );
  });

  it("o imagine mai mică decât toate țintele dă o singură mărime (3 formate)", async () => {
    const out = await generateVariants(await photo(40, 30), settings);
    expect(out.variants).toHaveLength(3);
    expect(out.variants.every((v) => v.width === 40 && v.name === "thumb")).toBe(true);
  });

  it("JPEG-ul din PNG cu transparență are fundal alb, nu negru", async () => {
    const png = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const out = await generateVariants(png, settings);
    const jpeg = out.variants.find((v) => v.format === "jpeg");
    expect(jpeg).toBeDefined();
    const { data } = await sharp(jpeg!.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240);
    expect(data[1]).toBeGreaterThan(240);
    expect(data[2]).toBeGreaterThan(240);
  });

  it("aplică orientarea EXIF (dimensiunile se inversează)", async () => {
    const rotated = await sharp({
      create: { width: 80, height: 40, channels: 3, background: "#abcdef" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await generateVariants(rotated, settings);
    expect(out.width).toBe(40);
    expect(out.height).toBe(80);
    const first = out.variants[0]!;
    expect(first.width).toBe(40);
    expect(first.height).toBe(80);
  });

  it("respectă lățimile și calitatea din setări", async () => {
    const out = await generateVariants(await photo(1000, 500), {
      ...settings,
      thumbWidth: 100,
      mediumWidth: 300,
      largeWidth: 600,
    });
    expect([...new Set(out.variants.map((v) => v.width))].sort((a, b) => a - b)).toEqual([
      100, 300, 600,
    ]);
  });

  it("limita de pixeli se aplică și la procesare → MEDIA_IMAGE_TOO_BIG", async () => {
    const big = await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer(); // 3 MP, mic pe disc
    expect(await codeOf(generateVariants(big, { ...settings, maxInputPixels: 1_000_000 }))).toBe(
      "MEDIA_IMAGE_TOO_BIG",
    );
    expect(await codeOf(generateVariants(big, settings))).toBe("OK");
  });

  it("o imagine coruptă → MEDIA_CORRUPT", async () => {
    const full = await sharp({
      create: { width: 300, height: 300, channels: 3, background: "#123456" },
    })
      .jpeg({ quality: 100 })
      .toBuffer();
    expect(await codeOf(generateVariants(full.subarray(0, 60), settings))).toBe("MEDIA_CORRUPT");
    expect(await codeOf(generateVariants(Buffer.from("nu e imagine"), settings))).toBe(
      "MEDIA_CORRUPT",
    );
  });
});
