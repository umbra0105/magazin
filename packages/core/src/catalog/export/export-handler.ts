import { getLogger } from "@ecom/shared";
import { resolveClientIp } from "../../auth/client-ip";
import { isSameOriginRequest } from "../../auth/request-origin";
import type { AuditOutcome, AuditService } from "../../audit/audit-service";
import { readBodyWithLimit } from "../../media/body";
import { isMediaError } from "../../media/errors";
import type { MediaUploadGuard, UploadRateSettings } from "../../media/upload-guard";
import { can, type PermissionSubject } from "../../rbac/can";
import type { SettingGroupValue } from "../../settings/registry";
import { csvStreamResponse } from "../import/import-csv";
import { cellToCsvText, type ExportRow } from "./export-rows";
import { ExportError, type PreparedExport, type ProductExportService } from "./export-service";
import { buildExportXlsx, xlsxResponse } from "./export-xlsx";

export type ProductExportSettingsGroup = SettingGroupValue<"productExport">;

export interface ProductExportRouteDeps {
  /** Utilizatorul curent din sesiune (cu permisiuni), sau `null`. */
  getSubject: () => Promise<PermissionSubject | null>;
  getSettings: () => Promise<{
    productExport: ProductExportSettingsGroup;
    trustedProxyHops: number;
  }>;
  /** Originea aplicației (`APP_URL`). */
  appUrl: string;
  /** Gardianul de contoare, cu spațiul de nume al exporturilor (separat de importuri, media și documente). */
  createGuard: (settings: UploadRateSettings) => MediaUploadGuard;
  service: Pick<ProductExportService, "prepare">;
  audit: AuditService;
}

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/** Cererea de export e mică (format, domeniu, cel mult 200 de id-uri, filtre). */
const MAX_REQUEST_BYTES = 32 * 1024;

const json = (body: unknown, status: number, extra: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...NO_STORE, ...extra } });

const EXPORT_FAILED_MESSAGE = "Exportul nu a putut fi generat. Încearcă din nou.";

const EXPORT_ERROR_STATUS: Record<string, number> = {
  EXPORT_INVALID: 400,
  EXPORT_EMPTY: 422,
  EXPORT_TOO_MANY_ROWS: 413,
};

async function* csvRows(prepared: PreparedExport): AsyncGenerator<string[]> {
  yield prepared.headers;
  for await (const row of prepared.rows as AsyncIterable<ExportRow>) {
    yield row.map(cellToCsvText);
  }
}

/**
 * `POST /api/admin/product-exports` — exportul de produse (CSV sau XLSX). Corpul e JSON mic: format,
 * domeniu (selecție / filtre curente / tot catalogul), id-uri, filtre, includerea coșului de gunoi.
 *
 * De ce POST și nu GET: exportul are efect (rate limit, eveniment de audit) și citește tot catalogul;
 * un GET ar putea fi declanșat de o pagină străină printr-o simplă navigare (cu cookie-urile
 * utilizatorului), pe când POST cere verificarea originii. Fiind o rută API (nu server action),
 * `withPermission` nu o acoperă: își face singură verificările, în ordinea asta (cele ieftine primele):
 * 1. origine (CSRF) · 2. sesiune · 3. `products.export` · 4. rate limit (contor separat) · 5. cerere
 * validă, domeniu numărat, limită de rânduri · 6. CSV în flux din bază, pe loturi; XLSX construit în
 * memorie (limitat de `productExport.maxRows`). Fiecare refuz se înregistrează cu rezultat `denied`,
 * fără conținutul cererii; înregistrările refuzate sunt limitate pe IP. Auditul exportului reușit
 * (`product.export`, doar numere) îl scrie serviciul la sfârșitul fluxului. Testul de arhitectură al
 * rutelor care scriu cere ca acest fișier să conțină verificarea de origine și cea de permisiune.
 */
export async function handleProductExport(
  request: Request,
  deps: ProductExportRouteDeps,
): Promise<Response> {
  const { productExport: settings, trustedProxyHops } = await deps.getSettings();
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
          action: "product.export",
          entity: "product_export",
          entityId: null,
          outcome,
          after: { reason },
        });
      }
    } catch (error) {
      getLogger().error({ err: error, reason }, "înregistrarea încercării de export a eșuat");
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
  if (!can(subject, "products.export")) return refuse(403, "AUTH_FORBIDDEN", "forbidden");

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
    let input: unknown;
    try {
      const bytes = await readBodyWithLimit(request, MAX_REQUEST_BYTES);
      input = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (isMediaError(error) || error instanceof SyntaxError) {
        return respond(
          "denied",
          400,
          { code: "EXPORT_INVALID", message: "Cererea de export nu este validă" },
          "invalid_request",
        );
      }
      throw error;
    }

    const prepared = await deps.service.prepare(subject, input);
    if (prepared.format === "csv") return csvStreamResponse(csvRows(prepared), prepared.fileName);
    return xlsxResponse(await buildExportXlsx(prepared), prepared.fileName);
  } catch (error) {
    if (error instanceof ExportError) {
      return respond(
        "denied",
        EXPORT_ERROR_STATUS[error.code] ?? 400,
        { code: error.code, message: error.message },
        error.code.replace(/^EXPORT_/, "").toLowerCase(),
      );
    }
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "AUTH_FORBIDDEN") return refuse(403, "AUTH_FORBIDDEN", "forbidden");
    getLogger().error({ err: error }, "exportul de produse a eșuat neașteptat");
    return respond(
      "failed",
      500,
      { code: "EXPORT_FAILED", message: EXPORT_FAILED_MESSAGE },
      "unexpected_error",
    );
  }
}
