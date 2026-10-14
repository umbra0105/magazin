import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { getMediaUsageRegistry } from "./media";

afterAll(async () => {
  await getDb().$disconnect();
});

describe("aplicația: registrul de utilizare media", () => {
  it("getMediaUsageRegistry() conține providerul produselor (ștergerea din bibliotecă îl consultă)", () => {
    expect(getMediaUsageRegistry().names).toContain("product-media");
  });

  it("e același obiect la fiecare apel (un singur registru per proces)", () => {
    expect(getMediaUsageRegistry()).toBe(getMediaUsageRegistry());
  });
});
