import { checkImageUrl, type ParsedImageUrl } from "../../../media/image-url";

/** Rezultatul verificării unei adrese: ca `ImageUrlCheck`, dar cu motive text (și «too_many_for_import»). */
export type DescriptionImageCheck =
  ({ ok: true } & ParsedImageUrl) | { ok: false; reason: string; host: string | null };

/**
 * Imaginile din descrierile WooCommerce (15d), partea PURĂ: fără rețea, fără bază de date.
 *
 * Fluxul: la planificare, fiecare `<img>` extern din HTML-ul brut al descrierii devine un MARCAJ de text `{{img:<hash>}}`
 * (poziția în text se păstrează; sanitizatorul comun lasă textul, nu etichetele), iar adresa trece prin aceleași reguli fără
 * rețea ca imaginile produsului (`checkImageUrl`). După descărcare, fiecare marcaj devine `<img data-media-id="…">` (singura
 * formă de imagine pe care o acceptă sanitizatorul), iar marcajele imaginilor eșuate dispar. La randare, marcajele rămase
 * (imagini încă neaduse) se scot, ca nimeni să nu vadă text tehnic.
 *
 * Nimic de aici nu scrie HTML în bază: rezultatul trece oricum prin `sanitizeDescription` / `prepareDescription`, care rămân
 * singura cale spre `Product.description`.
 */

/** Câte caractere din hash-ul adresei (sha256 hex) intră în marcaj; sarcinile se găsesc prin prefix. */
export const DESCRIPTION_TOKEN_LENGTH = 24;

const TOKEN = new RegExp(`\\{\\{img:([a-f0-9]{${DESCRIPTION_TOKEN_LENGTH}})\\}\\}`, "g");
const IMG_TAG = /<img\b[^>]*>/gi;
const ATTRIBUTE = (name: string): RegExp =>
  new RegExp(`(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
const SRC = ATTRIBUTE("src");
const LAZY_SOURCES = [
  ATTRIBUTE("data-src"),
  ATTRIBUTE("data-lazy-src"),
  ATTRIBUTE("data-original"),
];
const SAFE_MEDIA_ID = /^[A-Za-z0-9_-]{8,40}$/;

export interface DescriptionImageCandidate {
  /** sha256 hex al adresei normalizate (cheia de idempotență, ca la imaginile produsului). */
  hash: string;
  /** Adresa normalizată (https), doar pentru descărcare; nu se scrie în raport sau în loguri. */
  url: string;
  host: string;
  /** Ordinea printre imaginile ACCEPTATE ale descrierii. */
  position: number;
}

export interface DescriptionImageIssue {
  /** Ordinea în descriere, printre TOATE imaginile (acceptate sau nu). */
  position: number;
  host: string | null;
  /** Cod stabil (`host_not_allowed`, `scheme`, `invalid`, `too_many_for_product` …); fără adresa completă. */
  reason: string;
}

export interface ExtractedDescription {
  /** HTML-ul brut, cu imaginile acceptate înlocuite prin marcaje și cele respinse scoase. */
  html: string;
  images: DescriptionImageCandidate[];
  issues: DescriptionImageIssue[];
  /** Toate etichetele `<img>` găsite. */
  total: number;
}

export type TokenResolution =
  { kind: "media"; mediaId: string } | { kind: "drop" } | { kind: "keep" };

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", quot: '"', apos: "'" };

/** Doar entitățile care apar în adrese: `&amp;`, `&quot;`, `&#38;`, `&#x26;`. */
function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number.parseInt(dec, 10));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return NAMED_ENTITIES[String(name).toLowerCase()] ?? whole;
  });
}

const attributeValue = (tag: string, pattern: RegExp): string | null => {
  const match = pattern.exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
};

/** Adresa unei imagini: `src`, sau atributul de încărcare întârziată când `src` e un substituent (`data:`) sau lipsește. */
function sourceOf(tag: string): string {
  const src = attributeValue(tag, SRC);
  if (src !== null && src.trim() !== "" && !/^data:/i.test(src.trim()))
    return decodeEntities(src.trim());
  for (const pattern of LAZY_SOURCES) {
    const lazy = attributeValue(tag, pattern);
    if (lazy !== null && lazy.trim() !== "") return decodeEntities(lazy.trim());
  }
  return "";
}

/**
 * Pasul de planificare: scoate imaginile din HTML-ul brut. Un marcaj scris de mână în text (nu produs de noi) se șterge
 * ÎNAINTE, ca nimeni să nu poată ordona înlocuirea unei imagini alese de el.
 */
export function extractDescriptionImages(
  html: string,
  check: (raw: string) => DescriptionImageCheck,
  limits: { maxPerProduct: number },
): ExtractedDescription {
  const images: DescriptionImageCandidate[] = [];
  const issues: DescriptionImageIssue[] = [];
  const seen = new Map<string, DescriptionImageCandidate>();
  let total = 0;
  const cleaned = html.replace(TOKEN, "");
  const out = cleaned.replace(IMG_TAG, (tag) => {
    const position = total;
    total += 1;
    const raw = sourceOf(tag);
    const result = check(raw);
    if (!result.ok) {
      issues.push({ position, host: result.host, reason: result.reason });
      return "";
    }
    const known = seen.get(result.sourceHash);
    if (!known) {
      if (images.length >= limits.maxPerProduct) {
        issues.push({ position, host: null, reason: "too_many_for_product" });
        return "";
      }
      const candidate: DescriptionImageCandidate = {
        hash: result.sourceHash,
        url: result.href,
        host: result.host,
        position: images.length,
      };
      images.push(candidate);
      seen.set(result.sourceHash, candidate);
    }
    return `{{img:${result.sourceHash.slice(0, DESCRIPTION_TOKEN_LENGTH)}}}`;
  });
  return { html: out, images, issues, total };
}

/** Adresele imaginilor dintr-un HTML brut (doar pentru căutarea fișierelor deja aduse; nu se verifică domeniile). */
export function descriptionImageUrls(html: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(IMG_TAG)) {
    const source = sourceOf(match[0]);
    if (source !== "") urls.push(source);
  }
  return urls;
}

/** Marcajele dintr-un HTML, în ordinea apariției, fără dubluri. */
export function descriptionTokensIn(html: string | null): string[] {
  if (!html) return [];
  const found: string[] = [];
  for (const match of html.matchAll(TOKEN)) {
    const id = match[1] as string;
    if (!found.includes(id)) found.push(id);
  }
  return found;
}

/** Scoate toate marcajele (la randare: imaginile încă neaduse nu se văd ca text tehnic). */
export function stripDescriptionTokens(html: string): string {
  return html.replace(TOKEN, "");
}

/** Înlocuiește marcajele după rezoluția fiecăruia; un id de media nesigur nu intră niciodată în HTML. */
export function resolveDescriptionTokens(
  html: string,
  resolve: (token: string) => TokenResolution,
): { html: string; replaced: number; dropped: number; kept: number } {
  let replaced = 0;
  let dropped = 0;
  let kept = 0;
  const out = html.replace(TOKEN, (whole, token: string) => {
    const resolution = resolve(token);
    if (resolution.kind === "keep") {
      kept += 1;
      return whole;
    }
    if (resolution.kind === "media" && SAFE_MEDIA_ID.test(resolution.mediaId)) {
      replaced += 1;
      return `<img data-media-id="${resolution.mediaId}" alt="">`;
    }
    dropped += 1;
    return "";
  });
  return { html: out, replaced, dropped, kept };
}

/** Adaugă la sfârșit imaginile care nu sunt deja în descriere (reluarea unei imagini al cărei marcaj a dispărut). */
export function appendDescriptionImages(html: string | null, mediaIds: readonly string[]): string {
  let out = html ?? "";
  for (const mediaId of mediaIds) {
    if (!SAFE_MEDIA_ID.test(mediaId)) continue;
    if (out.includes(`data-media-id="${mediaId}"`)) continue;
    out += `<p><img data-media-id="${mediaId}" alt=""></p>`;
  }
  return out;
}

export interface DescriptionImagePolicy {
  allowedHosts: readonly string[];
  maxUrlLength: number;
  maxImagesPerProduct: number;
  maxImagesPerImport: number;
}

export interface DescriptionImageStats {
  total: number;
  accepted: number;
  rejected: number;
  /** Imaginile care există deja în bibliotecă (înlocuite pe loc în plan, fără sarcină). */
  alreadyInLibrary: number;
  byHost: Record<string, number>;
  rejectedByReason: Record<string, number>;
}

export interface PlannedDescriptionImages {
  /** HTML-ul brut pregătit pentru sanitizare: marcaje pentru imaginile de adus, `<img data-media-id>` pentru cele existente. */
  html: string;
  /** Imaginile de adus (cele deja în bibliotecă nu mai apar aici). */
  tasks: DescriptionImageCandidate[];
  issues: DescriptionImageIssue[];
  stats: DescriptionImageStats;
  /**
   * Fișierele deja din bibliotecă pe care planul le-a pus în HTML (`<img data-media-id>`): singurele id-uri de media pe care
   * sanitizatorul are voie să le păstreze din acest HTML (un `<img data-media-id>` scris de mână în fișier se elimină ÎNAINTE).
   */
  mediaIds: string[];
}

/**
 * Planul imaginilor unei descrieri, fără rețea. `policy = null` (opțiunea oprită) = comportamentul din 15c: imaginile externe se
 * elimină. Altfel: adresele trec prin `checkImageUrl`; cele acceptate rămân ca marcaje, iar cele al căror fișier există deja în
 * bibliotecă (`mediaBySourceHash`) devin direct `<img data-media-id>` (deci o a doua rulare dă aceeași descriere, «neschimbată»).
 * `budget.accepted` numără imaginile acceptate din tot importul (limita pe import).
 */
export function planDescriptionImages(
  html: string,
  policy: DescriptionImagePolicy | null,
  mediaBySourceHash: ReadonlyMap<string, string>,
  budget: { accepted: number },
): PlannedDescriptionImages {
  const stats: DescriptionImageStats = {
    total: 0,
    accepted: 0,
    rejected: 0,
    alreadyInLibrary: 0,
    byHost: {},
    rejectedByReason: {},
  };
  if (!policy) return { html, tasks: [], issues: [], stats, mediaIds: [] };

  // imaginile acceptate ale importului (limita pe import); aceeași adresă de două ori în descriere se numără o dată
  const counted = new Set<string>();
  const extracted = extractDescriptionImages(
    html,
    (raw) => {
      const parsed = checkImageUrl(raw, policy);
      if (!parsed.ok) return parsed;
      if (!counted.has(parsed.sourceHash)) {
        if (budget.accepted + counted.size >= policy.maxImagesPerImport) {
          return { ok: false, reason: "too_many_for_import", host: null };
        }
        counted.add(parsed.sourceHash);
      }
      return parsed;
    },
    { maxPerProduct: policy.maxImagesPerProduct },
  );
  budget.accepted += counted.size;
  const tasks: DescriptionImageCandidate[] = [];
  for (const image of extracted.images) {
    stats.accepted += 1;
    stats.byHost[image.host] = (stats.byHost[image.host] ?? 0) + 1;
    if (mediaBySourceHash.has(image.hash)) stats.alreadyInLibrary += 1;
    else tasks.push({ ...image, position: tasks.length });
  }
  for (const issue of extracted.issues) {
    stats.rejected += 1;
    stats.rejectedByReason[issue.reason] = (stats.rejectedByReason[issue.reason] ?? 0) + 1;
  }
  stats.total = extracted.total;
  const resolved = resolveDescriptionTokens(extracted.html, (token) => {
    const image = extracted.images.find((candidate) => candidate.hash.startsWith(token));
    const mediaId = image ? mediaBySourceHash.get(image.hash) : undefined;
    return mediaId ? { kind: "media", mediaId } : { kind: "keep" };
  });
  const mediaIds = extracted.images
    .map((image) => mediaBySourceHash.get(image.hash))
    .filter((id): id is string => id !== undefined);
  return { html: resolved.html, tasks, issues: extracted.issues, stats, mediaIds };
}

export const emptyDescriptionStats = (): DescriptionImageStats => ({
  total: 0,
  accepted: 0,
  rejected: 0,
  alreadyInLibrary: 0,
  byHost: {},
  rejectedByReason: {},
});

/** Adaugă planul unei descrieri la planul de ansamblu al importului (numărători și respingeri, fără adrese). */
export function mergeDescriptionImagePlan(
  target: {
    stats: DescriptionImageStats;
    issues: { row: number; sku: string; position: number; host: string | null; reason: string }[];
  },
  prepared: PlannedDescriptionImages,
  row: number,
  sku: string,
): void {
  const { stats } = prepared;
  target.stats.total += stats.total;
  target.stats.accepted += stats.accepted;
  target.stats.rejected += stats.rejected;
  target.stats.alreadyInLibrary += stats.alreadyInLibrary;
  for (const [host, count] of Object.entries(stats.byHost)) {
    target.stats.byHost[host] = (target.stats.byHost[host] ?? 0) + count;
  }
  for (const [reason, count] of Object.entries(stats.rejectedByReason)) {
    target.stats.rejectedByReason[reason] = (target.stats.rejectedByReason[reason] ?? 0) + count;
  }
  for (const issue of prepared.issues) target.issues.push({ row, sku, ...issue });
}
