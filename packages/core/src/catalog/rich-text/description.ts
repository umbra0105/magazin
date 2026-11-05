import type { PrismaClient } from "@ecom/db";
import { ValidationError } from "@ecom/shared";
import { plainTextToHtml } from "./plain-text";
import {
  sanitizeRichHtml,
  type RichTextOptions,
  type RichTextResult,
  type RichTextStats,
} from "./sanitize";

/**
 * Descrierea produsului la scriere (15c, pasul 4): punctul comun prin care trece ORICE valoare scrisă în
 * `Product.description` (un test de arhitectură o impune). Pași:
 *  1. text simplu (din formularul vechi, din CSV) → paragrafe cu escape; HTML → sanitizare cu lista albă;
 *  2. imaginile (`data-media-id`) se verifică în baza de date: fișierul trebuie să existe, să fie imagine și să nu fi eșuat;
 *     cele necunoscute se elimină din HTML;
 *  3. legăturile cu media ale produsului se țin la zi în aceeași tranzacție (`syncDescriptionMedia`).
 */

/** O etichetă sau un comentariu HTML (`<p>`, `</div>`, `<!--`): doar atunci textul e tratat ca HTML, nu ca text simplu. */
const HTML_HINT = /<\/?[a-z][^<>]*>|<!--/i;

export const looksLikeHtml = (text: string): boolean => HTML_HINT.test(text);

/** Sanitizarea PURĂ (fără bază): `null`/gol/doar spații → `html: null`. Aruncă `ValidationError` peste limite. */
export function sanitizeDescription(
  value: string | null | undefined,
  options?: RichTextOptions,
): RichTextResult {
  if (value === null || value === undefined) return sanitizeRichHtml("", options);
  const source = looksLikeHtml(value) ? value : (plainTextToHtml(value) ?? "");
  return sanitizeRichHtml(source, options);
}

/**
 * Forma în care ar fi salvată `value`, pentru COMPARAȚIE în planurile de import (dry-run): ca o descriere deja importată
 * să nu apară «actualizată» doar pentru că în fișier e text simplu sau HTML necurățat. Dacă valoarea e refuzată (prea lungă),
 * se întoarce neschimbată, iar aplicarea o respinge cu mesajul serviciului.
 */
export function normalizeDescriptionForCompare(value: string | null): string | null {
  try {
    return sanitizeDescription(value).html;
  } catch (error) {
    if (error instanceof ValidationError) return value;
    throw error;
  }
}

export interface PreparedDescription {
  /** Ce se scrie în `Product.description`: HTML sanitizat sau `null`. */
  html: string | null;
  /** Fișierele media rămase în HTML, verificate în bază. */
  mediaIds: string[];
  result: RichTextResult;
}

/** Sanitizare + verificarea fișierelor media din bază (două treceri: prima găsește id-urile, a doua păstrează doar ce există). */
export async function prepareDescription(
  db: Pick<PrismaClient, "media">,
  value: string | null | undefined,
): Promise<PreparedDescription> {
  const first = sanitizeDescription(value);
  if (first.mediaIds.length === 0) return { html: first.html, mediaIds: [], result: first };
  const rows = await db.media.findMany({
    where: {
      id: { in: first.mediaIds },
      mime: { startsWith: "image/" },
      status: { not: "failed" },
    },
    select: { id: true },
  });
  const second = sanitizeDescription(value, {
    allowedMediaIds: new Set(rows.map((row) => row.id)),
  });
  return { html: second.html, mediaIds: second.mediaIds, result: second };
}

/** Face legăturile produsului cu fișierele din descriere exact `mediaIds` (le adaugă pe cele noi, le scoate pe cele dispărute). */
export async function syncDescriptionMedia(
  tx: Pick<PrismaClient, "productDescriptionMedia">,
  productId: string,
  mediaIds: readonly string[],
): Promise<void> {
  await tx.productDescriptionMedia.deleteMany({
    where: { productId, ...(mediaIds.length > 0 && { mediaId: { notIn: [...mediaIds] } }) },
  });
  if (mediaIds.length > 0) {
    await tx.productDescriptionMedia.createMany({
      data: mediaIds.map((mediaId) => ({ productId, mediaId })),
      skipDuplicates: true,
    });
  }
}

/**
 * Ce a PIERDUT o descriere la curățare, într-o frază scurtă pentru raportul de import (dry-run): imaginile externe (importul de
 * imagini din descrieri e un punct separat), elementele nepermise (script, iframe, stil…) și shortcode-urile WordPress scoase
 * înainte de sanitizare. Tabelele și linkurile păstrate NU sunt pierderi. `null` când nu s-a pierdut nimic.
 */
export function summarizeDescriptionLosses(
  stats: Pick<RichTextStats, "removedImages" | "removedBlocks" | "failedClosed">,
  shortcodes = 0,
): string | null {
  const parts: string[] = [];
  if (stats.removedImages > 0) {
    parts.push(
      stats.removedImages === 1 ? "1 imagine externă" : `${stats.removedImages} imagini externe`,
    );
  }
  if (stats.removedBlocks > 0) {
    parts.push(
      stats.removedBlocks === 1
        ? "1 element nepermis (script, iframe, stil…)"
        : `${stats.removedBlocks} elemente nepermise (script, iframe, stil…)`,
    );
  }
  if (shortcodes > 0) {
    parts.push(
      shortcodes === 1 ? "1 shortcode WordPress" : `${shortcodes} shortcode-uri WordPress`,
    );
  }
  if (stats.failedClosed) parts.push("conținut nesigur redus la text");
  return parts.length > 0 ? parts.join(", ") : null;
}
