import { z } from "zod";
import { STOCK_REPORT_MAX_BYTES } from "@ecom/integrations";
import { DomainError, IntegrationError, ValidationError, getLogger } from "@ecom/shared";
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
  applyOptionsSchema,
  previewOptionsSchema,
  type StockReportImportService,
} from "./stock-report-import";

/** Mărimea maximă a raportului încărcat (aceeași ca a cititorului de fișier). */
export const STOCK_UPLOAD_MAX_BYTES = STOCK_REPORT_MAX_BYTES;

export type StockUploadSettingsGroup = SettingGroupValue<"import">;

export interface StockReportUploadDeps {
  /** Utilizatorul curent din sesiune (cu permisiuni), sau `null`. */
  getSubject: () => Promise<PermissionSubject | null>;
  getSettings: () => Promise<{ import: StockUploadSettingsGroup; trustedProxyHops: number }>;
  /** Originea aplicației (`APP_URL`). */
  appUrl: string;
  /** Gardianul de contoare, cu spațiul de nume al importului de stoc (separat de media și de importul de produse). */
  createGuard: (settings: StockUploadSettingsGroup) => MediaUploadGuard;
  service: Pick<StockReportImportService, "preview" | "apply">;
  audit: AuditService;
}

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const json = (body: unknown, status: number, extra: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...NO_STORE, ...extra } });

const FAILED_MESSAGE = "Importul nu a putut fi făcut. Încearcă din nou.";

/** Refuzuri de regulă care înseamnă «s-a schimbat ceva între timp, verifică din nou». */
const CONFLICT_CODES: ReadonlySet<string> = new Set([
  "STOCK_IMPORT_PLAN_CHANGED",
  "STOCK_IMPORT_NOT_NEWER",
]);

const FILE_STATUS: Readonly<Record<string, number>> = {
  STOCK_REPORT_FILE_TOO_LARGE: 413,
  STOCK_REPORT_FILE_NOT_SPREADSHEET: 415,
};

const queryShape = z.strictObject({
  mode: z.enum(["preview", "apply"], { error: "Modul cererii nu este valid" }),
  takenAt: z.string().max(40).optional(),
  planHash: z.string().max(64).optional(),
  ack: z.literal("1").optional(),
  zeroConfirm: z.literal("1").optional(),
  zeroCount: z
    .string()
    .regex(/^\d{1,7}$/)
    .optional(),
});

function invalid(message: string): Response {
  return json({ code: "VALIDATION_ERROR", message }, 400);
}

/**
 * `POST /api/admin/stock-imports?mode=preview|apply` — încarcă raportul SmartBill «Stoc la zi» (.xls / .xlsx) și întoarce
 * previzualizarea (fără modificări) sau aplică poza. Corpul cererii e fișierul (nu multipart), ca mărimea să poată fi
 * limitată cât timp curge fluxul; numele vine în `X-File-Name` (UTF-8, percent-encoded); opțiunile, în adresă (ora pozei,
 * amprenta previzualizării, bifele). E o rută API, nu o server action, deci nu o acoperă `withPermission`: își face singură
 * verificările, cele ieftine primele: origine (CSRF) · sesiune · `inventory.write` · rate limit · mărime în timpul
 * stream-ului · serviciul (format real, plan, tranzacție). Refuzurile se înregistrează cu motivul, fără numele sau
 * conținutul fișierului. Fișierul nu se păstrează nicăieri: la aplicare browserul îl retrimite.
 */
export async function handleStockReportUpload(
  request: Request,
  deps: StockReportUploadDeps,
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
          action: "stock.import.upload",
          entity: "stock_snapshot",
          entityId: null,
          outcome,
          after: { reason },
        });
      }
    } catch (error) {
      getLogger().error(
        { err: error, reason },
        "înregistrarea încercării de import de stoc a eșuat",
      );
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
  if (!can(subject, "inventory.write")) return refuse(403, "AUTH_FORBIDDEN", "forbidden");

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

  // opțiunile se validează ÎNAINTE de a citi fișierul: o cerere greșită nu consumă banda
  const query = queryShape.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return invalid(query.error.issues[0]?.message ?? "Cerere invalidă");
  const q = query.data;
  const hasApplyOnly =
    q.planHash !== undefined ||
    q.ack !== undefined ||
    q.zeroConfirm !== undefined ||
    q.zeroCount !== undefined;

  let run: (bytes: Uint8Array, fileName: string) => Promise<Response>;
  if (q.mode === "preview") {
    if (hasApplyOnly) return invalid("Opțiunile de aplicare nu se folosesc la previzualizare");
    const options = previewOptionsSchema.safeParse({ takenAt: q.takenAt });
    if (!options.success) return invalid(options.error.issues[0]?.message ?? "Cerere invalidă");
    run = async (bytes, fileName) => {
      const preview = await deps.service.preview(subject, {
        bytes,
        fileName,
        ...(options.data.takenAt && { takenAt: options.data.takenAt }),
      });
      return json({ preview }, 200);
    };
  } else {
    if ((q.zeroConfirm === "1") !== (q.zeroCount !== undefined)) {
      return invalid("Confirmarea «lipsă → 0» cere și numărul de variante văzut în previzualizare");
    }
    const options = applyOptionsSchema.safeParse({
      takenAt: q.takenAt,
      planHash: q.planHash,
      acknowledgeTimeWarnings: q.ack === "1",
      ...(q.zeroConfirm === "1" && {
        zeroMissing: { confirm: true, expectedCount: Number.parseInt(q.zeroCount ?? "", 10) },
      }),
    });
    if (!options.success) return invalid(options.error.issues[0]?.message ?? "Cerere invalidă");
    run = async (bytes, fileName) => {
      const result = await deps.service.apply(subject, { bytes, fileName, ...options.data });
      return json({ result }, 200);
    };
  }

  try {
    const bytes = await readBodyWithLimit(request, STOCK_UPLOAD_MAX_BYTES);
    return await run(bytes, sanitizeFileName(request.headers.get("x-file-name")));
  } catch (error) {
    if (isMediaError(error)) {
      return error.code === "MEDIA_TOO_LARGE"
        ? respond(
            "denied",
            413,
            {
              code: "STOCK_REPORT_FILE_TOO_LARGE",
              message: "Fișierul depășește mărimea maximă permisă (5 MB).",
            },
            "too_large",
          )
        : refuse(400, "STOCK_REPORT_FILE_EMPTY", "empty");
    }
    if (error instanceof IntegrationError) {
      return respond(
        "denied",
        FILE_STATUS[error.code] ?? 422,
        { code: error.code, message: error.message },
        error.code.replace(/^STOCK_REPORT_FILE_/, "").toLowerCase(),
      );
    }
    if (error instanceof ValidationError) {
      return invalid(error.message);
    }
    if (error instanceof DomainError) {
      if (error.code === "AUTH_FORBIDDEN") return refuse(403, "AUTH_FORBIDDEN", "forbidden");
      if (error.code === "AUTH_UNAUTHENTICATED") {
        return refuse(401, "AUTH_UNAUTHENTICATED", "unauthenticated");
      }
      return json(
        { code: error.code, message: error.message },
        CONFLICT_CODES.has(error.code) ? 409 : 422,
      );
    }
    getLogger().error({ err: error }, "importul «stoc la zi» a eșuat neașteptat");
    return respond(
      "failed",
      500,
      { code: "STOCK_IMPORT_FAILED", message: FAILED_MESSAGE },
      "unexpected_error",
    );
  }
}
