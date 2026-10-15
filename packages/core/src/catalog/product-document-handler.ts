import { isStorageError } from "@ecom/integrations";
import { getLogger } from "@ecom/shared";
import { resolveClientIp } from "../auth/client-ip";
import { isSameOriginRequest } from "../auth/request-origin";
import type { AuditOutcome, AuditService } from "../audit/audit-service";
import { readBodyWithLimit } from "../media/body";
import { isMediaError } from "../media/errors";
import { sanitizeFileName } from "../media/file-name";
import type { MediaUploadGuard } from "../media/upload-guard";
import { can, type PermissionSubject } from "../rbac/can";
import type { SettingGroupValue } from "../settings/registry";
import {
  DOCUMENT_ERROR_STATUS,
  isDocumentError,
  type ProductDocumentsService,
} from "./product-documents";

export type DocumentSettings = SettingGroupValue<"documents">;

export interface ProductDocumentUploadDeps {
  /** Utilizatorul curent din sesiune (cu permisiuni), sau `null`. */
  getSubject: () => Promise<PermissionSubject | null>;
  getSettings: () => Promise<{ documents: DocumentSettings; trustedProxyHops: number }>;
  /** Originea aplicației (`APP_URL`). */
  appUrl: string;
  /** Gardianul de contoare, cu spațiul de nume al documentelor (separat de media). */
  createGuard: (settings: DocumentSettings) => MediaUploadGuard;
  service: Pick<ProductDocumentsService, "upload" | "replace">;
  audit: AuditService;
}

export interface ProductDocumentDownloadDeps {
  getSubject: () => Promise<PermissionSubject | null>;
  service: Pick<ProductDocumentsService, "downloadLink">;
}

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const json = (body: unknown, status: number, extra: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...NO_STORE, ...extra } });

const UPLOAD_FAILED_MESSAGE = "Documentul nu a putut fi încărcat. Încearcă din nou.";

/** Statusul HTTP al erorilor de catalog/permisiune, după codul stabil. */
const DOMAIN_STATUS: Record<string, number> = {
  AUTH_FORBIDDEN: 403,
  AUTH_UNAUTHENTICATED: 401,
  VALIDATION_ERROR: 400,
  CATALOG_PRODUCT_NOT_FOUND: 404,
  CATALOG_PRODUCT_DELETED: 409,
};

/**
 * `POST /api/admin/products/<id>/documents` — încarcă un document de produs. Corpul cererii e
 * fișierul (nu multipart), ca mărimea să poată fi limitată cât timp curge fluxul. Metadatele:
 * `X-File-Name` (UTF-8, percent-encoded) și query `?type=…&title=…&language=…&showInTab=…`. Cu
 * `?replace=<documentId>` înlocuiește fișierul unui document existent al aceluiași produs.
 *
 * E o rută API, nu o server action, deci nu o acoperă `withPermission`: își face singură toate
 * verificările, în ordinea asta (cele ieftine primele): 1. origine (CSRF) · 2. sesiune ·
 * 3. `products.content.write` · 4. rate limit · 5. mărime în timpul stream-ului · 6. tip real din
 * octeți, conținut activ, curățare · 7. storage + bază de date · 8. audit. Fiecare refuz se
 * înregistrează cu rezultat `denied` (sau `failed` la defecte de infrastructură), cu motivul, fără
 * conținutul sau numele fișierului; înregistrările refuzate sunt limitate pe IP (jurnalul e doar de
 * adăugare). Testul de arhitectură al rutelor de upload cere ca acest fișier să conțină verificarea
 * de origine și cea de permisiune.
 */
export async function handleProductDocumentUpload(
  request: Request,
  productId: string,
  deps: ProductDocumentUploadDeps,
): Promise<Response> {
  const { documents: settings, trustedProxyHops } = await deps.getSettings();
  const ip = resolveClientIp(request.headers, trustedProxyHops);
  const guard = deps.createGuard(settings);
  const subject = await deps.getSubject();

  const respond = async (
    outcome: Exclude<AuditOutcome, "success">,
    status: number,
    body: Record<string, unknown>,
    reason: string,
    details: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<Response> => {
    try {
      if (await guard.allowRefusedAudit(ip)) {
        await deps.audit.record({
          actorId: subject?.userId ?? null,
          actorLabel: subject?.email ?? null,
          action: "product.document.upload",
          entity: "product",
          entityId: /^[A-Za-z0-9_-]{1,40}$/.test(productId) ? productId : null,
          outcome,
          after: { reason, ...details },
        });
      }
    } catch (error) {
      getLogger().error({ err: error, reason }, "înregistrarea încercării de upload a eșuat");
    }
    return json(body, status, headers);
  };

  const refuse = (
    status: number,
    code: string,
    reason: string,
    details: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<Response> => respond("denied", status, { code }, reason, details, headers);

  if (!isSameOriginRequest(request.headers, deps.appUrl)) {
    return refuse(403, "ORIGIN_INVALID", "origin_mismatch");
  }
  if (!subject) return refuse(401, "AUTH_UNAUTHENTICATED", "unauthenticated");
  if (!can(subject, "products.content.write")) {
    return refuse(403, "AUTH_FORBIDDEN", "forbidden", { permission: "products.content.write" });
  }
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(productId)) {
    return refuse(404, "CATALOG_PRODUCT_NOT_FOUND", "invalid_product_id");
  }

  try {
    await guard.checkUpload(subject.userId, ip);
  } catch (error) {
    if (error instanceof Error && (error as { code?: unknown }).code === "AUTH_RATE_LIMITED") {
      const retryAfter = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
      return refuse(
        429,
        "AUTH_RATE_LIMITED",
        "rate_limited",
        {},
        { "Retry-After": String(typeof retryAfter === "number" ? retryAfter : 60) },
      );
    }
    throw error;
  }

  const url = new URL(request.url);
  try {
    const bytes = await readBodyWithLimit(request, settings.maxUploadBytes);
    const flag = url.searchParams.get("showInTab");
    const replaceId = url.searchParams.get("replace");
    if (replaceId) {
      const replaced = await deps.service.replace(subject, productId, replaceId, {
        bytes,
        originalName: sanitizeFileName(request.headers.get("x-file-name")),
      });
      return json({ document: replaced }, 200);
    }
    const document = await deps.service.upload(
      subject,
      productId,
      { bytes, originalName: sanitizeFileName(request.headers.get("x-file-name")) },
      {
        type: url.searchParams.get("type") ?? "other",
        ...(url.searchParams.get("title") && { title: url.searchParams.get("title") }),
        ...(url.searchParams.get("language") && { language: url.searchParams.get("language") }),
        ...(flag !== null && { showInTab: flag !== "false" && flag !== "0" }),
      },
    );
    return json({ document }, 201);
  } catch (error) {
    // citirea corpului: aceleași coduri ca la media (prea mare, gol)
    if (isMediaError(error)) {
      const code = error.code === "MEDIA_TOO_LARGE" ? "DOCUMENT_TOO_LARGE" : "DOCUMENT_EMPTY";
      return refuse(
        error.code === "MEDIA_TOO_LARGE" ? 413 : 400,
        code,
        error.code.replace(/^MEDIA_/, "").toLowerCase(),
        { declaredBytes: Number(request.headers.get("content-length")) || null },
      );
    }
    if (isDocumentError(error)) {
      const status = DOCUMENT_ERROR_STATUS[error.code];
      const body = { code: error.code, message: error.message };
      if (error.code === "DOCUMENT_STORAGE_UNAVAILABLE") {
        return respond("failed", status, body, "storage_unavailable", {}, { "Retry-After": "30" });
      }
      const details: Record<string, unknown> = {};
      const markers = (error.details as { markers?: unknown } | undefined)?.markers;
      if (Array.isArray(markers)) details["markers"] = markers;
      const reason = error.code.replace(/^DOCUMENT_/, "").toLowerCase();
      return respond("denied", status, body, reason, details);
    }
    if (isStorageError(error)) {
      getLogger().error(
        { code: error.code },
        "încărcarea documentului a eșuat: storage indisponibil",
      );
      return respond(
        "failed",
        503,
        {
          code: "DOCUMENT_STORAGE_UNAVAILABLE",
          message: "Stocarea fișierelor nu este disponibilă momentan.",
        },
        "storage_unavailable",
        {},
        { "Retry-After": "30" },
      );
    }
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && Object.hasOwn(DOMAIN_STATUS, code)) {
      // produs inexistent/șters, validare, permisiune: mesajul de domeniu nu conține fișierul
      const message = error instanceof Error ? error.message : "";
      return respond(
        "denied",
        DOMAIN_STATUS[code] as number,
        { code, message },
        code.toLowerCase(),
      );
    }
    getLogger().error({ err: error }, "încărcarea documentului a eșuat neașteptat");
    return respond(
      "failed",
      500,
      { code: "DOCUMENT_UPLOAD_FAILED", message: UPLOAD_FAILED_MESSAGE },
      "unexpected_error",
    );
  }
}

/**
 * `GET /api/admin/products/<id>/documents/<documentId>` — descărcarea unui document: sesiune +
 * `products.read`, apoi redirecționare la un link semnat cu expirare scurtă și
 * `Content-Disposition: attachment`. Fișierul nu se servește niciodată inline din originea
 * magazinului și nu trece prin aplicație.
 */
export async function handleProductDocumentDownload(
  productId: string,
  documentId: string,
  deps: ProductDocumentDownloadDeps,
): Promise<Response> {
  const subject = await deps.getSubject();
  if (!subject) return json({ code: "AUTH_UNAUTHENTICATED" }, 401);
  if (!can(subject, "products.read")) return json({ code: "AUTH_FORBIDDEN" }, 403);
  try {
    const { url } = await deps.service.downloadLink(subject, productId, documentId);
    return new Response(null, { status: 302, headers: { ...NO_STORE, Location: url } });
  } catch (error) {
    if (isDocumentError(error)) {
      return json({ code: error.code }, DOCUMENT_ERROR_STATUS[error.code]);
    }
    if (isStorageError(error)) return json({ code: "DOCUMENT_STORAGE_UNAVAILABLE" }, 503);
    throw error;
  }
}
