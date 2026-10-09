import { createRequire } from "node:module";
import net from "node:net";
import { describe, expect, it } from "vitest";
import {
  UNIT_NETWORK_BLOCKED_MESSAGE,
  UNIT_TEST_DATABASE_URL,
  UNIT_TEST_REDIS_URL,
} from "./unit-guard";

// pg și ioredis sunt dependențe ale lui @ecom/core, nu ale rădăcinii: le rezolvăm de acolo.
interface PgModule {
  Client: new (options: { connectionString?: string }) => {
    on(event: string, listener: () => void): void;
    connect(): Promise<void>;
  };
}
interface RedisModule {
  Redis: new (
    url: string,
    options: Record<string, unknown>,
  ) => {
    on(event: string, listener: () => void): void;
    connect(): Promise<void>;
    disconnect(): void;
  };
}

const fromCore = createRequire(new URL("../../packages/core/package.json", import.meta.url));

describe("garda testelor unitare", () => {
  it("DATABASE_URL și REDIS_URL arată spre domenii care nu se rezolvă (.invalid)", () => {
    expect(process.env["DATABASE_URL"]).toBe(UNIT_TEST_DATABASE_URL);
    expect(process.env["REDIS_URL"]).toBe(UNIT_TEST_REDIS_URL);
    expect(new URL(UNIT_TEST_DATABASE_URL).hostname.endsWith(".invalid")).toBe(true);
    expect(new URL(UNIT_TEST_REDIS_URL).hostname.endsWith(".invalid")).toBe(true);
  });

  it("orice conectare TCP aruncă imediat o eroare clară", () => {
    expect(() => net.connect({ host: "127.0.0.1", port: 5432 })).toThrowError(
      UNIT_NETWORK_BLOCKED_MESSAGE,
    );
    expect(() => new net.Socket().connect(6379, "localhost")).toThrowError(/integration\.test/);
  });

  it("clienții reali (pg, ioredis) nu reușesc să se conecteze", async () => {
    const { Client } = fromCore("pg") as PgModule;
    const client = new Client({ connectionString: process.env["DATABASE_URL"] });
    client.on("error", () => undefined);
    await expect(client.connect()).rejects.toThrow(/Testele unitare nu au voie/);

    const { Redis } = fromCore("ioredis") as RedisModule;
    const redis = new Redis(process.env["REDIS_URL"] ?? "", {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on("error", () => undefined);
    await expect(redis.connect()).rejects.toThrow();
    redis.disconnect();
  });
});
