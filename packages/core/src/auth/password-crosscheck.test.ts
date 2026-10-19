import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

/**
 * Verificare încrucișată în ambele sensuri între implementarea veche (`@node-rs/argon2`, modul nativ) și cea nouă
 * (`crypto.argon2` din Node). Rulează DOAR unde modulul nativ se încarcă, adică în CI (Linux). Pe PC-ul de dezvoltare
 * cu Windows Smart App Control modulul nativ e blocat la încărcare, iar testul se marchează sărit, cu motiv.
 *
 * Parolele sunt INVENTATE, doar pentru acest test. Hash-urile produse de implementarea veche se tipăresc în
 * log (linii «ARGON2_VECTOR …»), ca să devină valori fixe în testele unitare când modulul nativ e scos.
 */

type Native = {
  hash: (password: string, options: Record<string, unknown>) => Promise<string>;
  verify: (hash: string, password: string) => Promise<boolean>;
};

let native: Native | null = null;
let skipReason = "";
try {
  const moduleName = "@node-rs/argon2";
  native = (await import(/* @vite-ignore */ moduleName)) as Native;
} catch (error) {
  skipReason = `modulul nativ nu se încarcă aici (${(error as Error).name}); verificarea încrucișată rulează în CI`;
}

// aceiași parametri ca implementarea veche (algorithm 2 = Argon2id)
const OLD_OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

const PASSWORDS: [string, string][] = [
  ["ascii", "Parola-de-test-1 cu spații și simboluri !@#$%"],
  ["unicode-nfc", "Șarpele țesut ăîâ 密码🔐 pässwörd"],
  ["unicode-nfd", "é ä ô (forma descompusă)"],
  ["goală", ""],
  ["lungă", "lung-".repeat(60)],
  ["cu-nul", "a\u0000b"],
];

describe.skipIf(native === null)(
  "verificare încrucișată cu @node-rs/argon2 (doar unde modulul nativ se încarcă: CI)",
  () => {
    it.each(PASSWORDS)(
      "%s: hash vechi → verificat de implementarea nouă",
      async (label, password) => {
        const oldHash = await (native as Native).hash(password, OLD_OPTIONS);
        expect(oldHash).toMatch(
          /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
        );
        // valoare fixă pentru testele unitare de după scoaterea modulului nativ
        console.log(`ARGON2_VECTOR ${JSON.stringify({ label, password, hash: oldHash })}`);
        expect(await verifyPassword({ hash: oldHash, password })).toBe(true);
        expect(await verifyPassword({ hash: oldHash, password: `${password}x` })).toBe(false);
      },
    );

    it.each(PASSWORDS)(
      "%s: hash nou → verificat de implementarea veche",
      async (_label, password) => {
        const newHash = await hashPassword(password);
        expect(await (native as Native).verify(newHash, password)).toBe(true);
        expect(await (native as Native).verify(newHash, `${password}x`)).toBe(false);
      },
    );

    it("același format: aceeași formă a șirului, aceiași parametri", async () => {
      const [a, b] = await Promise.all([
        (native as Native).hash("format", OLD_OPTIONS),
        hashPassword("format"),
      ]);
      const shape = (hash: string) =>
        hash.replace(/\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/, "$<sare>$<tag>");
      expect(shape(b)).toBe(shape(a));
      expect(a.split("$")[4]).toHaveLength(22);
      expect(b.split("$")[4]).toHaveLength(22);
    });
  },
);

describe.skipIf(native !== null)("verificare încrucișată cu @node-rs/argon2 — SĂRITĂ", () => {
  it.skip(skipReason, () => undefined);
});
