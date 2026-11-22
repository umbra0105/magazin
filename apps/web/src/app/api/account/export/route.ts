import { buildAccountExport } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { allowAccountRequest, getCustomer } from "@/lib/account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Exportul GDPR al contului (Faza 14): un fișier JSON cu datele clientului autentificat (cont, adrese, preferințe, favorite, comenzi
 * cu linii și sume, retururi). Doar datele lui: fără câmpuri interne, fără costuri, fără note ale adminului. Limitat ca frecvență pe
 * client; nu se pune în cache. POST (nu GET), ca un link sau un prefetch să nu-l poată declanșa.
 */
export async function POST(): Promise<Response> {
  const customer = await getCustomer();
  if (!customer) return new Response("Autentificare necesară", { status: 401 });
  if (!(await allowAccountRequest("export", customer.user.id))) {
    return new Response("Prea multe cereri", { status: 429, headers: { "retry-after": "3600" } });
  }
  try {
    const now = new Date();
    const dump = await buildAccountExport(getDb(), customer.user, now);
    const day = now.toISOString().slice(0, 10);
    return new Response(JSON.stringify(dump, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="date-cont-${day}.json"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    getLogger().error({ err: error }, "exportul contului a eșuat");
    return new Response("Exportul nu a putut fi pregătit", { status: 500 });
  }
}
