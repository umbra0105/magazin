import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveKey } from "../crypto/cipher";

/**
 * Invalidarea cache-ului vitrinei din afara aplicației web (C-37). `revalidateTag` există doar în procesul Next; workerul
 * (imagini regenerate, import, stoc) cheamă ruta internă a aplicației, cu o cerere semnată HMAC (cheie derivată din `APP_KEY`,
 * etichetă proprie), marcă de timp (fereastră scurtă, contra reluării) și doar etichete dintr-o listă strictă.
 * Eșecul nu aruncă: o invalidare ratată nu trebuie să strice jobul; TTL-ul paginilor acoperă restul.
 */

export const REVALIDATE_PATH = "/api/internal/revalidate";
export const REVALIDATE_MAX_SKEW_SECONDS = 300;
const KEY_LABEL = "storefront-revalidate-v1";
const TAG =
  /^(catalog|storefront-chrome|(product|product-slug|category|brand):[A-Za-z0-9._/-]{1,100})$/;

/** Eticheta cadrului vitrinei (header, footer, meniu, setări de aspect, steaguri). */
export const STOREFRONT_CHROME_TAG = "storefront-chrome";

export function isRevalidatableTag(tag: string): boolean {
  return TAG.test(tag);
}

export function signRevalidation(appKey: string, timestamp: number, body: string): string {
  return createHmac("sha256", deriveKey(appKey, KEY_LABEL))
    .update(`${timestamp}.${body}`)
    .digest("base64url");
}

export function verifyRevalidation(
  appKey: string,
  input: { timestamp: number; signature: string; body: string; now: number },
): boolean {
  if (!Number.isInteger(input.timestamp)) return false;
  if (Math.abs(input.now - input.timestamp) > REVALIDATE_MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(signRevalidation(appKey, input.timestamp, input.body));
  const given = Buffer.from(input.signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface RemoteRevalidatorOptions {
  appUrl: string;
  appKey: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  logger: { warn(obj: object, msg: string): void };
}

export function createRemoteRevalidator(
  options: RemoteRevalidatorOptions,
): (tags: readonly string[]) => Promise<void> {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const url = `${options.appUrl.replace(/\/+$/, "")}${REVALIDATE_PATH}`;
  return async (tags) => {
    const allowed = [...new Set(tags)].filter(isRevalidatableTag);
    if (allowed.length === 0) return;
    const body = JSON.stringify({ tags: allowed });
    const timestamp = Math.floor(now() / 1000);
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-revalidate-timestamp": String(timestamp),
          "x-revalidate-signature": signRevalidation(options.appKey, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        options.logger.warn(
          { status: response.status },
          "invalidarea cache-ului vitrinei a fost refuzată",
        );
      }
    } catch (error) {
      options.logger.warn({ err: error }, "invalidarea cache-ului vitrinei a eșuat");
    }
  };
}
