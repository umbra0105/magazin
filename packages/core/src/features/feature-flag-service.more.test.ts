import { describe, expect, it } from "vitest";
import { createFakeCache } from "../test-utils/fake-cache";
import {
  FEATURE_FLAGS_CACHE_KEY,
  FEATURE_FLAGS_CACHE_TTL_SECONDS,
  FeatureFlagService,
  type FeatureFlagStore,
} from "./feature-flag-service";

function setup() {
  const rows = new Map<string, boolean>();
  const writes: { key: string; enabled: boolean }[] = [];
  const store: FeatureFlagStore = {
    async loadAll() {
      return [...rows].map(([key, enabled]) => ({ key, enabled }));
    },
    async upsert({ key, enabled }) {
      rows.set(key, enabled);
      writes.push({ key, enabled });
    },
  };
  const fake = createFakeCache();
  return { rows, writes, ...fake, service: new FeatureFlagService(store, fake.cache) };
}

describe("FeatureFlagService: detalii", () => {
  it("scrie cache-ul cu TTL de 5 minute", async () => {
    const { service, ttls } = setup();
    await service.isEnabled("blog");
    expect(ttls.get(FEATURE_FLAGS_CACHE_KEY)).toBe(FEATURE_FLAGS_CACHE_TTL_SECONDS);
    expect(FEATURE_FLAGS_CACHE_TTL_SECONDS).toBe(300);
  });

  it("list() întoarce toate cele 6 flag-uri cu etichete în română și starea corectă", async () => {
    const { service, rows } = setup();
    rows.set("wishlist", true);
    const list = await service.list();
    expect(list).toHaveLength(6);
    expect(list.find((flag) => flag.key === "wishlist")).toEqual({
      key: "wishlist",
      label: "Listă de dorințe",
      enabled: true,
    });
    expect(list.filter((flag) => flag.enabled).map((flag) => flag.key)).toEqual(["wishlist"]);
  });

  it("setEnabled repetat e idempotent și scrie descrierea flag-ului", async () => {
    const { service, rows, writes } = setup();
    await service.setEnabled("vouchers", true);
    await service.setEnabled("vouchers", true);
    expect(rows.get("vouchers")).toBe(true);
    expect(writes).toEqual([
      { key: "vouchers", enabled: true },
      { key: "vouchers", enabled: true },
    ]);
    expect(await service.isEnabled("vouchers")).toBe(true);
  });

  it("pornirea unui flag nu le schimbă pe celelalte", async () => {
    const { service } = setup();
    await service.setEnabled("loyalty", true);
    const states = Object.fromEntries((await service.list()).map((f) => [f.key, f.enabled]));
    expect(states).toEqual({
      blog: false,
      reviews: false,
      wishlist: false,
      multiWarehouse: false,
      loyalty: true,
      vouchers: false,
    });
  });
});
