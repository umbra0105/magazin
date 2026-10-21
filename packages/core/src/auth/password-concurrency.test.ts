import { describe, expect, it } from "vitest";
import {
  PASSWORD_WORK,
  hashPassword,
  isPasswordWorkSaturated,
  passwordWorkStats,
  verifyPassword,
} from "./password";

/**
 * Blocul C, C-06: fiecare cerere de autentificare costă un argon2 (19 MiB) pe pool-ul libuv (4 fire), partajat cu fs, DNS și
 * sharp. ~60 de cereri/s ale unui singur client saturau pool-ul și blocau toată aplicația. Hash-urile rulează acum cu o
 * concurență mărginită, iar când coada e plină rutele de autentificare răspund 429 imediat (`isPasswordWorkSaturated`).
 */

describe("argon2: concurență mărginită", () => {
  it("60 de hash-uri simultane nu rulează niciodată mai mult de PASSWORD_WORK.maxConcurrent deodată și toate reușesc", async () => {
    const before = passwordWorkStats().peakActive;
    const hashes = await Promise.all(
      Array.from({ length: 60 }, (_, i) => hashPassword(`parola-${i}-lunga-12345`)),
    );
    expect(passwordWorkStats().peakActive).toBeLessThanOrEqual(PASSWORD_WORK.maxConcurrent);
    expect(passwordWorkStats().peakActive).toBeGreaterThanOrEqual(Math.min(before, 1));
    expect(
      await verifyPassword({ hash: hashes[7] as string, password: "parola-7-lunga-12345" }),
    ).toBe(true);
    expect(await verifyPassword({ hash: hashes[7] as string, password: "alta" })).toBe(false);
    expect(passwordWorkStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("o coadă lungă marchează lucrarea ca saturată, apoi se golește", async () => {
    expect(isPasswordWorkSaturated()).toBe(false);
    const jobs = Array.from({ length: PASSWORD_WORK.queueLimit + 20 }, (_, i) =>
      hashPassword(`coada-${i}-12345678`),
    );
    expect(isPasswordWorkSaturated()).toBe(true);
    await Promise.all(jobs);
    expect(isPasswordWorkSaturated()).toBe(false);
  }, 60_000);
});
