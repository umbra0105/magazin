import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "@ecom/config";
import { REVALIDATE_PATH, signRevalidation } from "@ecom/core";

const revalidateTag = vi.fn();
vi.mock("next/cache", () => ({ revalidateTag: (tag: string) => revalidateTag(tag) }));

const { POST } = await import("./route");

const send = (body: string, overrides: { timestamp?: number; signature?: string } = {}) => {
  const timestamp = overrides.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = overrides.signature ?? signRevalidation(loadEnv().APP_KEY, timestamp, body);
  return POST(
    new Request(`http://localhost${REVALIDATE_PATH}`, {
      method: "POST",
      body,
      headers: {
        "x-revalidate-timestamp": String(timestamp),
        "x-revalidate-signature": signature,
      },
    }),
  );
};

describe("POST /api/internal/revalidate (invalidare din worker, C-37)", () => {
  beforeEach(() => revalidateTag.mockClear());

  it("o cerere semnată cu etichete permise invalidează fiecare etichetă o dată", async () => {
    const response = await send(JSON.stringify({ tags: ["catalog", "catalog", "product:abc"] }));
    expect(response.status).toBe(204);
    expect(revalidateTag.mock.calls.map((c) => c[0])).toEqual(["catalog", "product:abc"]);
  });

  it("semnătură greșită, lipsă sau marcă de timp veche: 401 și nicio invalidare", async () => {
    const body = JSON.stringify({ tags: ["catalog"] });
    expect((await send(body, { signature: "gresit" })).status).toBe(401);
    expect((await send(body, { signature: "" })).status).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect((await send(body, { timestamp: old })).status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("corp semnat corect, dar cu etichete nepermise sau fără etichete: 400, nimic invalidat", async () => {
    expect((await send(JSON.stringify({ tags: ["catalog", "../x"] }))).status).toBe(400);
    expect((await send(JSON.stringify({ tags: [] }))).status).toBe(400);
    expect((await send("nu e json")).status).toBe(400);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("un corp prea mare e refuzat înainte de verificare", async () => {
    const big = JSON.stringify({ tags: ["catalog"], pad: "x".repeat(20_000) });
    expect((await send(big)).status).toBe(413);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
