import { RETURN_STATUSES, can, csvResponse, returnReasonReport } from "@ecom/core";
import { getDb } from "@ecom/db";
import { parseReportDates } from "@/lib/return-report";
import { getCurrentSubject } from "@/lib/session";
import { getMessages } from "@/messages";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const m = getMessages().admin.returns;

/**
 * Exportul CSV al raportului de motive (Faza 14), cu `returns.view`. Fișierul se generează EXCLUSIV prin `csvResponse` (UTF-16LE cu
 * BOM, delimitator TAB, antet în română), ca să se deschidă corect în Excel (coloane separate și diacritice corecte). Nicio dată
 * personală: doar motive și numere.
 */
export async function GET(request: Request): Promise<Response> {
  const subject = await getCurrentSubject();
  if (!subject || !can(subject, "returns.view")) {
    return new Response("Nu ai permisiunea să exporți raportul", { status: 403 });
  }
  const url = new URL(request.url);
  const dates = parseReportDates(
    url.searchParams.get("de-la") ?? undefined,
    url.searchParams.get("pana-la") ?? undefined,
  );
  if (!dates.ok) return new Response("Perioada nu e validă (AAAA-LL-ZZ)", { status: 400 });
  const statusParam = url.searchParams.get("stare");
  const status = RETURN_STATUSES.find((value) => value === statusParam);
  const rows = await returnReasonReport(getDb(), {
    ...(dates.from ? { from: dates.from } : {}),
    ...(dates.to ? { to: dates.to } : {}),
    ...(status ? { status } : {}),
  });
  const table: string[][] = [
    [...m.reasonReport.csvHeader],
    ...rows.map((row) => [
      m.reasons[row.reasonCode] ?? row.reasonCode,
      String(row.returns),
      String(row.lines),
      String(row.pieces),
    ]),
  ];
  return csvResponse(table, "retururi-motive.csv");
}
