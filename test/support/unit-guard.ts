import net from "node:net";

/**
 * Gardă pentru testele UNITARE: nu au voie să atingă baza reală de date, Redis sau altă rețea.
 * Rulează înaintea fiecărui fișier de test unitar (`setupFiles` în vitest.config.mts).
 *
 * 1. DATABASE_URL și REDIS_URL devin URL-uri pe domeniul rezervat `.invalid` (RFC 6761), care nu
 *    se rezolvă niciodată: chiar dacă ceva ar citi variabila, nu ajunge la un server real.
 * 2. Orice încercare de conectare TCP aruncă o eroare clară (pg, ioredis și orice altceva).
 *
 * Un test care cere baza de date este de INTEGRARE și trebuie numit `*.integration.test.ts`
 * (rulează pe baza de test, cu `integration-guard.ts`). Vezi `unit-isolation.test.ts`.
 */
export const UNIT_TEST_DATABASE_URL = "postgresql://unit:unit@db.unit-tests.invalid:5432/unit";
export const UNIT_TEST_REDIS_URL = "redis://redis.unit-tests.invalid:6379/15";

process.env["DATABASE_URL"] = UNIT_TEST_DATABASE_URL;
process.env["REDIS_URL"] = UNIT_TEST_REDIS_URL;

export const UNIT_NETWORK_BLOCKED_MESSAGE =
  "Testele unitare nu au voie să deschidă conexiuni de rețea (nici la baza de date, nici la Redis). " +
  "Dacă testul are nevoie de ele, este de integrare: numește-l *.integration.test.ts.";

net.Socket.prototype.connect = function blockedConnect(): never {
  throw new Error(UNIT_NETWORK_BLOCKED_MESSAGE);
};
