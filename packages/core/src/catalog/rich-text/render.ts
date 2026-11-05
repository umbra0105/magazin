import { sanitizeDescription } from "./description";
import { plainTextToHtml, richTextToPlain } from "./plain-text";
import { findRichHtmlViolations } from "./verify";

/**
 * Randarea descrierii bogate (15c, pasul 5): din ce e în baza de date în HTML gata de pus în pagină.
 *
 *  1. valoarea se RE-SANITIZEAZĂ (nu avem încredere în ce citim: un rând scris direct în bază sau o versiune veche a
 *     sanitizatorului nu pot ajunge în pagină); rezultatul se ține minte (memorie mică, după textul însuși);
 *  2. `<img data-media-id>` devine `<img src srcset sizes width height alt loading=lazy decoding=async>` din adresele
 *     fișierului media (adresa nu vine niciodată din HTML); o imagine al cărei fișier nu mai există dispare;
 *  3. fiecare `<table>` intră într-o regiune derulabilă accesibilă (tabelele largi nu lărgesc pagina);
 *  4. rezultatul final se verifică pe aceeași cale independentă ca la scriere; la orice încălcare se întoarce textul.
 *
 * O descriere imposibil de randat (peste limite) dă șir gol: pagina produsului nu trebuie să cadă din cauza ei.
 */

export interface RenderedMedia {
  src: string;
  srcset: string | null;
  width: number | null;
  height: number | null;
}

export type MediaResolver = (ids: readonly string[]) => Promise<ReadonlyMap<string, RenderedMedia>>;

export interface RenderOptions {
  /** Eticheta accesibilă a regiunii derulabile din jurul unui tabel (din mesaje, în română). */
  tableLabel: string;
  /** Atributul `sizes` al imaginilor din descriere. */
  imageSizes: string;
}

interface Sanitized {
  html: string;
  mediaIds: readonly string[];
}

const CACHE_MAX = 128;
const cache = new Map<string, Sanitized | null>();

function sanitizeCached(value: string): Sanitized | null {
  if (cache.has(value)) return cache.get(value) ?? null;
  let entry: Sanitized | null = null;
  try {
    const result = sanitizeDescription(value);
    if (result.html !== null) entry = { html: result.html, mediaIds: result.mediaIds };
  } catch {
    // valoare imposibil de randat (prea lungă): șir gol, nu o pagină căzută
    entry = null;
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(value, entry);
  return entry;
}

const escapeAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** Cale locală («/…», nu «//») sau http(s), fără spații sau caractere de control. */
const CONTROL_CHARS = `${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}`;
const SAFE_SRC = new RegExp(`^(?:/(?![/\\\\])|https?://)[^\\s${CONTROL_CHARS}]+$`, "i");

/** Forma imaginii din ieșirea sanitizatorului (atributele în această ordine, ghilimele duble). */
const SANITIZED_IMG = /<img alt="([^"]*)" data-media-id="([A-Za-z0-9_-]{8,40})" \/>/g;

/** Formele pe care le adaugă randarea; verificarea finală le scoate înainte să caute altceva. */
const RENDERED_IMG =
  /<img src="[^"<>]*"(?: srcset="[^"<>]*" sizes="[^"<>]*")?(?: width="\d+" height="\d+")? alt="[^"<>]*" loading="lazy" decoding="async" \/>/g;
const RENDERED_SCROLL_OPEN =
  /<div class="rich-text__scroll" role="region" tabindex="0" aria-label="[^"<>]*">/g;

function imageTag(media: RenderedMedia, alt: string, options: RenderOptions): string {
  const parts = [`src="${escapeAttribute(media.src)}"`];
  if (media.srcset) {
    parts.push(
      `srcset="${escapeAttribute(media.srcset)}"`,
      `sizes="${escapeAttribute(options.imageSizes)}"`,
    );
  }
  if (media.width !== null && media.height !== null) {
    parts.push(`width="${Math.trunc(media.width)}"`, `height="${Math.trunc(media.height)}"`);
  }
  parts.push(`alt="${alt}"`, 'loading="lazy"', 'decoding="async"');
  return `<img ${parts.join(" ")} />`;
}

export async function renderRichText(
  value: string | null | undefined,
  resolve: MediaResolver,
  options: RenderOptions,
): Promise<string> {
  if (value === null || value === undefined) return "";
  const entry = sanitizeCached(value);
  if (!entry) return "";

  const media =
    entry.mediaIds.length > 0 ? await resolve(entry.mediaIds) : new Map<string, RenderedMedia>();
  const scrollOpen = `<div class="rich-text__scroll" role="region" tabindex="0" aria-label="${escapeAttribute(options.tableLabel)}">`;
  const html = entry.html
    .replace(SANITIZED_IMG, (_match, alt: string, id: string) => {
      const found = media.get(id);
      return found && SAFE_SRC.test(found.src) ? imageTag(found, alt, options) : "";
    })
    .replaceAll("<table>", `${scrollOpen}<table>`)
    .replaceAll("</table>", "</table></div>");

  const rest = html.replace(RENDERED_IMG, "").replace(RENDERED_SCROLL_OPEN, "<div>");
  if (findRichHtmlViolations(rest).length > 0) {
    return plainTextToHtml(richTextToPlain(entry.html)) ?? "";
  }
  return html;
}
