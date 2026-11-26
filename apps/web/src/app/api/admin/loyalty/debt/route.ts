import { can, csvResponse } from "@ecom/core";
import { getAudit } from "@/lib/admin-writes";
import { getLoyaltyAdminService } from "@/lib/loyalty-admin";
import { formatMoneyInput } from "@/lib/money-input";
import { getFeatureFlags } from "@/lib/services";
import { getCurrentSubject } from "@/lib/session";
import { getMessages } from "@/messages";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const m = getMessages().admin.loyalty.debt.csv;

/**
 * Raportul «datorie în puncte» în CSV pentru Excel (Faza 15b), DOAR prin `csvResponse` (UTF-16LE cu BOM, TAB). Cere
 * `loyalty.view` și flag-ul `loyalty`. Nu conține date personale; descărcarea se scrie în audit.
 */
export async function GET(): Promise<Response> {
  if (!(await getFeatureFlags().isEnabled("loyalty"))) {
    return new Response("Pagina nu există", { status: 404 });
  }
  const subject = await getCurrentSubject();
  if (!subject || !can(subject, "loyalty.view")) {
    return new Response("Nu ai permisiunea să descarci raportul", { status: 403 });
  }
  const report = await getLoyaltyAdminService().debtReport(subject);
  const header = [m.row, m.month, m.points, m.value];
  const body = [
    ...report.months.map((row) => [
      m.monthRow,
      row.month,
      String(row.points),
      formatMoneyInput(row.valueMinor),
    ]),
    [m.totalRow, "", String(report.availablePoints), formatMoneyInput(report.availableMinor)],
    [m.pendingRow, "", String(report.pendingPoints), formatMoneyInput(report.pendingMinor)],
    [m.negativeRow, "", String(report.negativePoints), ""],
  ];
  await getAudit().record({
    actorId: subject.userId,
    actorLabel: subject.email,
    action: "loyalty.debt.export",
    entity: "loyalty_account",
    entityId: "debt",
    after: { rows: body.length },
  });
  return csvResponse([header, ...body], m.fileName);
}
