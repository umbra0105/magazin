import { can, csvResponse, isSameOriginRequest, listOrdersForExport } from "@ecom/core";
import { loadEnv } from "@ecom/config";
import { getDb } from "@ecom/db";
import { getAudit } from "@/lib/admin-writes";
import { formatDateTime } from "@/lib/format-date";
import { formatMoneyInput } from "@/lib/money-input";
import { parseOrderListParams } from "@/lib/order-list-params";
import { getSettings } from "@/lib/services";
import { getCurrentSubject } from "@/lib/session";
import { getMessages } from "@/messages";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const t = getMessages().admin.orders;

/**
 * Exportul listei de comenzi în CSV pentru Excel (Faza 11): aceleași filtre ca lista, cel mult 5.000 de comenzi, DOAR prin funcția
 * comună `csvResponse` (UTF-16LE cu BOM, TAB, antet în română). POST (nu GET): cere verificarea originii. Cere
 * `orders.read`; numele și emailul clientului intră doar cu drept de date personale. Exportul se scrie în audit (cine, câte rânduri).
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request.headers, loadEnv().APP_URL)) {
    return new Response("Cerere refuzată", { status: 403 });
  }
  const subject = await getCurrentSubject();
  if (!subject || !can(subject, "orders.read")) {
    return new Response("Nu ai permisiunea să exporți comenzile", { status: 403 });
  }
  const form = await request.formData();
  const query = typeof form.get("query") === "string" ? (form.get("query") as string) : "";
  const regional = await getSettings().getGroup("regional");
  const parsed = parseOrderListParams(new URLSearchParams(query.slice(0, 2000)), {
    timeZone: regional.timezone,
    labels: {},
  });
  const pii = can(subject, "customers.read_pii") || can(subject, "orders.fulfill");
  const { rows, truncated } = await listOrdersForExport(getDb(), parsed.query, { pii });

  const header = [
    "Număr comandă",
    "Data",
    "Stare comandă",
    "Stare plată",
    "Stare livrare",
    "Metodă de plată",
    "Livrare",
    "Total (lei)",
    ...(pii ? ["Client", "Email"] : []),
    "La furnizor",
    "Necesită atenție",
  ];
  const body = rows.map((row) => [
    row.number,
    formatDateTime(row.placedAt, regional.locale, regional.timezone),
    t.statuses[row.status] ?? row.status,
    t.paymentStatuses[row.paymentStatus] ?? row.paymentStatus,
    t.fulfillmentStatuses[row.fulfillmentStatus] ?? row.fulfillmentStatus,
    t.methods[row.paymentMethod] ?? row.paymentMethod,
    t.deliveryKinds[row.delivery] ?? row.delivery,
    formatMoneyInput(row.totalMinor),
    ...(pii ? [row.customerName ?? "", row.email ?? ""] : []),
    row.supplier ? "Da" : "Nu",
    row.attention || row.needsRefund ? "Da" : "Nu",
  ]);
  await getAudit().record({
    actorId: subject.userId,
    actorLabel: subject.email,
    action: "order.export",
    entity: "order",
    entityId: "list",
    after: { rows: rows.length, truncated, withContact: pii },
  });
  const response = csvResponse([header, ...body], "comenzi.csv");
  if (truncated) response.headers.set("X-Export-Truncated", "1");
  return response;
}
