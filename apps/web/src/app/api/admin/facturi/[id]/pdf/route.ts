import { can } from "@ecom/core";
import { getAudit } from "@/lib/admin-writes";
import { errorCodeOf } from "@/lib/error-code";
import { getInvoiceService } from "@/lib/invoicing";
import { getCurrentSubject } from "@/lib/session";
import { getDb } from "@ecom/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * PDF-ul unui document fiscal (Faza 13). GET, cu `invoices.read`. PDF-ul se cere furnizorului la fiecare descărcare (nu se păstrează
 * la noi, deci nu se păstrează nici datele clientului); răspunsul nu se pune în cache. Fără permisiune sau fără sesiune: 403. Jurnalul
 * de audit păstrează cine a descărcat și ce document (serie și număr), fără date ale clientului. Un document SIMULAT (DEMO) are în PDF
 * marcajul «SIMULAT, nu este document fiscal».
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const subject = await getCurrentSubject();
  if (!subject || !can(subject, "invoices.read")) {
    return new Response("Nu ai permisiunea să descarci facturi", { status: 403 });
  }
  const { id } = await params;
  const doc = await getDb().invoice.findUnique({
    where: { id },
    select: { id: true, orderId: true, series: true, number: true, kind: true },
  });
  if (!doc) return new Response("Documentul nu există", { status: 404 });
  try {
    const { pdf, fileName } = await getInvoiceService().pdf(id);
    await getAudit().record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "invoice.pdf",
      entity: "order",
      entityId: doc.orderId,
      after: { kind: doc.kind, series: doc.series, number: doc.number },
    });
    const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    return new Response(pdf.bytes as BodyInit, {
      headers: {
        "content-type": pdf.contentType,
        "content-disposition": `inline; filename="${safe}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const code = errorCodeOf(error, ["INVOICE_"]);
    // mesajul furnizorului nu se arată (poate conține date); doar un cod stabil
    return new Response(
      code === "INVOICE_STATE_INVALID"
        ? "Documentul nu e emis încă"
        : "PDF-ul nu a putut fi descărcat",
      { status: code === "INVOICE_STATE_INVALID" ? 409 : 502 },
    );
  }
}
