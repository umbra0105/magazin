import { describe, expect, it } from "vitest";
import type { StorageDriver } from "@ecom/integrations";
import { pickBestVariantImage, pickVariantImage } from "./urls";

/** Driver minim: doar `publicUrl` contează pentru alegerea variantei. */
const storage = {
  publicUrl: (key: string) => `https://cdn.test/${key}`,
} as unknown as StorageDriver;

const variant = (name: string, format: string, width: number) => ({
  name,
  format,
  mime: `image/${format}`,
  key: `m/${name}.${format}`,
  width,
  height: width / 2,
  sizeBytes: 1,
});
const source = (variants: unknown) => ({
  storageKey: "m/original.jpg",
  width: 1600,
  height: 800,
  blurhash: null,
  variants,
});

describe("pickVariantImage", () => {
  it("alege varianta cerută, cu preferința WebP, apoi JPEG, apoi AVIF", () => {
    const all = [
      variant("medium", "avif", 800),
      variant("medium", "jpeg", 800),
      variant("medium", "webp", 800),
      variant("thumb", "webp", 320),
    ];
    expect(pickVariantImage(source(all), storage, "medium")).toEqual({
      url: "https://cdn.test/m/medium.webp",
      width: 800,
      height: 400,
    });
    expect(
      pickVariantImage(source(all.filter((v) => v.format !== "webp")), storage, "medium")?.url,
    ).toBe("https://cdn.test/m/medium.jpeg");
    expect(pickVariantImage(source([variant("medium", "avif", 800)]), storage, "medium")?.url).toBe(
      "https://cdn.test/m/medium.avif",
    );
  });

  it("întoarce null când varianta cerută nu există (încă neprocesată): nu se folosește originalul", () => {
    expect(pickVariantImage(source([variant("thumb", "webp", 320)]), storage, "large")).toBeNull();
    expect(pickVariantImage(source([]), storage, "medium")).toBeNull();
    expect(pickVariantImage(source("nu-e-lista"), storage, "medium")).toBeNull();
  });
});

describe("pickBestVariantImage (imagini mici: fără variantă «large»)", () => {
  // Pipeline-ul nu mărește imaginile: un original de 600 px sau mai mic are doar «thumb» și «medium» (cazul real din baza de dezvoltare)
  const small = [variant("thumb", "webp", 320), variant("medium", "webp", 600)];

  it("când varianta cerută lipsește, cade pe cea mai apropiată disponibilă (large → medium → thumb)", () => {
    expect(pickBestVariantImage(source(small), storage, "large")?.url).toBe(
      "https://cdn.test/m/medium.webp",
    );
    expect(
      pickBestVariantImage(source([variant("thumb", "webp", 320)]), storage, "large")?.url,
    ).toBe("https://cdn.test/m/thumb.webp");
  });

  it("varianta cerută are prioritate când există", () => {
    const all = [...small, variant("large", "webp", 1200)];
    expect(pickBestVariantImage(source(all), storage, "large")?.url).toBe(
      "https://cdn.test/m/large.webp",
    );
    expect(pickBestVariantImage(source(all), storage, "medium")?.url).toBe(
      "https://cdn.test/m/medium.webp",
    );
    expect(pickBestVariantImage(source(all), storage, "thumb")?.url).toBe(
      "https://cdn.test/m/thumb.webp",
    );
  });

  it("fără nicio variantă procesată: null (niciodată originalul)", () => {
    expect(pickBestVariantImage(source([]), storage, "large")).toBeNull();
  });
});
