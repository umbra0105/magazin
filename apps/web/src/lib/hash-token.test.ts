import { describe, expect, it } from "vitest";
import { tokenFromHash } from "./hash-token";

const T = "abcDEF123_-abcDEF123_-abcDEF123_-xyz";

describe("tokenFromHash", () => {
  it("citește tokenul din #token=…", () => {
    expect(tokenFromHash(`#token=${T}`)).toBe(T);
    expect(tokenFromHash(`token=${T}`)).toBe(T);
  });
  it("decodifică procentele", () => {
    expect(tokenFromHash(`#token=${encodeURIComponent(T + "+/=")}`)).toBe(T + "+/=");
  });
  it("lipsă, prea scurt sau prea lung => null", () => {
    expect(tokenFromHash("")).toBeNull();
    expect(tokenFromHash("#")).toBeNull();
    expect(tokenFromHash("#token=abc")).toBeNull();
    expect(tokenFromHash(`#token=${"a".repeat(600)}`)).toBeNull();
    expect(tokenFromHash("#altceva=1")).toBeNull();
  });
});
