import { afterEach, describe, expect, it, vi } from "vitest";

// Test de integrare: cere Postgres și Redis pornite (docker compose local sau serviciile din CI).
// Variabilele de mediu vin din .env (local) sau din workflow (CI).

async function callHealth(headers?: Record<string, string>) {
  vi.resetModules(); // loadEnv() memorează rezultatul; refacem importul după ce schimbăm mediul
  const { GET } = await import("./route");
  return GET(new Request("http://localhost/api/health", { headers }));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/health (integrare)", () => {
  it("întoarce 200 și returnează requestId-ul primit când Postgres și Redis merg", async () => {
    const response = await callHealth({ "x-request-id": "integration-test-1" });
    const body = (await response.json()) as {
      status: string;
      checks: Record<string, { ok: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("integration-test-1");
    expect(body.status).toBe("ok");
    expect(body.checks.database?.ok).toBe(true);
    expect(body.checks.redis?.ok).toBe(true);
  });

  it("întoarce 503 și nu expune mesajele de eroare când Redis nu răspunde", async () => {
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1");
    const response = await callHealth();
    const text = await response.text();
    const body = JSON.parse(text) as {
      status: string;
      checks: Record<string, { ok: boolean }>;
    };

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.redis?.ok).toBe(false);
    expect(body.checks.database?.ok).toBe(true);
    expect(text).not.toMatch(/ECONNREFUSED|error/i);
  });
});
