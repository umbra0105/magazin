import { z } from "zod";
import { decrypt, deriveKey, encrypt } from "../crypto";

/**
 * Joburile de email poartă tokenuri (verificare, resetare). Ca niciun token să nu stea în clar în
 * Redis (nici în joburile eșuate păstrate pentru diagnostic), payload-ul se criptează cu o cheie
 * derivată din `APP_KEY`, dedicată acestui scop (AES-256-GCM, același mecanism ca la credențiale).
 */
export const EMAIL_JOB_KEY_LABEL = "ecom/email-jobs/v1";

export const emailPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("verify-email"),
    to: z.string().min(3),
    name: z.string(),
    token: z.string().min(16),
    validForHours: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("reset-password"),
    to: z.string().min(3),
    name: z.string(),
    token: z.string().min(16),
    validForMinutes: z.number().int().positive(),
  }),
  // «Anunță-mă când revine»: doar identificatorul cererii. Adresa rămâne în baza de date până la `claim` și nu intră
  // niciodată în Redis (nici criptată); identificatorul e și parte din `jobId`, deci are formă sigură (litere, cifre, `_`, `-`).
  z.object({
    kind: z.literal("back-in-stock"),
    alertId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  }),
]);

export type EmailPayload = z.infer<typeof emailPayloadSchema>;
export type EmailKind = EmailPayload["kind"];

/** Ce se pune în coadă: doar tipul (pentru diagnostic) și payload-ul criptat. */
export interface SealedEmailJob {
  kind: EmailKind;
  sealed: string;
}

export function sealEmailPayload(appKey: string, payload: EmailPayload): SealedEmailJob {
  const key = deriveKey(appKey, EMAIL_JOB_KEY_LABEL);
  return { kind: payload.kind, sealed: encrypt(JSON.stringify(payload), key) };
}

/** Aruncă dacă payload-ul e alterat, criptat cu altă cheie sau nu respectă schema. */
export function openEmailPayload(appKey: string, job: SealedEmailJob): EmailPayload {
  const key = deriveKey(appKey, EMAIL_JOB_KEY_LABEL);
  return emailPayloadSchema.parse(JSON.parse(decrypt(job.sealed, key)));
}
