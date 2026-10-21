import { Redis } from "ioredis";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDatabase } from "./checks";
import { checkHealth } from "./index";

/**
 * Blocul C, C-09, pe Postgres și Redis reale: 100 de cereri simultane la `checkHealth` nu deschid 100 de conexiuni.
 *
 * Conexiunile se NUMĂRĂ la deschidere (spy pe `Client.connect` din `pg` și `Redis.connect` din `ioredis`), nu se
 * fotografiază din `pg_stat_activity`: o fotografie depinde de timing (un Postgres rapid închide conexiunile înainte
 * să se acumuleze) și vede conexiunile altor teste din aceeași bază. Numărul de deschideri nu depinde de viteza
 * serverului. Controlul (apeluri directe la `checkDatabase`, cum făcea ruta înainte) dovedește că instrumentul vede
 * fiecare conexiune: exact una per apel.
 */

const databaseUrl = process.env["DATABASE_URL"] as string;
const redisUrl = process.env["REDIS_URL"] as string;

afterEach(() => {
  vi.restoreAllMocks();
});

function countConnections() {
  const pg = vi.spyOn(Client.prototype, "connect");
  const redis = vi.spyOn(Redis.prototype, "connect");
  return {
    pg: () => pg.mock.calls.length,
    redis: () => redis.mock.calls.length,
  };
}

describe("/api/health pe Postgres și Redis reale", () => {
  it("control: fiecare apel direct la checkDatabase deschide exact o conexiune Postgres", async () => {
    const opened = countConnections();
    const results = await Promise.all(Array.from({ length: 30 }, () => checkDatabase(databaseUrl)));
    expect(opened.pg()).toBe(30);
    expect(opened.redis()).toBe(0);
    // conexiunile chiar s-au făcut (instrumentul nu numără apeluri care au eșuat înainte de rețea)
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("100 de cereri simultane la checkHealth deschid o singură conexiune Postgres și una Redis și raportează ok", async () => {
    const opened = countConnections();
    const reports = await Promise.all(
      Array.from({ length: 100 }, () => checkHealth({ databaseUrl, redisUrl })),
    );
    expect(new Set(reports.map((report) => report.status))).toEqual(new Set(["ok"]));
    expect(opened.pg()).toBe(1);
    expect(opened.redis()).toBe(1);

    // în fereastra de valabilitate, cererile următoare nu mai deschid nimic
    await Promise.all(Array.from({ length: 100 }, () => checkHealth({ databaseUrl, redisUrl })));
    expect(opened.pg()).toBe(1);
    expect(opened.redis()).toBe(1);
  });
});
