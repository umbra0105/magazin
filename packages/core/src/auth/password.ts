import { hash, verify } from "@node-rs/argon2";

/**
 * Parametrii argon2id (recomandarea OWASP: 19 MiB, 2 iterații, 1 fir). Hash-ul rezultat
 * conține parametrii, deci îi putem înăspri mai târziu fără să invalidăm parolele existente.
 */
const ARGON2_OPTIONS = {
  // 2 = Algorithm.Argon2id; enum-ul `const` din pachet nu poate fi importat cu isolatedModules.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** `false` și pentru un hash corupt sau în alt format: verificarea nu aruncă niciodată. */
export async function verifyPassword(data: { hash: string; password: string }): Promise<boolean> {
  try {
    return await verify(data.hash, data.password);
  } catch {
    return false;
  }
}
