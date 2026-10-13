const cache = new Map<string, string>();
const MAX_CACHE = 1000;

/**
 * Placeholder pentru grid: din blurhash, un PNG de 16×16 px ca `data:` URI (sub 1 KB), calculat pe
 * server. Browserul îl întinde peste cardul imaginii cât timp se încarcă thumb-ul. Evită să
 * trimitem bibliotecă de decodare în browser și nu atinge niciodată originalul.
 */
export async function blurhashToDataUrl(blurhash: string | null): Promise<string | null> {
  if (!blurhash) return null;
  const cached = cache.get(blurhash);
  if (cached) return cached;
  try {
    const [{ decode }, { default: sharp }] = await Promise.all([
      import("blurhash"),
      import("sharp"),
    ]);
    const size = 16;
    const pixels = decode(blurhash, size, size);
    const png = await sharp(Buffer.from(pixels), {
      raw: { width: size, height: size, channels: 4 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const url = `data:image/png;base64,${png.toString("base64")}`;
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
    cache.set(blurhash, url);
    return url;
  } catch {
    // blurhash invalid sau modul nativ indisponibil: fără placeholder, nu cade pagina
    return null;
  }
}
