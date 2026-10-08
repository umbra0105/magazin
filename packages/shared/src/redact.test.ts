import { describe, expect, it } from "vitest";
import { REDACTED, isSensitiveKey, redactSensitive } from "./redact";

describe("isSensitiveKey", () => {
  it("prinde câmpurile din listă și variantele lor", () => {
    for (const key of [
      "password",
      "APP_KEY",
      "appKey",
      "costPrice",
      "accessToken",
      "clientSecret",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ["sku", "name", "price", "provider"]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe("redactSensitive", () => {
  it("maschează la orice adâncime, inclusiv în array-uri, fără să modifice originalul", () => {
    const input = { a: { b: [{ token: "x", ok: 1 }] } };
    expect(redactSensitive(input)).toEqual({ a: { b: [{ token: REDACTED, ok: 1 }] } });
    expect(input.a.b[0]?.token).toBe("x");
  });

  it("suportă Date, null și referințe circulare", () => {
    const circular: Record<string, unknown> = { name: "n" };
    circular["self"] = circular;
    expect(redactSensitive({ when: new Date("2026-10-08T00:00:00Z"), none: null })).toEqual({
      when: "2026-10-08T00:00:00.000Z",
      none: null,
    });
    expect(redactSensitive(circular)).toEqual({ name: "n", self: "[circular]" });
  });
});
