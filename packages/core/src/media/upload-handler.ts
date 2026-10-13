import { isStorageError } from "@ecom/integrations";
import { DomainError, getLogger } from "@ecom/shared";
import { resolveClientIp } from "../auth/client-ip";
import { isSameOriginRequest } from "../auth/request-origin";
import type { AuditOutcome, AuditService } from "../audit/audit-service";
import { can, type PermissionSubject } from "../rbac/can";
import type { SettingGroupValue } from "../settings/registry";
import { readBodyWithLimit } from "./body";
import { MEDIA_ERROR_STATUS, isMediaError } from "./errors";
import { sanitizeFileName } from "./file-name";
import type { MediaService, UploadedMedia } from "./media-service";
import type { MediaUploadGuard } from "./upload-guard";

export type MediaSettings = SettingGroupValue<"media">;

export interface MediaUploadDeps {
  /** Utilizatorul curent din sesiune (cu permisiuni), sau `null`. */
  getSubject: () => Promise<PermissionSubject | null>;
  getSettings: () => Promise<{ media: MediaSettings; trustedProxyHops: number }>;
  /** Originea aplicației (`APP_URL`). */
  appUrl: string;
  createGuard: (settings: MediaSettings) => MediaUploadGuard;
  service: Pick<MediaService, "upload">;
  audit: AuditService;
}

const BUSY_RETRY_SECONDS = 5;
const BUSY_MESSAGE =
  "Se procesează prea multe imagini în acest moment. Încearcă din nou în câteva secunde.";
export const STORAGE_UNAVAILABLE = "MEDIA_STORAGE_UNAVAILABLE";
const STORAGE_UNAVAILABLE_MESSAGE =
  "Stocarea fișierelor nu este disponibilă momentan. Încearcă din nou peste puțin timp sau anunță administratorul.";
const UPLOAD_FAILED = "MEDIA_UPLOAD_FAILED";
const UPLOAD_FAILED_MESSAGE = "Fișierul nu a putut fi încărcat. Încearcă din nou.";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const json = (body: unknown, status: number, extra: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...NO_STORE, ...extra } });

/**
 * `POST /api/media` — încarcă o imagine. Corpul cererii e fișierul (nu multipart), ca mărimea să
 * poată fi limitată cât timp curge fluxul. Metadatele: `X-File-Name` (UTF-8, percent-encoded),
 * query `?folderId=…&alt=…`.
 *
 * E o rută API, nu o server action, deci nu o acoperă `withPermission` și testul de arhitectură
 * din admin: își face singură toate verificările, în ordinea asta (cele ieftine primele):
 *   1. origine (CSRF) · 2. sesiune · 3. `media.write` · 4. rate limit · 5. mărime în timpul
 *   stream-ului · 6. tip real, pixeli, curățare · 7. storage + bază de date · 8. audit.
 * Fiecare refuz (inclusiv cele de la 1-6) se înregistrează în audit cu rezultat `denied`, cu motivul
 * dar fără conținutul sau numele fișierului; înregistrările refuzate sunt limitate pe IP.
 */
export async function handleMediaUpload(
  request: Request,
  deps: MediaUploadDeps,
): Promise<Response> {
  const { media: settings, trustedProxyHops } = await deps.getSettings();
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
          action: "media.upload",
          entity: "media",
          outcome,
          after: { reason, ...details },
        });
      }
    } catch (error) {
      // jurnalul sau contorul căzut nu schimbă răspunsul
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
  if (!can(subject, "media.write")) {
    return refuse(403, "AUTH_FORBIDDEN", "forbidden", { permission: "media.write" });
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
  let uploaded: UploadedMedia;
  try {
    const bytes = await readBodyWithLimit(request, settings.maxUploadBytes);
    uploaded = await deps.service.upload({
      bytes,
      originalName: sanitizeFileName(request.headers.get("x-file-name")),
      folderId: url.searchParams.get("folderId") || null,
      alt: url.searchParams.get("alt") ?? "",
      uploadedById: subject.userId,
      limits: {
        allowedMimeTypes: settings.allowedMimeTypes,
        maxInputPixels: settings.maxInputPixels,
      },
    });
  } catch (error) {
    if (isMediaError(error) && error.code === "MEDIA_BUSY") {
      // Nu e vina utilizatorului și nu e un refuz: serverul decodează deja numărul maxim de imagini.
      return respond(
        "failed",
        503,
        { code: error.code, message: BUSY_MESSAGE },
        "busy",
        {},
        { "Retry-After": String(BUSY_RETRY_SECONDS) },
      );
    }
    if (isMediaError(error)) {
      const reason = error.code.replace(/^MEDIA_/, "").toLowerCase();
      return refuse(MEDIA_ERROR_STATUS[error.code], error.code, reason, {
        declaredBytes: Number(request.headers.get("content-length")) || null,
      });
    }
    // Defecțiune de infrastructură (bucket lipsă, MinIO oprit, credențiale greșite): nu e vina
    // utilizatorului. Detaliul tehnic ajunge doar în loguri, niciodată în răspuns sau în jurnal.
    if (isStorageError(error)) {
      getLogger().error(
        { err: error, code: error.code, details: error.details },
        "încărcarea media a eșuat: storage indisponibil",
      );
      return respond(
        "failed",
        503,
        { code: STORAGE_UNAVAILABLE, message: STORAGE_UNAVAILABLE_MESSAGE },
        "storage_unavailable",
        { errorCode: error.code },
        { "Retry-After": "30" },
      );
    }
    getLogger().error({ err: error }, "încărcarea media a eșuat neașteptat");
    return respond(
      "failed",
      500,
      { code: UPLOAD_FAILED, message: UPLOAD_FAILED_MESSAGE },
      "unexpected_error",
    );
  }

  try {
    await deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "media.upload",
      entity: "media",
      entityId: uploaded.id,
      after: {
        mime: uploaded.mime,
        sizeBytes: uploaded.sizeBytes,
        width: uploaded.width,
        height: uploaded.height,
        folderId: uploaded.folderId,
      },
    });
  } catch (error) {
    getLogger().error(
      { err: error, mediaId: uploaded.id },
      "scrierea în jurnalul de audit a eșuat",
    );
    // Aceeași politică ca `withAudit`: fișierul e salvat, dar apelantul află că nu s-a înregistrat.
    const failure = new DomainError(
      "AUDIT_WRITE_FAILED",
      "Fișierul a fost salvat, dar nu a putut fi înregistrat în jurnalul de audit",
    );
    return json({ code: failure.code, mediaId: uploaded.id }, 500);
  }

  return json(
    {
      id: uploaded.id,
      status: uploaded.status,
      mime: uploaded.mime,
      width: uploaded.width,
      height: uploaded.height,
      sizeBytes: uploaded.sizeBytes,
      url: uploaded.url,
    },
    201,
  );
}
