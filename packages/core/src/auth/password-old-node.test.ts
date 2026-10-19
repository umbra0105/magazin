import { describe, expect, it, vi } from "vitest";
import type * as NodeCrypto from "node:crypto";

// Simulează un Node fără `crypto.argon2` (înainte de 24.7.0)
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof NodeCrypto>();
  return { ...original, argon2: undefined };
});

import { hashPassword, verifyPassword } from "./password";

describe("parole pe un Node prea vechi", () => {
  it("hashPassword dă un mesaj clar, în română, cu versiunea minimă", async () => {
    await expect(hashPassword("orice")).rejects.toThrow(
      /Node\.js 24\.7\.0 sau mai nou \(crypto\.argon2\)/,
    );
  });

  it("verifyPassword nu aruncă (false), fiindcă nu poate verifica", async () => {
    const hash = `$argon2id$v=19$m=19456,t=2,p=1$${"A".repeat(22)}$${"A".repeat(43)}`;
    expect(await verifyPassword({ hash, password: "orice" })).toBe(false);
  });
});
