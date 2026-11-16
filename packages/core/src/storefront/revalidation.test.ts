import { describe, expect, it, vi } from "vitest";
import {
  REVALIDATE_MAX_SKEW_SECONDS,
  REVALIDATE_PATH,
  createRemoteRevalidator,
  isRevalidatableTag,
  signRevalidation,
  verifyRevalidation,
} from "./revalidation";

const KEY = Buffer.alloc(32, 7).toString("base64");
const NOW = 1_800_000_000;
const logger = { warn: vi.fn() };

describe("semnătura cererilor de invalidare", () => {
  it("o cerere semnată corect trece", () => {
    const body = JSON.stringify({ tags: ["catalog"] });
    const signature = signRevalidation(KEY, NOW, body);
    expect(verifyRevalidation(KEY, { timestamp: NOW, signature, body, now: NOW })).toBe(true);
  });

  it("corpul schimbat, cheia greșită sau semnătura goală pică", () => {
    const body = JSON.stringify({ tags: ["catalog"] });
    const signature = signRevalidation(KEY, NOW, body);
    const other = Buffer.alloc(32, 8).toString("base64");
    const base = { timestamp: NOW, signature, body, now: NOW };
    expect(verifyRevalidation(KEY, { ...base, body: `${body} ` })).toBe(false);
    expect(verifyRevalidation(other, base)).toBe(false);
    expect(verifyRevalidation(KEY, { ...base, signature: "" })).toBe(false);
    expect(verifyRevalidation(KEY, { ...base, signature: "zz" })).toBe(false);
  });

  it("marca de timp se leagă de semnătură (altă oră nu trece) și expiră în ambele sensuri", () => {
    const body = "{}";
    const signature = signRevalidation(KEY, NOW, body);
    const at = (timestamp: number, now: number) =>
      verifyRevalidation(KEY, { timestamp, signature, body, now });
    expect(at(NOW + 1, NOW + 1)).toBe(false);
    expect(at(NOW, NOW + REVALIDATE_MAX_SKEW_SECONDS + 1)).toBe(false);
    expect(at(NOW, NOW - REVALIDATE_MAX_SKEW_SECONDS - 1)).toBe(false);
    expect(at(NOW, NOW + REVALIDATE_MAX_SKEW_SECONDS)).toBe(true);
  });
});

describe("etichete permise", () => {
  it("doar etichetele catalogului și ale vitrinei", () => {
    for (const ok of ["catalog", "storefront-chrome", "product:abc123", "product-slug:pompa-12"]) {
      expect(isRevalidatableTag(ok), ok).toBe(true);
    }
    for (const bad of ["", "x", "product:", "../etc", "catalog ", `product:${"a".repeat(200)}`]) {
      expect(isRevalidatableTag(bad), bad).toBe(false);
    }
    expect(isRevalidatableTag("settings")).toBe(false);
  });
});

describe("createRemoteRevalidator (din worker)", () => {
  it("trimite o cerere POST semnată spre aplicație", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const revalidate = createRemoteRevalidator({
      appUrl: "https://magazin.test/",
      appKey: KEY,
      now: () => NOW * 1000,
      logger,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 204 });
      },
    });
    await revalidate(["catalog"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://magazin.test${REVALIDATE_PATH}`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    const body = calls[0]!.init.body as string;
    expect(JSON.parse(body)).toEqual({ tags: ["catalog"] });
    expect(
      verifyRevalidation(KEY, {
        timestamp: Number(headers["x-revalidate-timestamp"]),
        signature: headers["x-revalidate-signature"] ?? "",
        body,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("fără etichete sau cu etichete nepermise nu face nicio cerere", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    const revalidate = createRemoteRevalidator({
      appUrl: "https://magazin.test",
      appKey: KEY,
      logger,
      fetch: fetchSpy,
    });
    await revalidate([]);
    await revalidate(["../x"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("un răspuns de eroare sau o rețea căzută nu aruncă, ci se loghează", async () => {
    const warn = vi.fn();
    const refused = createRemoteRevalidator({
      appUrl: "https://magazin.test",
      appKey: KEY,
      logger: { warn },
      fetch: async () => new Response(null, { status: 500 }),
    });
    await expect(refused(["catalog"])).resolves.toBeUndefined();
    const failing = createRemoteRevalidator({
      appUrl: "https://magazin.test",
      appKey: KEY,
      logger: { warn },
      fetch: async () => {
        throw new Error("rețea căzută");
      },
    });
    await expect(failing(["catalog"])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
