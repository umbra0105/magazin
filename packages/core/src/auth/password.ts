// import de spațiu de nume: pe un Node fără `crypto.argon2` mesajul de eroare e cel de mai jos, nu o eroare de legare ESM
import * as nodeCrypto from "node:crypto";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * Parolele: Argon2id din `node:crypto` (`crypto.argon2`, apărut în Node 24.7.0; documentat ca parte din modulul
 * `crypto`, stabilitate 2 - Stable), fără modul nativ separat. Varianta asincronă rulează pe pool-ul libuv, deci
 * nu blochează bucla de evenimente.
 *
 * Parametrii (recomandarea OWASP): Argon2id, v=19, 19 MiB, 2 iterații, 1 fir, sare de 16 octeți, tag de 32 de
 * octeți. Formatul stocat e șirul PHC standard `$argon2id$v=19$m=19456,t=2,p=1$<sare>$<tag>` (base64 fără
 * padding), IDENTIC cu cel produs de `@node-rs/argon2`, deci parolele existente rămân valabile fără migrare sau
 * rehash. Parametrii se citesc din hash, deci îi putem înăspri mai târziu fără să invalidăm parolele existente.
 */

const ARGON2_PARAMS = {
  memory: 19_456, // KiB
  passes: 2,
  parallelism: 1,
  saltBytes: 16,
  tagBytes: 32,
} as const;

/**
 * Plafoane pentru parametrii CITIȚI din hash: un hash corupt sau străin nu poate cere memorie sau timp excesiv.
 * Cu o marjă pentru înăsprire viitoare (până la ~2,5× memoria și 2× iterațiile de azi); în afara lor, `false`.
 */
export const PASSWORD_HASH_LIMITS = {
  memory: { min: 8, max: 49_152 }, // KiB (48 MiB)
  passes: { min: 1, max: 4 },
  parallelism: { min: 1, max: 2 },
  saltBytes: { min: 8, max: 32 },
  tagBytes: { min: 16, max: 64 },
} as const;

const MIN_NODE = "24.7.0";

/** Mesaj clar când Node e prea vechi (în loc de un «argon2 is not a function» criptic). */
function requireArgon2(): typeof nodeCrypto.argon2 {
  const argon2: typeof nodeCrypto.argon2 | undefined = nodeCrypto.argon2;
  if (typeof argon2 !== "function") {
    throw new Error(
      `Parolele cer Node.js ${MIN_NODE} sau mai nou (crypto.argon2), iar aici rulează Node.js ${process.versions.node}. ` +
        "Actualizează Node.js la ultima versiune 24 LTS.",
    );
  }
  return argon2;
}

type Argon2Parameters = Parameters<typeof nodeCrypto.argon2>[1];
/**
 * Concurență mărginită pentru argon2 (Blocul C, C-06). Fiecare operație ține ~19 MiB și un fir al pool-ului libuv (4 implicit),
 * partajat cu fs, DNS și sharp: fără limită, un flux de cereri de autentificare ocupa tot pool-ul și oprea aplicația.
 * `maxConcurrent` rulează deodată; restul așteaptă în coadă, iar la `queueLimit` rutele de autentificare răspund 429
 * imediat (`isPasswordWorkSaturated`), în loc să lase coada să crească.
 */
export const PASSWORD_WORK = { maxConcurrent: 2, queueLimit: 64 } as const;

let active = 0;
let peakActive = 0;
const waiting: (() => void)[] = [];

export function passwordWorkStats(): { active: number; queued: number; peakActive: number } {
  return { active, queued: waiting.length, peakActive };
}

/** Coada de operații argon2 e plină: cererile noi de autentificare trebuie respinse imediat (429). */
export function isPasswordWorkSaturated(): boolean {
  return waiting.length >= PASSWORD_WORK.queueLimit;
}

async function withPasswordSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= PASSWORD_WORK.maxConcurrent) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    active++;
  }
  peakActive = Math.max(peakActive, active);
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next)
      next(); // locul rămâne ocupat, trece direct la următorul din coadă
    else active--;
  }
}

const derive = (parameters: Argon2Parameters): Promise<Buffer> =>
  withPasswordSlot(() => promisify(requireArgon2())("argon2id", parameters));

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64").replace(/=+$/, "");

/** Strict: doar Argon2id, versiunea 19, `m,t,p` în această ordine, base64 fără padding. */
const PHC =
  /^\$argon2id\$v=19\$m=(\d{1,10}),t=(\d{1,10}),p=(\d{1,10})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

interface ParsedHash {
  memory: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  tag: Buffer;
}

/** `null` pentru orice nu e un hash Argon2id v19 cu parametri în plafoane. */
function parseHash(hash: string): ParsedHash | null {
  const match = PHC.exec(hash);
  if (!match) return null;
  const memory = Number(match[1]);
  const passes = Number(match[2]);
  const parallelism = Number(match[3]);
  const salt = Buffer.from(match[4] as string, "base64");
  const tag = Buffer.from(match[5] as string, "base64");
  const lim = PASSWORD_HASH_LIMITS;
  const within = (value: number, range: { min: number; max: number }): boolean =>
    Number.isInteger(value) && value >= range.min && value <= range.max;
  if (
    !within(memory, lim.memory) ||
    !within(passes, lim.passes) ||
    !within(parallelism, lim.parallelism) ||
    !within(salt.length, lim.saltBytes) ||
    !within(tag.length, lim.tagBytes) ||
    memory < 8 * parallelism
  ) {
    return null;
  }
  // șirul trebuie să fie exact codarea canonică (fără biți suplimentari în ultimul caracter base64)
  if (b64(salt) !== match[4] || b64(tag) !== match[5]) return null;
  return { memory, passes, parallelism, salt, tag };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(ARGON2_PARAMS.saltBytes);
  const tag = await derive({
    message: Buffer.from(password, "utf8"),
    nonce: salt,
    parallelism: ARGON2_PARAMS.parallelism,
    tagLength: ARGON2_PARAMS.tagBytes,
    memory: ARGON2_PARAMS.memory,
    passes: ARGON2_PARAMS.passes,
  });
  return `$argon2id$v=19$m=${ARGON2_PARAMS.memory},t=${ARGON2_PARAMS.passes},p=${ARGON2_PARAMS.parallelism}$${b64(salt)}$${b64(tag)}`;
}

/**
 * `false` și pentru un hash corupt, în alt format sau cu parametri peste plafon (argon2i/argon2d, versiune
 * veche, memorie excesivă): verificarea nu aruncă niciodată. Compararea tagurilor e în timp constant.
 */
export async function verifyPassword(data: { hash: string; password: string }): Promise<boolean> {
  try {
    const parsed = parseHash(data.hash);
    if (!parsed) return false;
    const tag = await derive({
      message: Buffer.from(data.password, "utf8"),
      nonce: parsed.salt,
      parallelism: parsed.parallelism,
      tagLength: parsed.tag.length,
      memory: parsed.memory,
      passes: parsed.passes,
    });
    return tag.length === parsed.tag.length && timingSafeEqual(tag, parsed.tag);
  } catch {
    return false;
  }
}
