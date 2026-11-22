import { can, getShipmentLabel } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getAudit } from "@/lib/admin-writes";
import { errorCodeOf } from "@/lib/error-code";
import { getCarrierRuntime } from "@/lib/shipping";
import { getCurrentSubject } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Eticheta AWB (PDF sau ZPL) a unei expedieri prin curier (Faza 12). GET, cu `orders.fulfill`. Eticheta se cere curierului la
 * fiecare descărcare (nu se păstrează la noi, deci nu se păstrează nici datele clientului); răspunsul nu se pune în cache. Fără
 * `orders.fulfill` sau fără sesiune: 403. Jurnalul de audit păstrează cine a descărcat și ce AWB, fără date ale clientului.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const subject = await getCurrentSubject();
  if (!subject || !can(subject, "orders.fulfill")) {
    return new Response("Nu ai permisiunea să descarci etichete", { status: 403 });
  }
  const { id } = await params;
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "zpl" ? "zpl" : "pdf";
  const db = getDb();
  const shipment = await db.shipment.findUnique({
    where: { id },
    select: { id: true, orderId: true, provider: true, awb: true, mode: true },
  });
  if (!shipment || shipment.mode !== "provider" || !shipment.provider) {
    return new Response("Expedierea nu are etichetă de la curier", { status: 404 });
  }
  const carrier = await getCarrierRuntime().carrier(shipment.provider);
  if (!carrier) return new Response("Curierul nu este configurat", { status: 409 });
  try {
    const label = await getShipmentLabel(db, carrier, shipment.id, format);
    await getAudit().record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "shipment.label",
      entity: "order",
      entityId: shipment.orderId,
      after: { awb: shipment.awb, format },
    });
    const safeAwb = shipment.awb.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
    return new Response(label.bytes as BodyInit, {
      headers: {
        "content-type": label.contentType,
        "content-disposition": `${format === "pdf" ? "inline" : "attachment"}; filename="eticheta-${safeAwb}.${format}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const code = errorCodeOf(error, ["SHIPMENT_", "SHIPPING_"]);
    // mesajul curierului nu se arată (poate conține date); doar un cod stabil
    return new Response(
      code === "SHIPPING_UNSUPPORTED"
        ? "Formatul nu e oferit de curier"
        : "Eticheta nu a putut fi descărcată",
      {
        status: code === "SHIPPING_UNSUPPORTED" ? 422 : 502,
      },
    );
  }
}
