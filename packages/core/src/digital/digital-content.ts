import type { MediaDeliveryDriverCode, MediaDeliveryProvider } from "@ecom/shared";
import { inTx, type Db } from "../db-tx";
import { DigitalError } from "./digital-errors";
import { readDigitalSettings } from "./digital-settings";

/**
 * Conținutul digital al unui produs (tabul «Conținut digital» din editor, Faza 14b): extensia 1:1 a produsului, modulele (fișiere,
 * videoclipuri, legături), ordinea lor, lecția de preview. Doar produsele de tip `digital` au conținut. Auditul îl scrie acțiunea de
 * server care apelează aceste funcții (actorul, acțiunea, produsul, numele câmpurilor; niciodată cheile de stocare).
 *
 * ⚠️ `storageKey` nu iese de aici: DTO-urile admin au furnizorul (cod, nu secret) și numele original, nu cheia.
 */
export const DELIVERY_TYPES = ["download", "stream", "external_link"] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

export const DIGITAL_TITLE_MAX = 200;
export const DIGITAL_TEXT_MAX = 2000;

/** Extensii refuzate: conținutul se livrează ca descărcare, dar un fișier activ (pagină, script, executabil) nu are ce căuta aici. */
const FORBIDDEN_EXTENSIONS = new Set([
  "html",
  "htm",
  "xhtml",
  "svg",
  "js",
  "mjs",
  "exe",
  "dll",
  "bat",
  "cmd",
  "com",
  "msi",
  "scr",
  "ps1",
  "sh",
  "jar",
  "php",
  "vbs",
]);

export interface DigitalProductDto {
  productId: string;
  deliveryType: DeliveryType;
  accessType: "lifetime" | "limited_days";
  maxDownloads: number | null;
  whatYouGet: string | null;
  requirements: string | null;
  format: string | null;
}

export interface AdminAssetDto {
  id: string;
  title: string;
  type: "video" | "file" | "link";
  provider: MediaDeliveryDriverCode | null;
  originalName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  durationSeconds: number | null;
  position: number;
  isPreview: boolean;
  status: "processing" | "ready" | "failed";
  externalUrl: string | null;
}

export interface DigitalContentDto {
  product: { id: string; title: string; type: string };
  digital: DigitalProductDto | null;
  assets: AdminAssetDto[];
}

const clean = (text: string | null | undefined, max: number): string | null => {
  const value = (text ?? "").trim();
  if (value === "") return null;
  if (value.length > max) {
    throw new DigitalError("DIGITAL_INPUT_INVALID", `Textul are cel mult ${max} de caractere`);
  }
  return value;
};

function title(text: string): string {
  const value = text.trim();
  if (value.length === 0 || value.length > DIGITAL_TITLE_MAX) {
    throw new DigitalError(
      "DIGITAL_INPUT_INVALID",
      `Titlul modulului are între 1 și ${DIGITAL_TITLE_MAX} de caractere`,
    );
  }
  return value;
}

async function digitalProduct(db: Db, productId: string) {
  const product = await db.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: { id: true, title: true, type: true },
  });
  if (!product) throw new DigitalError("DIGITAL_NOT_FOUND", "Produsul nu există");
  if (product.type !== "digital") {
    throw new DigitalError(
      "DIGITAL_NOT_DIGITAL_PRODUCT",
      "Doar produsele de tip «digital» au conținut digital",
    );
  }
  return product;
}

function toAsset(row: {
  id: string;
  title: string;
  type: string;
  provider: string | null;
  originalName: string | null;
  mimeType: string | null;
  fileSize: bigint | null;
  durationSeconds: number | null;
  position: number;
  isPreview: boolean;
  status: string;
  externalUrl: string | null;
}): AdminAssetDto {
  return {
    id: row.id,
    title: row.title,
    type: row.type as AdminAssetDto["type"],
    provider: row.provider as MediaDeliveryDriverCode | null,
    originalName: row.originalName,
    mimeType: row.mimeType,
    fileSize: row.fileSize === null ? null : Number(row.fileSize),
    durationSeconds: row.durationSeconds,
    position: row.position,
    isPreview: row.isPreview,
    status: row.status as AdminAssetDto["status"],
    externalUrl: row.externalUrl,
  };
}

/** Conținutul digital al unui produs, pentru editor. Produsele fizice dau `digital: null` și nicio listă. */
export async function getDigitalContent(db: Db, productId: string): Promise<DigitalContentDto> {
  const product = await db.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: {
      id: true,
      title: true,
      type: true,
      digital: {
        select: {
          deliveryType: true,
          accessType: true,
          maxDownloads: true,
          whatYouGet: true,
          requirements: true,
          format: true,
          assets: {
            orderBy: [{ position: "asc" }, { id: "asc" }],
            select: {
              id: true,
              title: true,
              type: true,
              provider: true,
              originalName: true,
              mimeType: true,
              fileSize: true,
              durationSeconds: true,
              position: true,
              isPreview: true,
              status: true,
              externalUrl: true,
            },
          },
        },
      },
    },
  });
  if (!product) throw new DigitalError("DIGITAL_NOT_FOUND", "Produsul nu există");
  return {
    product: { id: product.id, title: product.title, type: product.type },
    digital: product.digital
      ? {
          productId: product.id,
          deliveryType: product.digital.deliveryType as DeliveryType,
          accessType: product.digital.accessType as DigitalProductDto["accessType"],
          maxDownloads: product.digital.maxDownloads,
          whatYouGet: product.digital.whatYouGet,
          requirements: product.digital.requirements,
          format: product.digital.format,
        }
      : null,
    assets: (product.digital?.assets ?? []).map(toAsset),
  };
}

export interface DigitalSettingsInput {
  deliveryType: DeliveryType;
  /** Gol/`null` = nelimitat. */
  maxDownloads: number | null;
  whatYouGet?: string | null;
  requirements?: string | null;
  format?: string | null;
}

/** Creează sau actualizează extensia digitală (acces pe viață, cu cont mereu obligatoriu). Întoarce câmpurile schimbate. */
export async function saveDigitalSettings(
  db: Db,
  productId: string,
  input: DigitalSettingsInput,
): Promise<{ created: boolean; changed: string[] }> {
  await digitalProduct(db, productId);
  if (!DELIVERY_TYPES.includes(input.deliveryType)) {
    throw new DigitalError("DIGITAL_INPUT_INVALID", "Tipul de livrare nu este valid");
  }
  if (
    input.maxDownloads !== null &&
    (!Number.isInteger(input.maxDownloads) ||
      input.maxDownloads < 1 ||
      input.maxDownloads > 100_000)
  ) {
    throw new DigitalError(
      "DIGITAL_INPUT_INVALID",
      "Limita de descărcări e un număr între 1 și 100.000 (gol = nelimitat)",
    );
  }
  const data = {
    deliveryType: input.deliveryType,
    maxDownloads: input.maxDownloads,
    whatYouGet: clean(input.whatYouGet, DIGITAL_TEXT_MAX),
    requirements: clean(input.requirements, DIGITAL_TEXT_MAX),
    format: clean(input.format, 200),
  };
  return inTx(db, async (tx) => {
    const before = await tx.digitalProduct.findUnique({ where: { productId } });
    if (!before) {
      await tx.digitalProduct.create({ data: { productId, ...data } });
      return { created: true, changed: Object.keys(data) };
    }
    const changed = (Object.keys(data) as Array<keyof typeof data>).filter(
      (key) => before[key] !== data[key],
    );
    if (changed.length > 0) await tx.digitalProduct.update({ where: { productId }, data });
    return { created: false, changed };
  });
}

async function ensureExtension(tx: Db, productId: string): Promise<void> {
  await digitalProduct(tx, productId);
  await tx.digitalProduct.createMany({ data: [{ productId }], skipDuplicates: true });
}

const nextPosition = async (tx: Db, productId: string): Promise<number> => {
  const last = await tx.digitalAsset.aggregate({ where: { productId }, _max: { position: true } });
  return (last._max.position ?? -1) + 1;
};

export interface ContentDeps {
  db: Db;
  /** Driverul unui cod (cu garda de activare/confirmare); `local` mereu disponibil. */
  getProvider: (code: MediaDeliveryDriverCode) => Promise<MediaDeliveryProvider>;
}

export interface UploadInput {
  title: string;
  fileName: string;
  mimeType: string;
  body: Buffer;
  isPreview: boolean;
}

const extensionOf = (name: string): string =>
  /\.([A-Za-z0-9]{1,8})$/.exec(name.trim())?.[1]?.toLowerCase() ?? "";

/** Tipul modulului după tipul fișierului: video dacă e `video/*`, altfel fișier. */
export const assetTypeFor = (mimeType: string): "video" | "file" =>
  mimeType.toLowerCase().startsWith("video/") ? "video" : "file";

/**
 * Încarcă un modul: alege furnizorul din setări (video → `digital.videoProvider`, fișier → `digital.fileProvider`), refuză
 * fișierele peste limita din setări sau cu extensie activă, stochează conținutul și scrie rândul. La Bunny rândul rămâne
 * «în procesare» până răspunde starea transcodării (`refreshAssetStatus`).
 */
export async function addUploadedAsset(
  deps: ContentDeps,
  productId: string,
  input: UploadInput,
): Promise<AdminAssetDto> {
  await digitalProduct(deps.db, productId);
  const name = input.title.trim() === "" ? input.fileName : input.title;
  const assetTitle = title(name.replace(/\.[A-Za-z0-9]{1,8}$/, "") || name);
  if (FORBIDDEN_EXTENSIONS.has(extensionOf(input.fileName))) {
    throw new DigitalError(
      "DIGITAL_UPLOAD_REFUSED",
      "Acest tip de fișier nu se poate încărca ca produs digital",
    );
  }
  const settings = await readDigitalSettings(deps.db);
  if (input.body.length === 0) {
    throw new DigitalError("DIGITAL_UPLOAD_REFUSED", "Fișierul este gol");
  }
  if (input.body.length > settings.maxUploadMb * 1024 * 1024) {
    throw new DigitalError(
      "DIGITAL_UPLOAD_REFUSED",
      `Fișierul depășește limita de ${settings.maxUploadMb} MB din setări`,
    );
  }
  const type = assetTypeFor(input.mimeType);
  const code: MediaDeliveryDriverCode =
    type === "video" ? settings.videoProvider : settings.fileProvider;
  const provider = await deps.getProvider(code);
  const stored = await provider.store({
    type,
    body: input.body,
    fileName: input.fileName,
    mimeType: input.mimeType,
  });
  try {
    return await inTx(deps.db, async (tx) => {
      await ensureExtension(tx, productId);
      const row = await tx.digitalAsset.create({
        data: {
          productId,
          title: assetTitle,
          type,
          provider: code,
          storageKey: stored.storageKey,
          originalName: input.fileName.slice(0, 200),
          mimeType: input.mimeType.slice(0, 100),
          fileSize: BigInt(stored.fileSize),
          durationSeconds: stored.durationSeconds,
          position: await nextPosition(tx, productId),
          isPreview: input.isPreview,
          status: stored.status,
        },
      });
      return toAsset(row);
    });
  } catch (error) {
    // rândul nu s-a scris: conținutul stocat ar rămâne orfan
    await provider.remove(stored.storageKey).catch(() => undefined);
    throw error;
  }
}

/** O legătură externă (https), pentru conținut găzduit în altă parte; se arată doar clienților cu drept de acces. */
export async function addLinkAsset(
  db: Db,
  productId: string,
  input: { title: string; url: string; isPreview: boolean },
): Promise<AdminAssetDto> {
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new DigitalError("DIGITAL_INPUT_INVALID", "Adresa nu este validă");
  }
  if (url.protocol !== "https:") {
    throw new DigitalError("DIGITAL_INPUT_INVALID", "Adresa trebuie să înceapă cu https://");
  }
  const assetTitle = title(input.title);
  return inTx(db, async (tx) => {
    await ensureExtension(tx, productId);
    const row = await tx.digitalAsset.create({
      data: {
        productId,
        title: assetTitle,
        type: "link",
        externalUrl: url.toString(),
        position: await nextPosition(tx, productId),
        isPreview: input.isPreview,
        status: "ready",
      },
    });
    return toAsset(row);
  });
}

export async function updateAsset(
  db: Db,
  productId: string,
  assetId: string,
  input: { title?: string; isPreview?: boolean },
): Promise<string[]> {
  const data: { title?: string; isPreview?: boolean } = {};
  if (input.title !== undefined) data.title = title(input.title);
  if (input.isPreview !== undefined) data.isPreview = input.isPreview;
  const result = await db.digitalAsset.updateMany({ where: { id: assetId, productId }, data });
  if (result.count === 0) throw new DigitalError("DIGITAL_NOT_FOUND", "Modulul nu există");
  return Object.keys(data);
}

/** Ordinea modulelor: lista completă de id-uri a produsului, în ordinea nouă (orice id lipsă sau în plus e refuzat). */
export async function reorderAssets(
  db: Db,
  productId: string,
  orderedIds: readonly string[],
): Promise<void> {
  await inTx(db, async (tx) => {
    const current = await tx.digitalAsset.findMany({ where: { productId }, select: { id: true } });
    const same =
      current.length === orderedIds.length &&
      new Set(orderedIds).size === orderedIds.length &&
      current.every((row) => orderedIds.includes(row.id));
    if (!same) {
      throw new DigitalError(
        "DIGITAL_INPUT_INVALID",
        "Lista de module nu mai e cea curentă: reîncarcă pagina",
      );
    }
    for (const [index, id] of orderedIds.entries()) {
      await tx.digitalAsset.update({ where: { id }, data: { position: index } });
    }
  });
}

/** Șterge un modul și, după aceea, conținutul lui din stocare (o eroare la ștergerea conținutului nu readuce rândul). */
export async function deleteAsset(
  deps: ContentDeps,
  productId: string,
  assetId: string,
): Promise<{ removedContent: boolean }> {
  const asset = await deps.db.digitalAsset.findFirst({
    where: { id: assetId, productId },
    select: { provider: true, storageKey: true },
  });
  if (!asset) throw new DigitalError("DIGITAL_NOT_FOUND", "Modulul nu există");
  await deps.db.digitalAsset.delete({ where: { id: assetId } });
  if (!asset.storageKey || !asset.provider) return { removedContent: false };
  try {
    const provider = await deps.getProvider(asset.provider as MediaDeliveryDriverCode);
    await provider.remove(asset.storageKey);
    return { removedContent: true };
  } catch {
    return { removedContent: false };
  }
}

/** Reîmprospătează starea unui modul aflat «în procesare» (transcodarea Bunny). */
export async function refreshAssetStatus(
  deps: ContentDeps,
  productId: string,
  assetId: string,
): Promise<"processing" | "ready" | "failed"> {
  const asset = await deps.db.digitalAsset.findFirst({
    where: { id: assetId, productId },
    select: { provider: true, storageKey: true, status: true },
  });
  if (!asset) throw new DigitalError("DIGITAL_NOT_FOUND", "Modulul nu există");
  if (asset.status !== "processing" || !asset.provider || !asset.storageKey) {
    return asset.status as "processing" | "ready" | "failed";
  }
  const provider = await deps.getProvider(asset.provider as MediaDeliveryDriverCode);
  const next = await provider.status(asset.storageKey);
  if (next !== "processing") {
    await deps.db.digitalAsset.update({ where: { id: assetId }, data: { status: next } });
  }
  return next;
}
