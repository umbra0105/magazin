import { describe, expect, it } from "vitest";
import { isSameOriginRequest } from "./request-origin";

const app = "https://magazin.test";
const headers = (init: Record<string, string>) => new Headers(init);

describe("isSameOriginRequest", () => {
  it("acceptă originea aplicației", () => {
    expect(isSameOriginRequest(headers({ origin: "https://magazin.test" }), app)).toBe(true);
    expect(
      isSameOriginRequest(
        headers({ origin: "https://magazin.test", "sec-fetch-site": "same-origin" }),
        `${app}/`,
      ),
    ).toBe(true);
  });

  it("refuză o origine străină, un subdomeniu, altă schemă sau alt port", () => {
    for (const origin of [
      "https://evil.test",
      "https://magazin.test.evil.test",
      "https://admin.magazin.test",
      "http://magazin.test",
      "https://magazin.test:8443",
      "null",
    ]) {
      expect(isSameOriginRequest(headers({ origin }), app), origin).toBe(false);
    }
  });

  it("refuză lipsa Origin și o cerere declarată cross-site", () => {
    expect(isSameOriginRequest(headers({}), app)).toBe(false);
    expect(
      isSameOriginRequest(
        headers({ origin: "https://magazin.test", "sec-fetch-site": "cross-site" }),
        app,
      ),
    ).toBe(false);
    expect(
      isSameOriginRequest(
        headers({ origin: "https://magazin.test", "sec-fetch-site": "same-site" }),
        app,
      ),
    ).toBe(false);
  });

  it("un APP_URL invalid nu acceptă nimic", () => {
    expect(isSameOriginRequest(headers({ origin: "https://magazin.test" }), "nu-e-url")).toBe(
      false,
    );
  });
});
