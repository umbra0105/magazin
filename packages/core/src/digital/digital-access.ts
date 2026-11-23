import {
  IntegrationError,
  type AccessGrant,
  type DeliveryAssetRef,
  type MediaDeliveryDriverCode,
  type MediaDeliveryProvider,
} from "@ecom/shared";
import { inTx, type Db } from "../db-tx";
import { notifyAdmins, orderContext } from "../notifications/admin-notifications";
import { DigitalError } from "./digital-errors";
import { isIpAnomaly, isValidAccessToken } from "./digital-rules";

/**
 * Accesul clientului la conținutul digital (Faza 14b): biblioteca lui, detaliul unui drept de acces și EMITEREA linkurilor de acces.
 *
 * Reguli de securitate (toate pe server, toate testate):
 *  - proprietatea se verifică în ACEEAȘI interogare care caută dreptul (`customerId = clientul curent`): un jeton străin și un jeton
 *    inexistent dau același `DIGITAL_NOT_FOUND`; clientul A nu află nimic despre dreptul clientului B;
 *  - un drept revocat sau expirat nu mai dă linkuri; un modul din ALT produs decât al dreptului nu se poate cere;
 *  - linkul e creat la cerere, cu expirare scurtă din setare, de driverul modulului; nu se salvează nicăieri;
 *  - contorul de descărcări crește printr-un UPDATE condiționat (limita e atomică: două cereri simultane pe ultima unitate, una
 *    reușește), în aceeași tranzacție cu rândul din jurnal;
 *  - `storageKey`, credențialele și furnizorul nu apar în nicio structură întoarsă de aici (interogările selectează câmpuri explicit).
 */
export interface AccessSettings {
  linkSeconds: number;
  maxIpsPerEntitlement: number;
  ipWindowHours: number;
}

export interface AccessDeps {
  db: Db;
  readSettings: () => Promise<AccessSettings>;
  /** Driverul unui furnizor, deja verificat (cont configurat, activ, confirmat de Owner la furnizorii reali). */
  getProvider: (code: MediaDeliveryDriverCode) => Promise<MediaDeliveryProvider>;
  now?: () => Date;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

const clip = (value: string | null, max: number): string | null =>
  value === null || value === "" ? null : value.slice(0, max);

export interface AssetDto {
  id: string;
  title: string;
  type: "video" | "file" | "link";
  mimeType: string | null;
  fileSize: number | null;
  durationSeconds: number | null;
  position: number;
  isPreview: boolean;
  status: "processing" | "ready" | "failed";
}

export interface LibraryItemDto {
  token: string;
  productTitle: string;
  productSlug: string;
  orderNumber: string;
  grantedAt: Date;
  status: "active" | "revoked";
  revokedReason: string | null;
  downloadCount: number;
  maxDownloads: number | null;
  /** Câte descărcări au mai rămas; `null` = nelimitat. */
  remainingDownloads: number | null;
  moduleCount: number;
}

export interface PendingItemDto {
  productTitle: string;
  orderNumber: string;
  /** Ce se așteaptă: plata (card, transfer) sau livrarea coletului (ramburs mixt). */
  awaiting: "payment" | "delivery";
}

export interface LibraryDto {
  items: LibraryItemDto[];
  pending: PendingItemDto[];
}

export interface EntitlementDetailDto extends LibraryItemDto {
  assets: AssetDto[];
}

const DOWNLOADABLE: ReadonlySet<string> = new Set(["file"]);

const toNumber = (value: bigint | null): number | null => (value === null ? null : Number(value));

function toAssetDto(row: {
  id: string;
  title: string;
  type: string;
  mimeType: string | null;
  fileSize: bigint | null;
  durationSeconds: number | null;
  position: number;
  isPreview: boolean;
  status: string;
}): AssetDto {
  return {
    id: row.id,
    title: row.title,
    type: row.type as AssetDto["type"],
    mimeType: row.mimeType,
    fileSize: toNumber(row.fileSize),
    durationSeconds: row.durationSeconds,
    position: row.position,
    isPreview: row.isPreview,
    status: row.status as AssetDto["status"],
  };
}

const remaining = (count: number, max: number | null): number | null =>
  max === null ? null : Math.max(0, max - count);

/** Biblioteca clientului: drepturile lui, plus liniile digitale așteptate (plată sau livrare). */
export async function listLibrary(db: Db, userId: string): Promise<LibraryDto> {
  const rows = await db.digitalEntitlement.findMany({
    where: { customerId: userId },
    orderBy: [{ grantedAt: "desc" }, { id: "asc" }],
    select: {
      accessToken: true,
      grantedAt: true,
      revokedAt: true,
      revokedReason: true,
      downloadCount: true,
      maxDownloads: true,
      order: { select: { number: true } },
      product: {
        select: {
          title: true,
          slug: true,
          digital: { select: { _count: { select: { assets: true } } } },
        },
      },
    },
  });
  const items: LibraryItemDto[] = rows.map((row) => ({
    token: row.accessToken,
    productTitle: row.product.title,
    productSlug: row.product.slug,
    orderNumber: row.order.number,
    grantedAt: row.grantedAt,
    status: row.revokedAt ? "revoked" : "active",
    revokedReason: row.revokedAt ? row.revokedReason : null,
    downloadCount: row.downloadCount,
    maxDownloads: row.maxDownloads,
    remainingDownloads: remaining(row.downloadCount, row.maxDownloads),
    moduleCount: row.product.digital?._count.assets ?? 0,
  }));
  const waiting = await db.orderLine.findMany({
    where: {
      isDigital: true,
      digitalEntitlement: { is: null },
      order: {
        customerId: userId,
        status: { notIn: ["cancelled", "returned"] },
        paymentStatus: { notIn: ["failed", "cancelled", "refunded", "chargeback"] },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: { title: true, order: { select: { number: true, paymentMethod: true } } },
  });
  return {
    items,
    pending: waiting.map((line) => ({
      productTitle: line.title,
      orderNumber: line.order.number,
      awaiting: line.order.paymentMethod === "cod" ? "delivery" : "payment",
    })),
  };
}

/** Detaliul unui drept al clientului, cu modulele; `null` dacă jetonul nu există SAU nu e al lui. */
export async function getEntitlementDetail(
  db: Db,
  userId: string,
  token: string,
): Promise<EntitlementDetailDto | null> {
  if (!isValidAccessToken(token)) return null;
  const row = await db.digitalEntitlement.findFirst({
    where: { accessToken: token, customerId: userId },
    select: {
      accessToken: true,
      grantedAt: true,
      revokedAt: true,
      revokedReason: true,
      downloadCount: true,
      maxDownloads: true,
      order: { select: { number: true } },
      product: {
        select: {
          title: true,
          slug: true,
          digital: {
            select: {
              assets: {
                orderBy: [{ position: "asc" }, { id: "asc" }],
                select: {
                  id: true,
                  title: true,
                  type: true,
                  mimeType: true,
                  fileSize: true,
                  durationSeconds: true,
                  position: true,
                  isPreview: true,
                  status: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!row) return null;
  const assets = (row.product.digital?.assets ?? []).map(toAssetDto);
  return {
    token: row.accessToken,
    productTitle: row.product.title,
    productSlug: row.product.slug,
    orderNumber: row.order.number,
    grantedAt: row.grantedAt,
    status: row.revokedAt ? "revoked" : "active",
    revokedReason: row.revokedAt ? row.revokedReason : null,
    downloadCount: row.downloadCount,
    maxDownloads: row.maxDownloads,
    remainingDownloads: remaining(row.downloadCount, row.maxDownloads),
    moduleCount: assets.length,
    assets,
  };
}

export interface AccessResult {
  kind: AccessGrant["kind"] | "link";
  url: string;
  expiresAt: Date | null;
  watermarked: boolean;
  action: "view" | "download";
  /** După această cerere; `null` = nelimitat sau cererea nu a consumat din limită. */
  remainingDownloads: number | null;
}

function refOf(asset: {
  type: string;
  storageKey: string | null;
  originalName: string | null;
  mimeType: string | null;
}): DeliveryAssetRef {
  if (!asset.storageKey || (asset.type !== "video" && asset.type !== "file")) {
    throw new DigitalError("DIGITAL_ASSET_UNAVAILABLE", "Modulul nu mai este disponibil");
  }
  return {
    type: asset.type,
    storageKey: asset.storageKey,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
  };
}

async function signWith(
  deps: AccessDeps,
  asset: {
    provider: string | null;
    type: string;
    storageKey: string | null;
    originalName: string | null;
    mimeType: string | null;
  },
  mode: "download" | "play",
  viewerEmail: string | null,
  seconds: number,
  now: Date,
): Promise<AccessGrant> {
  if (asset.provider !== "local" && asset.provider !== "bunny" && asset.provider !== "s3") {
    throw new DigitalError("DIGITAL_ASSET_UNAVAILABLE", "Modulul nu mai este disponibil");
  }
  const ref = refOf(asset);
  try {
    const provider = await deps.getProvider(asset.provider);
    return await provider.createAccess({
      asset: ref,
      mode,
      expiresInSeconds: seconds,
      viewerEmail,
      now,
    });
  } catch (error) {
    if (error instanceof DigitalError) throw error;
    if (error instanceof IntegrationError) {
      throw new DigitalError(
        "DIGITAL_PROVIDER_UNAVAILABLE",
        "Livrarea conținutului nu este disponibilă acum: încearcă din nou în câteva minute",
      );
    }
    throw error;
  }
}

/**
 * Emite un link de acces pentru un modul al unui drept al clientului. Ordinea contează: verificările, apoi linkul se SEMNEAZĂ
 * (fără efecte, deci o eroare nu consumă din limită), apoi contorul crește atomic și se scrie jurnalul, abia la urmă se întoarce
 * linkul.
 */
export async function requestAccess(
  deps: AccessDeps,
  input: { userId: string; token: string; assetId: string },
  meta: RequestMeta,
): Promise<AccessResult> {
  const now = (deps.now ?? (() => new Date()))();
  const notFound = () => new DigitalError("DIGITAL_NOT_FOUND", "Produsul nu a fost găsit");
  if (!isValidAccessToken(input.token) || input.assetId.length === 0 || input.assetId.length > 64) {
    throw notFound();
  }
  const entitlement = await deps.db.digitalEntitlement.findFirst({
    where: { accessToken: input.token, customerId: input.userId },
    select: {
      id: true,
      productId: true,
      orderId: true,
      revokedAt: true,
      expiresAt: true,
      customer: { select: { email: true } },
      order: { select: { number: true } },
    },
  });
  if (!entitlement) throw notFound();
  if (entitlement.revokedAt) {
    throw new DigitalError("DIGITAL_REVOKED", "Accesul la acest produs a fost retras");
  }
  if (entitlement.expiresAt && entitlement.expiresAt <= now) {
    throw new DigitalError("DIGITAL_EXPIRED", "Accesul la acest produs a expirat");
  }
  const asset = await deps.db.digitalAsset.findFirst({
    where: { id: input.assetId, productId: entitlement.productId },
    select: {
      id: true,
      type: true,
      provider: true,
      storageKey: true,
      externalUrl: true,
      originalName: true,
      mimeType: true,
      status: true,
    },
  });
  if (!asset) throw notFound();
  if (asset.status !== "ready") {
    throw new DigitalError(
      "DIGITAL_ASSET_UNAVAILABLE",
      "Modulul se pregătește: încearcă mai târziu",
    );
  }
  const settings = await deps.readSettings();

  const counts = DOWNLOADABLE.has(asset.type);
  let grant: AccessGrant | null = null;
  if (asset.type === "link") {
    if (!asset.externalUrl) {
      throw new DigitalError("DIGITAL_ASSET_UNAVAILABLE", "Modulul nu mai este disponibil");
    }
  } else {
    grant = await signWith(
      deps,
      asset,
      asset.type === "file" ? "download" : "play",
      entitlement.customer.email,
      settings.linkSeconds,
      now,
    );
  }

  const remainingAfter = await inTx(deps.db, async (tx) => {
    let left: number | null = null;
    if (counts) {
      const rows = await tx.$queryRaw<
        Array<{ downloadCount: number; maxDownloads: number | null }>
      >`
        UPDATE digital_entitlement
        SET "downloadCount" = "downloadCount" + 1, "updatedAt" = ${now}
        WHERE id = ${entitlement.id}
          AND "customerId" = ${input.userId}
          AND "revokedAt" IS NULL
          AND ("expiresAt" IS NULL OR "expiresAt" > ${now})
          AND ("maxDownloads" IS NULL OR "downloadCount" < "maxDownloads")
        RETURNING "downloadCount", "maxDownloads"`;
      const row = rows[0];
      if (!row) {
        // limita atinsă sau dreptul retras între timp: aceeași interogare le respinge pe amândouă
        const fresh = await tx.digitalEntitlement.findUnique({
          where: { id: entitlement.id },
          select: { revokedAt: true },
        });
        throw fresh?.revokedAt
          ? new DigitalError("DIGITAL_REVOKED", "Accesul la acest produs a fost retras")
          : new DigitalError(
              "DIGITAL_LIMIT_REACHED",
              "Ai atins limita de descărcări pentru acest produs. Scrie-ne dacă ai nevoie de acces suplimentar.",
            );
      }
      left = row.maxDownloads === null ? null : Math.max(0, row.maxDownloads - row.downloadCount);
    }
    await tx.digitalAccessLog.create({
      data: {
        entitlementId: entitlement.id,
        assetId: asset.id,
        action: counts ? "download" : "view",
        ip: clip(meta.ip, 64),
        userAgent: clip(meta.userAgent, 400),
        createdAt: now,
      },
    });
    await alertOnIpAnomaly(tx, entitlement, settings, now);
    return left;
  });

  return {
    kind: grant ? grant.kind : "link",
    url: grant ? grant.url : (asset.externalUrl as string),
    expiresAt: grant ? grant.expiresAt : null,
    watermarked: grant?.watermarked ?? false,
    action: counts ? "download" : "view",
    remainingDownloads: remainingAfter,
  };
}

/** Alertă în admin (o singură dată pe drept și pe zi) când prea multe adrese IP distincte folosesc același drept de acces. */
async function alertOnIpAnomaly(
  tx: Db,
  entitlement: { id: string; orderId: string; order: { number: string } },
  settings: AccessSettings,
  now: Date,
): Promise<void> {
  const since = new Date(now.getTime() - settings.ipWindowHours * 3_600_000);
  const rows = await tx.digitalAccessLog.findMany({
    where: { entitlementId: entitlement.id, createdAt: { gt: since }, ip: { not: null } },
    select: { ip: true },
    distinct: ["ip"],
  });
  if (
    !isIpAnomaly(
      rows.map((row) => row.ip),
      settings.maxIpsPerEntitlement,
    )
  )
    return;
  await notifyAdmins(tx, {
    kind: "digital_ip_anomaly",
    title: "Același produs digital e folosit de prea multe adrese IP",
    context: orderContext(entitlement.order.number, "Acces suspect"),
    href: `/admin/comenzi/${entitlement.orderId}`,
    permission: "digital.view",
    dedupKey: `digital-ip:${entitlement.id}:${now.toISOString().slice(0, 10)}`,
  });
}

/**
 * Previzualizarea gratuită (lecția de preview a unui produs activ): link scurt, fără drept de acces, fără contor, fără filigran.
 * Doar modulele marcate `isPreview`, gata, ale unui produs digital activ și nesters; orice altceva e `DIGITAL_NOT_FOUND`.
 */
export async function requestPreview(
  deps: AccessDeps,
  assetId: string,
): Promise<{ kind: AccessGrant["kind"] | "link"; url: string; expiresAt: Date | null }> {
  const now = (deps.now ?? (() => new Date()))();
  if (assetId.length === 0 || assetId.length > 64) {
    throw new DigitalError("DIGITAL_NOT_FOUND", "Previzualizarea nu a fost găsită");
  }
  const asset = await deps.db.digitalAsset.findFirst({
    where: {
      id: assetId,
      isPreview: true,
      status: "ready",
      digital: { product: { status: "active", deletedAt: null, type: "digital" } },
    },
    select: {
      type: true,
      provider: true,
      storageKey: true,
      externalUrl: true,
      originalName: true,
      mimeType: true,
    },
  });
  if (!asset) throw new DigitalError("DIGITAL_NOT_FOUND", "Previzualizarea nu a fost găsită");
  if (asset.type === "link") {
    if (!asset.externalUrl) {
      throw new DigitalError("DIGITAL_NOT_FOUND", "Previzualizarea nu a fost găsită");
    }
    return { kind: "link", url: asset.externalUrl, expiresAt: null };
  }
  const settings = await deps.readSettings();
  const grant = await signWith(
    deps,
    asset,
    asset.type === "file" ? "download" : "play",
    null,
    settings.linkSeconds,
    now,
  );
  return { kind: grant.kind, url: grant.url, expiresAt: grant.expiresAt };
}

/** Clientul are cel puțin un produs digital (acordat sau așteptat)? Decide dacă «Produsele mele digitale» apare în meniul contului. */
export async function hasDigitalProducts(db: Db, userId: string): Promise<boolean> {
  const [granted, waiting] = await Promise.all([
    db.digitalEntitlement.count({ where: { customerId: userId } }),
    db.orderLine.count({
      where: {
        isDigital: true,
        digitalEntitlement: { is: null },
        order: {
          customerId: userId,
          status: { notIn: ["cancelled", "returned"] },
          paymentStatus: { notIn: ["failed", "cancelled", "refunded", "chargeback"] },
        },
      },
    }),
  ]);
  return granted + waiting > 0;
}

export interface StorefrontDigitalDto {
  deliveryType: "download" | "stream" | "external_link";
  maxDownloads: number | null;
  whatYouGet: string | null;
  requirements: string | null;
  format: string | null;
  assets: Array<{
    id: string;
    title: string;
    type: "video" | "file" | "link";
    durationSeconds: number | null;
    fileSize: number | null;
    isPreview: boolean;
  }>;
}

/**
 * Ce se arată pe pagina unui produs digital ACTIV: tipul de livrare, limita, textele («ce primești», cerințe, format) și modulele cu
 * durată și mărime, cu lecția de preview marcată. Doar modulele gata. Fără cheie de stocare, fără furnizor, fără adrese de conținut.
 */
export async function getStorefrontDigital(
  db: Db,
  productId: string,
): Promise<StorefrontDigitalDto | null> {
  const row = await db.digitalProduct.findFirst({
    where: { productId, product: { status: "active", deletedAt: null, type: "digital" } },
    select: {
      deliveryType: true,
      maxDownloads: true,
      whatYouGet: true,
      requirements: true,
      format: true,
      assets: {
        where: { status: "ready" },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: {
          id: true,
          title: true,
          type: true,
          durationSeconds: true,
          fileSize: true,
          isPreview: true,
        },
      },
    },
  });
  if (!row) return null;
  return {
    deliveryType: row.deliveryType as StorefrontDigitalDto["deliveryType"],
    maxDownloads: row.maxDownloads,
    whatYouGet: row.whatYouGet,
    requirements: row.requirements,
    format: row.format,
    assets: row.assets.map((asset) => ({
      id: asset.id,
      title: asset.title,
      type: asset.type as "video" | "file" | "link",
      durationSeconds: asset.durationSeconds,
      fileSize: toNumber(asset.fileSize),
      isPreview: asset.isPreview,
    })),
  };
}
