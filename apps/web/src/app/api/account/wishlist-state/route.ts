import { wishlistVariantIds } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getCustomer, isFlagOn } from "@/lib/account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Starea favoritelor pentru butoanele «inimă» (Faza 14): dacă vizitatorul e autentificat și ce variante are salvate. Cu flag-ul
 * `wishlist` oprit: 404 (nicio funcționalitate). Răspunsul nu se pune în cache și conține doar identificatorii variantelor clientului.
 */
export async function GET(): Promise<Response> {
  if (!(await isFlagOn("wishlist"))) return new Response("Not found", { status: 404 });
  const customer = await getCustomer();
  const body = customer
    ? { signedIn: true, ids: await wishlistVariantIds(getDb(), customer.user.id) }
    : { signedIn: false, ids: [] as string[] };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
