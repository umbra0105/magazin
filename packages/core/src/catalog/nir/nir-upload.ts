import { DomainError, IntegrationError, ValidationError, getLogger } from "@ecom/shared";
import { resolveClientIp } from "../../auth/client-ip";
import { isSameOriginRequest } from "../../auth/request-origin";
import type { AuditOutcome, AuditService } from "../../audit/audit-service";
import { readBodyWithLimit } from "../../media/body";
import { isMediaError } from "../../media/errors";
import { sanitizeFileName } from "../../media/file-name";
import type { MediaUploadGuard } from "../../media/upload-guard";
import { can, type PermissionSubject } from "../../rbac/can";
import type { SettingGroupValue } from "../../settings/registry";
import { NIR_FILE_MAX_BYTES } from "./nir-file";
import { nirViewForClient, type NirImportService } from "./nir-service";

/**
 * `POST /api/admin/nir-imports` (Faza 15) — încarcă exportul SmartBill «mișcări produse» (.xls / .xlsx / CSV) și întoarce
 * PREVIZUALIZAREA (nu scrie nimic în catalog; confirmarea e o acțiune separată). Corpul cererii e fișierul (nu multipart), ca mărimea
 * să poată fi limitată cât curge fluxul; numele vine în `X-File-Name`. E o rută API, nu o server action, deci nu o acoperă
 * `withPermission`: își face singură verificările, cele ieftine primele: origine (CSRF) · sesiune · `products.cost.import` ȘI
 * `products.cost.view` · rate limit · mărime în timpul fluxului · serviciul (format real, plan). Refuzurile se înregistrează cu
 * motivul, fără numele sau conținutul fișierului; răspunsurile conțin costuri DOAR pentru cine are `products.cost.view`.
 */

type ImportSettings = SettingGroupValue<"import">;

export interface NirUploadDeps {
  getSubject: () => Promise<PermissionSubject | null>;
  getSettings: () => Promise<{ import: ImportSettings; trustedProxyHops: number }>;
  appUrl: string;
  createGuard: (settings: ImportSettings) => MediaUploadGuard;
  service: Pick<NirImportService, "preview">;
  audit: AuditService;
}

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const json = (body: unknown, status: number, extra: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...NO_STORE, ...extra } });

export async function handleNirUpload(request: Request, deps: NirUploadDeps): Promise<Response> {
  const { import: settings, trustedProxyHops } = await deps.getSettings();
  const ip = resolveClientIp(request.headers, trustedProxyHops);
  const guard = deps.createGuard(settings);
  const subject = await deps.getSubject();

  const respond = async (
    outcome: Exclude<AuditOutcome, "success">,
    status: number,
    body: Record<string, unknown>,
    reason: string,
    headers: Record<string, string> = {},
  ): Promise<Response> => {
    try {
      if (await guard.allowRefusedAudit(ip)) {
        await deps.audit.record({
          actorId: subject?.userId ?? null,
          actorLabel: subject?.email ?? null,
          action: "product.cost.import",
          entity: "nir_import",
          entityId: null,
          outcome,
          after: { stage: "upload", reason },
        });
      }
    } catch (error) {
      getLogger().error({ err: error, reason }, "înregistrarea încercării de import NIR a eșuat");
    }
    return json(body, status, headers);
  };
  const refuse = (
    status: number,
    code: string,
    reason: string,
    headers: Record<string, string> = {},
  ) => respond("denied", status, { code }, reason, headers);

  if (!isSameOriginRequest(request.headers, deps.appUrl)) {
    return refuse(403, "ORIGIN_INVALID", "origin_mismatch");
  }
  if (!subject) return refuse(401, "AUTH_UNAUTHENTICATED", "unauthenticated");
  if (!can(subject, "products.cost.import") || !can(subject, "products.cost.view")) {
    return refuse(403, "AUTH_FORBIDDEN", "forbidden");
  }
  try {
    await guard.checkUpload(subject.userId, ip);
  } catch (error) {
    if (error instanceof Error && (error as { code?: unknown }).code === "AUTH_RATE_LIMITED") {
      const retryAfter = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
      return refuse(429, "AUTH_RATE_LIMITED", "rate_limited", {
        "Retry-After": String(typeof retryAfter === "number" ? retryAfter : 60),
      });
    }
    throw error;
  }

  try {
    const bytes = await readBodyWithLimit(request, NIR_FILE_MAX_BYTES);
    const view = await deps.service.preview(subject, {
      bytes,
      name: sanitizeFileName(request.headers.get("x-file-name")),
    });
    return json({ import: nirViewForClient(view) }, 200);
  } catch (error) {
    if (isMediaError(error)) {
      return error.code === "MEDIA_TOO_LARGE"
        ? respond(
            "denied",
            413,
            {
              code: "NIR_FILE_TOO_LARGE",
              message: "Fișierul depășește mărimea maximă permisă (5 MB).",
            },
            "too_large",
          )
        : refuse(400, "NIR_FILE_EMPTY", "empty");
    }
    if (error instanceof ValidationError) {
      return json({ code: "VALIDATION_ERROR", message: error.message }, 400);
    }
    if (error instanceof DomainError || error instanceof IntegrationError) {
      const code = (error as { code: string }).code;
      if (code === "AUTH_FORBIDDEN") return refuse(403, "AUTH_FORBIDDEN", "forbidden");
      if (code === "AUTH_UNAUTHENTICATED")
        return refuse(401, "AUTH_UNAUTHENTICATED", "unauthenticated");
      // erorile de fișier: mesaje fără valori din fișier
      return respond(
        "denied",
        code === "NIR_FILE_TOO_LARGE" ? 413 : 422,
        { code, message: error.message },
        code.toLowerCase(),
      );
    }
    getLogger().error({ err: error }, "importul NIR a eșuat neașteptat");
    return respond(
      "failed",
      500,
      { code: "NIR_IMPORT_FAILED", message: "Fișierul nu a putut fi procesat. Încearcă din nou." },
      "unexpected_error",
    );
  }
}
