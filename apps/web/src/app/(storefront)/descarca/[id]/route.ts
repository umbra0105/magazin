import { NextResponse } from "next/server";
import { getDb } from "@ecom/db";
import { getStorage } from "@/lib/media";

export const dynamic = "force-dynamic";

/** Cât ține linkul semnat al unui document (secunde): destul ca să înceapă descărcarea, nu ca să fie împărțit. */
const LINK_SECONDS = 120;

/**
 * Descărcarea unui document de produs din tabul «Descărcări». Documentul se servește DOAR dacă e marcat pentru tab și produsul e
 * activ și nesters; apoi redirecționează la un link semnat, cu expirare scurtă, către storage (adresa permanentă a fișierului nu
 * apare niciodată în pagină, care poate sta ore în cache). Orice altceva: 404, fără detalii.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const document = await getDb().productDocument.findFirst({
    where: { id, showInTab: true, product: { status: "active", deletedAt: null } },
    select: { storageKey: true, originalName: true },
  });
  if (!document) return new NextResponse(null, { status: 404 });
  const url = await getStorage().signedUrl(document.storageKey, {
    expiresInSeconds: LINK_SECONDS,
    downloadFilename: document.originalName,
  });
  return NextResponse.redirect(url, {
    status: 302,
    headers: { "Cache-Control": "private, no-store" },
  });
}
