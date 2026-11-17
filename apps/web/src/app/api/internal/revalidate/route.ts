import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { loadEnv } from "@ecom/config";
import { isRevalidatableTag, verifyRevalidation } from "@ecom/core";

export const dynamic = "force-dynamic";

/** Cel mult atâtea etichete într-o cerere: o cerere obișnuită are una sau două. */
const MAX_TAGS = 20;
const MAX_BODY_BYTES = 8 * 1024;

const bodySchema = z.object({ tags: z.array(z.string().max(160)).min(1).max(MAX_TAGS) });

/**
 * Invalidarea cache-ului vitrinei de către worker (C-37): `revalidateTag` merge doar în procesul Next, deci workerul trimite
 * aici o cerere semnată HMAC (`createRemoteRevalidator`). Fără semnătură validă și marcă de timp proaspătă: 401, fără alte
 * detalii. Etichetele trebuie să fie din lista permisă (`isRevalidatableTag`), nu orice text.
 */
export async function POST(request: Request) {
  const unauthorized = () =>
    NextResponse.json({ error: { code: "AUTH_UNAUTHENTICATED" } }, { status: 401 });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES)
    return NextResponse.json({ error: { code: "TOO_LARGE" } }, { status: 413 });
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES)
    return NextResponse.json({ error: { code: "TOO_LARGE" } }, { status: 413 });

  const timestamp = Number(request.headers.get("x-revalidate-timestamp"));
  const signature = request.headers.get("x-revalidate-signature") ?? "";
  const valid = verifyRevalidation(loadEnv().APP_KEY, {
    timestamp,
    signature,
    body,
    now: Math.floor(Date.now() / 1000),
  });
  if (!valid) return unauthorized();

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(JSON.parse(body));
  } catch {
    return NextResponse.json({ error: { code: "VALIDATION" } }, { status: 400 });
  }
  const tags = [...new Set(parsed.tags)];
  if (!tags.every(isRevalidatableTag)) {
    return NextResponse.json({ error: { code: "VALIDATION" } }, { status: 400 });
  }
  for (const tag of tags) revalidateTag(tag);
  return new NextResponse(null, { status: 204 });
}
