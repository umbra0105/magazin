import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "@ecom/config";

const subscribe = vi.fn();
let count = 1;
vi.mock("@ecom/core", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    BackInStockService: class {
      subscribe = subscribe;
    },
  };
});
vi.mock("@/lib/services", () => ({
  getSettings: () => ({
    getGroup: async (group: string) =>
      group === "auth"
        ? { trustedProxyHops: 1 }
        : {
            lowStockSteps: 2,
            defaultLeadTimeDays: 14,
            backInStockMaxPerEmail: 10,
            backInStockMaxPerVariant: 1000,
          },
  }),
  getCounterStore: () => ({ increment: async () => ({ count, ttlSeconds: 60 }) }),
}));

const { POST } = await import("./route");
const origin = () => new URL(loadEnv().APP_URL).origin;

const send = (body: unknown, headers: Record<string, string> = { origin: origin() }) =>
  POST(
    new Request("http://localhost/api/back-in-stock", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.5", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("POST /api/back-in-stock", () => {
  beforeEach(() => {
    subscribe.mockReset();
    subscribe.mockResolvedValue({ status: "registered" });
    count = 1;
  });

  it("o cerere valabilă din aceeași origine ajunge la serviciu", async () => {
    const response = await send({ variantId: "v1", email: "Client@Exemplu.ro", consent: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "registered" });
    expect(subscribe).toHaveBeenCalledWith({ variantId: "v1", email: "Client@Exemplu.ro" });
  });

  it("fără origine sau din altă origine: 403, nimic înregistrat", async () => {
    expect((await send({ variantId: "v1", email: "a@b.ro", consent: true }, {})).status).toBe(403);
    expect(
      (
        await send(
          { variantId: "v1", email: "a@b.ro", consent: true },
          { origin: "https://rau.example" },
        )
      ).status,
    ).toBe(403);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("fără acord (lipsă, fals sau text): 400, nimic înregistrat", async () => {
    expect((await send({ variantId: "v1", email: "a@b.ro" })).status).toBe(400);
    expect((await send({ variantId: "v1", email: "a@b.ro", consent: false })).status).toBe(400);
    expect((await send({ variantId: "v1", email: "a@b.ro", consent: "true" })).status).toBe(400);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("capcana pentru roboți completată: răspuns ca la succes, dar nimic înregistrat", async () => {
    const response = await send({
      variantId: "v1",
      email: "a@b.ro",
      consent: true,
      website: "http://spam",
    });
    expect(response.status).toBe(200);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("peste limita pe IP: 429 cu Retry-After; corp invalid: 400; corp prea mare: 413", async () => {
    count = 21;
    const limited = await send({ variantId: "v1", email: "a@b.ro", consent: true });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    count = 1;
    expect((await send("nu e json")).status).toBe(400);
    expect((await send({ email: "a@b.ro", consent: true })).status).toBe(400);
    expect((await send({ variantId: "v1", email: "x".repeat(3000), consent: true })).status).toBe(
      413,
    );
    expect(subscribe).not.toHaveBeenCalled();
  });
});
