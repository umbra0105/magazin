import { getLogger } from "@ecom/shared";
import { resolveClientIp } from "../../auth/client-ip";
import { isSameOriginRequest } from "../../auth/request-origin";
import type { AuditOutcome, AuditService } from "../../audit/audit-service";
import { readBodyWithLimit } from "../../media/body";
import { isMediaError } from "../../media/errors";
import { sanitizeFileName } from "../../media/file-name";
import type { MediaUploadGuard } from "../../media/upload-guard";
import { can, type PermissionSubject } from "../../rbac/can";
import type { SettingGroupValue } from "../../settings/registry";
import { ImportFileError, type ImportFormat } from "./import-file";
import { ImportError, type ProductImportService } from "./import-service";
import { csvResponse } from "./import-csv";
import { TEMPLATE_FILE_NAMES, XLSX_MIME, buildTemplate, templateRows } from "./import-template";

export type ImportSettingsGroup = SettingGroupValue<"import">;

export interface ProductImportUploadDeps {
  /** Utilizatorul curent din sesiune (cu permisiuni), sau `null`. */
  getSubject: () => Promise<PermissionSubject | null>;
  getSettings: () => Promise<{ import: ImportSettingsGroup; trustedProxyHops: number }>;
  /** Originea aplicației (`APP_URL`). */
  appUrl: string;
  /** Gardianul de contoare, cu spațiul de nume al importurilor (separat de media și documente). */
  createGuard: (settings: ImportSettingsGroup) => MediaUploadGuard;
  service: Pick<ProductImportService, "register">;
  audit: AuditService;
}

export interface ProductImportDownloadDeps {
  getSubject: () => Promise<PermissionSubject | null>;
  service: Pick<ProductImportService, "reportRows">;
}

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const json = (body: unknown, status: number, extra: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...NO_STORE, ...extra } });

const UPLOAD_FAILED_MESSAGE = "Fișierul nu a putut fi încărcat. Încearcă din nou.";

const FILE_ERROR_STATUS: Record<string, number> = {
  IMPORT_FILE_TOO_LARGE: 413,
  IMPORT_FILE_TOO_MANY_ROWS: 413,
  IMPORT_FILE_TOO_MANY_COLUMNS: 413,
  IMPORT_FILE_CELL_TOO_LONG: 413,
  IMPORT_FILE_UNSUPPORTED: 415,
  IMPORT_FILE_MACROS: 415,
  IMPORT_FILE_EMPTY: 400,
  IMPORT_FILE_CORRUPT: 400,
};

/**
 * `POST /api/admin/product-imports` — încarcă fișierul unui import de produse (CSV sau XLSX). Corpul
 * cererii e fișierul (nu multipart), ca mărimea să poată fi limitată cât timp curge fluxul; numele vine
 * în `X-File-Name` (UTF-8, percent-encoded). E o rută API, nu o server action, deci nu o acoperă
 * `withPermission`: își face singură toate verificările, în ordinea asta (cele ieftine primele):
 * 1. origine (CSRF) · 2. sesiune · 3. `products.write` · 4. rate limit (contor separat de media și
 * documente) · 5. mărime în timpul stream-ului · 6. format real din octeți, limite de rânduri/coloane/
 * celule, arhivă XLSX curățată · 7. stocare privată + bază de date. Fiecare refuz se înregistrează cu
 * rezultat `denied` (sau `failed`), cu motivul, fără conținutul sau numele fișierului; înregistrările
 * refuzate sunt limitate pe IP. Testul de arhitectură al rutelor de upload cere ca acest fișier să
 * conțină verificarea de origine și cea de permisiune.
 */
export async function handleProductImportUpload(
  request: Request,
  deps: ProductImportUploadDeps,
): Promise<Response> {
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
          action: "product.import.upload",
          entity: "product_import",
          entityId: null,
          outcome,
          after: { reason },
        });
      }
    } catch (error) {
      getLogger().error({ err: error, reason }, "înregistrarea încercării de import a eșuat");
    }
    return json(body, status, headers);
  };

  const refuse = (
    status: number,
    code: string,
    reason: string,
    headers: Record<string, string> = {},
  ): Promise<Response> => respond("denied", status, { code }, reason, headers);

  if (!isSameOriginRequest(request.headers, deps.appUrl)) {
    return refuse(403, "ORIGIN_INVALID", "origin_mismatch");
  }
  if (!subject) return refuse(401, "AUTH_UNAUTHENTICATED", "unauthenticated");
  if (!can(subject, "products.write")) return refuse(403, "AUTH_FORBIDDEN", "forbidden");

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
    const bytes = await readBodyWithLimit(request, settings.maxUploadBytes);
    const analysis = await deps.service.register(subject, {
      bytes,
      fileName: sanitizeFileName(request.headers.get("x-file-name")),
    });
    return json({ import: analysis }, 201);
  } catch (error) {
    if (isMediaError(error)) {
      return error.code === "MEDIA_TOO_LARGE"
        ? refuse(413, "IMPORT_FILE_TOO_LARGE", "too_large")
        : refuse(400, "IMPORT_FILE_EMPTY", "empty");
    }
    if (error instanceof ImportFileError) {
      return respond(
        "denied",
        FILE_ERROR_STATUS[error.code] ?? 400,
        { code: error.code, message: error.message },
        error.code.replace(/^IMPORT_FILE_/, "").toLowerCase(),
      );
    }
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "AUTH_FORBIDDEN") return refuse(403, "AUTH_FORBIDDEN", "forbidden");
    getLogger().error({ err: error }, "încărcarea fișierului de import a eșuat neașteptat");
    return respond(
      "failed",
      500,
      { code: "IMPORT_UPLOAD_FAILED", message: UPLOAD_FAILED_MESSAGE },
      "unexpected_error",
    );
  }
}

/** `GET /api/admin/product-imports/template?format=csv|xlsx` — șablonul de import (sesiune + `products.write`). */
export async function handleProductImportTemplate(
  request: Request,
  deps: Pick<ProductImportDownloadDeps, "getSubject">,
): Promise<Response> {
  const subject = await deps.getSubject();
  if (!subject) return json({ code: "AUTH_UNAUTHENTICATED" }, 401);
  if (!can(subject, "products.write")) return json({ code: "AUTH_FORBIDDEN" }, 403);
  const requested = new URL(request.url).searchParams.get("format");
  if (requested !== "csv" && requested !== "xlsx") return json({ code: "VALIDATION_ERROR" }, 400);
  const format: ImportFormat = requested;
  // CSV-ul trece prin funcția comună (BOM + «sep=;»); XLSX-ul are propriul generator
  if (format === "csv") return csvResponse(templateRows(), TEMPLATE_FILE_NAMES.csv);
  const bytes = await buildTemplate(format);
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      ...NO_STORE,
      "Content-Type": XLSX_MIME,
      "Content-Disposition": `attachment; filename="${TEMPLATE_FILE_NAMES[format]}"`,
    },
  });
}

/** `GET /api/admin/product-imports/<id>/report` — raportul ca CSV (sesiune + `products.write`, doar al tău). */
export async function handleProductImportReport(
  importId: string,
  deps: ProductImportDownloadDeps,
): Promise<Response> {
  const subject = await deps.getSubject();
  if (!subject) return json({ code: "AUTH_UNAUTHENTICATED" }, 401);
  if (!can(subject, "products.write")) return json({ code: "AUTH_FORBIDDEN" }, 403);
  try {
    const { rows, fileName } = await deps.service.reportRows(subject, importId);
    return csvResponse(rows, fileName);
  } catch (error) {
    if (error instanceof ImportError) {
      return json({ code: error.code }, error.code === "IMPORT_NOT_FOUND" ? 404 : 409);
    }
    throw error;
  }
}
