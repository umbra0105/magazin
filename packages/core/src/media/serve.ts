import { Readable } from "node:stream";
import {
  contentDisposition,
  isStorageError,
  verifyClaims,
  visibilityOf,
  type StorageDriver,
} from "@ecom/integrations";
import { getLogger } from "@ecom/shared";

/**
 * Servirea fișierelor, independentă de framework (primește segmentele de cale deja decodate).
 *
 *  - `servePublicObject` (`/media/...`): doar chei `public/…`, doar tipuri de imagine din allowlist,
 *    cache `immutable` (numele conțin un id aleatoriu sau hash de conținut: nu se rescriu niciodată).
 *    Prefixul `public/` se pune AICI, nu vine din cerere: din `/media/...` nu se poate ajunge la
 *    `private/`.
 *  - `serveSignedObject` (`/storage/signed/...`): orice cheie, dar NUMAI cu semnătură HMAC validă și
 *    neexpirată; răspunsul nu se pune niciodată în cache.
 *
 * Orice cheie invalidă (`..`, `%2e%2e`, `\`, NUL, segmente goale, sufixe rezervate) = 404, la fel ca
 * un obiect inexistent: nu aflăm cine încearcă ce.
 */

/** Tipurile pe care le servim public; orice altceva stocat sub `public/` nu se servește. */
const PUBLIC_CONTENT_TYPES = new Set(["image/avif", "image/webp", "image/jpeg", "image/png"]);

const IMMUTABLE = "public, max-age=31536000, immutable";

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  // Un fișier servit direct nu poate încărca nimic și nu poate fi încadrat ca document activ.
  "Content-Security-Policy": "default-src 'none'; sandbox",
};

const notFound = (): Response =>
  new Response("Not found", {
    status: 404,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

const forbidden = (): Response =>
  new Response("Forbidden", {
    status: 403,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

const unavailable = (): Response =>
  new Response("Service unavailable", {
    status: 503,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "30",
    },
  });

function toKey(prefix: string, segments: readonly string[]): string | null {
  if (segments.length === 0) return null;
  const key = `${prefix}${segments.join("/")}`;
  try {
    visibilityOf(key);
  } catch {
    return null;
  }
  return key;
}

function body(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

export async function servePublicObject(
  storage: StorageDriver,
  segments: readonly string[],
): Promise<Response> {
  const key = toKey("public/", segments);
  if (!key) return notFound();

  try {
    const { stream, object } = await storage.get(key);
    if (!PUBLIC_CONTENT_TYPES.has(object.contentType)) {
      stream.destroy();
      return notFound();
    }
    return new Response(body(stream), {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        "Content-Type": object.contentType,
        "Content-Length": String(object.size),
        "Cache-Control": IMMUTABLE,
      },
    });
  } catch (error) {
    if (isStorageError(error) && error.code === "STORAGE_NOT_FOUND") return notFound();
    getLogger().error({ err: error }, "servirea fișierului public a eșuat");
    return unavailable();
  }
}

export interface SignedServeOptions {
  /** Cheia de semnare (vezi `deriveSigningKey`). */
  signingKey: Buffer;
  now?: () => number;
}

/**
 * Link semnat pe driverul local: `?exp=<secunde Unix>&sig=<HMAC>&dl=<nume descărcare>`. Semnătura
 * acoperă cheia, expirarea și numele de descărcare, deci niciunul nu poate fi schimbat.
 */
export async function serveSignedObject(
  storage: StorageDriver,
  segments: readonly string[],
  query: URLSearchParams,
  options: SignedServeOptions,
): Promise<Response> {
  const key = toKey("", segments);
  const exp = Number(query.get("exp"));
  const sig = query.get("sig") ?? "";
  const dl = query.get("dl") ?? undefined;
  // Fără cheie validă sau fără semnătură: același 403, înainte de orice acces la storage.
  if (!key || !Number.isInteger(exp) || sig === "") return forbidden();

  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const valid = verifyClaims(
    { key, expires: exp, ...(dl ? { downloadFilename: dl } : {}) },
    sig,
    options.signingKey,
    nowSeconds,
  );
  if (!valid) return forbidden();

  try {
    const { stream, object } = await storage.get(key);
    return new Response(body(stream), {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        "Content-Type": object.contentType || "application/octet-stream",
        "Content-Length": String(object.size),
        // Conținut privat: nu intră în cache partajat și nu se păstrează.
        "Cache-Control": "private, no-store",
        ...(dl ? { "Content-Disposition": contentDisposition(dl) } : {}),
      },
    });
  } catch (error) {
    if (isStorageError(error) && error.code === "STORAGE_NOT_FOUND") return notFound();
    getLogger().error({ err: error }, "servirea fișierului privat a eșuat");
    return unavailable();
  }
}
