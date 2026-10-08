import { beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "@ecom/shared";
import type { KeyValueCache } from "../cache/read-through";
import {
  FEATURE_FLAGS_CACHE_KEY,
  FeatureFlagService,
  type FeatureFlagStore,
} from "./feature-flag-service";
import { FEATURE_KEYS, type FeatureKey } from "./registry";

function fakes() {
  const rows = new Map<string, boolean>();
  const cacheData = new Map<string, string>();
  const calls = { loadAll: 0 };
  const store: FeatureFlagStore = {
    async loadAll() {
      calls.loadAll++;
      return [...rows].map(([key, enabled]) => ({ key, enabled }));
    },
    async upsert({ key, enabled }) {
      rows.set(key, enabled);
    },
  };
  const cache: KeyValueCache = {
    async get(key) {
      return cacheData.get(key) ?? null;
    },
    async set(key, value) {
      cacheData.set(key, value);
      return "OK";
    },
    async del(key) {
      return cacheData.delete(key) ? 1 : 0;
    },
  };
  return { rows, cacheData, calls, store, cache };
}

describe("FeatureFlagService", () => {
  let f: ReturnType<typeof fakes>;
  let service: FeatureFlagService;

  beforeEach(() => {
    f = fakes();
    service = new FeatureFlagService(f.store, f.cache);
  });

  it("toate flag-urile sunt oprite implicit (fără rânduri în DB)", async () => {
    for (const key of FEATURE_KEYS) expect(await service.isEnabled(key)).toBe(false);
    expect(FEATURE_KEYS).toEqual([
      "blog",
      "reviews",
      "wishlist",
      "multiWarehouse",
      "loyalty",
      "vouchers",
    ]);
    expect((await service.list()).every((flag) => !flag.enabled)).toBe(true);
  });

  it("un rând cu enabled=false rămâne oprit; enabled=true pornește doar acel flag", async () => {
    f.rows.set("blog", true);
    f.rows.set("wishlist", false);
    expect(await service.isEnabled("blog")).toBe(true);
    expect(await service.isEnabled("wishlist")).toBe(false);
    expect(await service.isEnabled("vouchers")).toBe(false);
  });

  it("citește din cache (o singură interogare în DB)", async () => {
    await service.isEnabled("blog");
    await service.isEnabled("reviews");
    await service.list();
    expect(f.calls.loadAll).toBe(1);
    expect(f.cacheData.has(FEATURE_FLAGS_CACHE_KEY)).toBe(true);
  });

  it("invalidează cache-ul la scriere și vede imediat valoarea nouă", async () => {
    expect(await service.isEnabled("blog")).toBe(false);
    await service.setEnabled("blog", true);
    expect(f.cacheData.has(FEATURE_FLAGS_CACHE_KEY)).toBe(false);
    expect(await service.isEnabled("blog")).toBe(true);
    await service.setEnabled("blog", false);
    expect(await service.isEnabled("blog")).toBe(false);
  });

  it("respinge chei necunoscute și ignoră rândurile vechi din DB", async () => {
    await expect(service.isEnabled("nu-exista" as FeatureKey)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.setEnabled("nu-exista" as FeatureKey, true)).rejects.toBeInstanceOf(
      ValidationError,
    );
    f.rows.set("flag-scos-din-versiune-noua", true);
    expect((await service.list()).map((flag) => flag.key)).toEqual([...FEATURE_KEYS]);
  });

  it("cade pe DB când Redis e picat", async () => {
    const broken: KeyValueCache = {
      get: () => Promise.reject(new Error("redis picat")),
      set: () => Promise.reject(new Error("redis picat")),
      del: () => Promise.reject(new Error("redis picat")),
    };
    const s = new FeatureFlagService(f.store, broken);
    await s.setEnabled("loyalty", true);
    expect(await s.isEnabled("loyalty")).toBe(true);
  });
});
