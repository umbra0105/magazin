import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { checkDatabase } from "./checks";
import { checkHealth } from "./index";

/**
 * Blocul C, C-09, pe Postgres și Redis reale: 100 de cereri simultane la `checkHealth` nu deschid 100 de conexiuni.
 * Controlul (100 de apeluri directe la `checkDatabase`, cum făcea ruta înainte) arată că măsurătoarea vede conexiunile.
 */

const databaseUrl = process.env["DATABASE_URL"] as string;
const redisUrl = process.env["REDIS_URL"] as string;

async function peakBackends(burst: () => Promise<unknown>): Promise<number> {
  const watcher = new Client({ connectionString: databaseUrl });
  await watcher.connect();
  try {
    const count = async () =>
      Number(
        (
          await watcher.query(
            "select count(*)::int as n from pg_stat_activity where datname = current_database()",
          )
        ).rows[0].n,
      );
    const baseline = await count();
    let peak = baseline;
    let running = true;
    const poll = (async () => {
      while (running) {
        peak = Math.max(peak, await count());
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    await burst();
    running = false;
    await poll;
    return peak - baseline;
  } finally {
    await watcher.end();
  }
}

describe("/api/health pe Postgres și Redis reale", () => {
  it("control: apelurile directe deschid multe conexiuni deodată", async () => {
    const extra = await peakBackends(() =>
      Promise.all(Array.from({ length: 60 }, () => checkDatabase(databaseUrl))),
    );
    expect(extra).toBeGreaterThan(15);
  });

  it("100 de cereri simultane la checkHealth deschid cel mult câteva conexiuni și raportează ok", async () => {
    const extra = await peakBackends(async () => {
      const reports = await Promise.all(
        Array.from({ length: 100 }, () => checkHealth({ databaseUrl, redisUrl })),
      );
      expect(new Set(reports.map((r) => r.status))).toEqual(new Set(["ok"]));
    });
    expect(extra).toBeLessThanOrEqual(3);
  });
});
