import { z } from "zod";
import { EmailVerificationService } from "@ecom/core";
import { getDb } from "@ecom/db";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ token: z.string().min(16).max(512) });

const headers = { "Cache-Control": "no-store" };
const invalid = () => Response.json({ code: "INVALID_TOKEN" }, { status: 400, headers });

/**
 * Confirmă emailul cu tokenul primit prin link. Se face pe POST (nu pe GET): scanerele de linkuri
 * ale clienților de email deschid adresele din mesaje și ar consuma tokenul înainte de utilizator.
 * Tokenul e de unică folosință; „inexistent”, „folosit” și „expirat” primesc același răspuns.
 */
export async function POST(request: Request): Promise<Response> {
  let token: string;
  try {
    token = bodySchema.parse(await request.json()).token;
  } catch {
    return invalid();
  }
  const result = await new EmailVerificationService(getDb()).consume(token);
  if (result.status !== "verified") return invalid();
  return Response.json({ ok: true }, { headers });
}
