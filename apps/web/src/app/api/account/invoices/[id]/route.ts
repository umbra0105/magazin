import { findOwnedInvoiceId } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { getCustomer } from "@/lib/account";
import { getInvoiceService } from "@/lib/invoicing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * PDF-ul unei facturi, pentru CLIENT (Faza 14). Servire printr-o rută cu verificare de proprietate (nu un URL permanent public):
 * documentul trebuie să fie emis și să aparțină unei comenzi a clientului autentificat (proprietatea se stabilește din emailul
 * VERIFICAT sau din `customerId`). Un document străin sau inexistent dă același 404. PDF-ul se cere furnizorului la fiecare descărcare
 * și nu se pune în cache. Documentele simulate poartă în PDF marcajul «SIMULAT, nu este document fiscal».
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const customer = await getCustomer();
  if (!customer) return new Response("Autentificare necesară", { status: 401 });
  const { id } = await params;
  const owned = await findOwnedInvoiceId(getDb(), customer.user, id);
  if (!owned) return new Response("Documentul nu există", { status: 404 });
  try {
    const { pdf, fileName } = await getInvoiceService().pdf(owned);
    const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    return new Response(pdf.bytes as BodyInit, {
      headers: {
        "content-type": pdf.contentType,
        "content-disposition": `attachment; filename="${safe}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    getLogger().error({ err: error }, "descărcarea facturii clientului a eșuat");
    return new Response("PDF-ul nu a putut fi descărcat", { status: 502 });
  }
}
