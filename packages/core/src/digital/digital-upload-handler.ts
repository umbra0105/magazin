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
import { addUploadedAsset, type ContentDeps } from "./digital-content";
import { DigitalError } from "./digital-errors";
import type { DigitalSettings } from "./digital-settings";

export type UploadDocumentSettings = SettingGroupValue<"documents">;

export interface DigitalUploadDeps {
  getSubject: () => Promise<PermissionSubject | null>;
  getSettings: () => Promise<{
    digital: DigitalSettings;
    documents: UploadDocumentSettings;
    trustedProxyHops: number;
  }>;
  /** Originea aplicației (`APP_URL`). */
  appUrl: string;
  createGuard: (documents: UploadDocumentSettings) => MediaUploadGuard;
  content: ContentDeps;
  audit: AuditService;
  /** Invalidează cache-ul paginii produsului după o încărcare reușită. */
  invalidate?: () => Promise<void> | void;
}

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const json = (body: unknown, status: number, extra: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...NO_STORE, ...extra } });

const STATUS: Record<string, number> = {
  DIGITAL_NOT_FOUND: 404,
  DIGITAL_NOT_DIGITAL_PRODUCT: 409,
  DIGITAL_UPLOAD_REFUSED: 422,
  DIGITAL_PROVIDER_UNAVAILABLE: 503,
  DIGITAL_INPUT_INVALID: 400,
};

/**
 * `POST /api/admin/products/<id>/digital` — încarcă un modul (fișier sau video) al unui produs digital. Corpul cererii e fișierul
 * (nu multipart), ca mărimea să poată fi limitată cât timp curge fluxul; metadatele: `X-File-Name` (UTF-8, percent-encoded),
 * `Content-Type` și query `?title=…&preview=true`. E o rută API, nu o server action, deci își face singură verificările, în
 * ordinea asta: 1. origine (CSRF) · 2. sesiune · 3. `digital.manage` · 4. limită de cereri · 5. mărime în timpul stream-ului ·
 * 6. extensie, furnizor din setări, stocare și bază de date · 7. audit (actorul, produsul, tipul și mărimea; niciodată numele
 * fișierului sau cheia de stocare). Refuzurile se înregistrează `denied`, limitate pe IP (jurnalul e doar de adăugare).
 */
export async function handleDigitalAssetUpload(
  request: Request,
  productId: string,
  deps: DigitalUploadDeps,
): Promise<Response> {
  const settings = await deps.getSettings();
  const ip = resolveClientIp(request.headers, settings.trustedProxyHops);
  const guard = deps.createGuard(settings.documents);
  const subject = await deps.getSubject();

  const refuse = async (
    status: number,
    code: string,
    reason: string,
    outcome: Exclude<AuditOutcome, "success"> = "denied",
    headers: Record<string, string> = {},
  ): Promise<Response> => {
    try {
      if (await guard.allowRefusedAudit(ip)) {
        await deps.audit.record({
          actorId: subject?.userId ?? null,
          actorLabel: subject?.email ?? null,
          action: "digital.asset.upload",
          entity: "product",
          entityId: /^[A-Za-z0-9_-]{1,40}$/.test(productId) ? productId : null,
          outcome,
          after: { reason },
        });
      }
    } catch (error) {
      getLogger().error(
        { err: error, reason },
        "înregistrarea încercării de upload digital a eșuat",
      );
    }
    return json({ code }, status, headers);
  };

  if (!isSameOriginRequest(request.headers, deps.appUrl)) {
    return refuse(403, "ORIGIN_INVALID", "origin_mismatch");
  }
  if (!subject) return refuse(401, "AUTH_UNAUTHENTICATED", "unauthenticated");
  if (!can(subject, "digital.manage")) return refuse(403, "AUTH_FORBIDDEN", "forbidden");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(productId)) {
    return refuse(404, "DIGITAL_NOT_FOUND", "invalid_product_id");
  }
  try {
    await guard.checkUpload(subject.userId, ip);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "AUTH_RATE_LIMITED") {
      const retry = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
      return refuse(429, "AUTH_RATE_LIMITED", "rate_limited", "denied", {
        "Retry-After": String(typeof retry === "number" ? retry : 60),
      });
    }
    throw error;
  }

  const url = new URL(request.url);
  try {
    const maxBytes = settings.digital.maxUploadMb * 1024 * 1024;
    const body = await readBodyWithLimit(request, maxBytes);
    const fileName = sanitizeFileName(request.headers.get("x-file-name"));
    const asset = await addUploadedAsset(deps.content, productId, {
      title: url.searchParams.get("title") ?? "",
      fileName,
      mimeType: (request.headers.get("content-type") ?? "application/octet-stream").slice(0, 100),
      body,
      isPreview: url.searchParams.get("preview") === "true",
    });
    await deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "digital.asset.upload",
      entity: "product",
      entityId: productId,
      after: { assetId: asset.id, type: asset.type, provider: asset.provider, bytes: body.length },
    });
    try {
      await deps.invalidate?.();
    } catch (error) {
      getLogger().warn({ err: error }, "invalidarea paginii produsului digital a eșuat");
    }
    return json({ asset }, 201);
  } catch (error) {
    if (isMediaError(error)) {
      const tooLarge = error.code === "MEDIA_TOO_LARGE";
      return refuse(
        tooLarge ? 413 : 400,
        tooLarge ? "DIGITAL_TOO_LARGE" : "DIGITAL_EMPTY",
        error.code.toLowerCase(),
      );
    }
    if (
      error instanceof DigitalError ||
      (error as { code?: unknown } | null)?.code?.toString().startsWith("DIGITAL_")
    ) {
      const code = (error as DigitalError).code;
      return json({ code, message: (error as DigitalError).message }, STATUS[code] ?? 400);
    }
    getLogger().error({ err: error }, "încărcarea modulului digital a eșuat");
    return refuse(500, "DIGITAL_UPLOAD_FAILED", "failed", "failed");
  }
}
