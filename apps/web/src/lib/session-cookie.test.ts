import { describe, expect, it } from "vitest";
import { hasSessionCookie } from "./session-cookie";

describe("hasSessionCookie", () => {
  it("recunoaște cookie-ul simplu și varianta __Secure-", () => {
    expect(hasSessionCookie("better-auth.session_token=abc")).toBe(true);
    expect(hasSessionCookie("a=1; __Secure-better-auth.session_token=abc; b=2")).toBe(true);
  });

  it("ignoră lipsa, valorile goale și alte cookie-uri (inclusiv nume asemănătoare)", () => {
    expect(hasSessionCookie(null)).toBe(false);
    expect(hasSessionCookie("")).toBe(false);
    expect(hasSessionCookie("better-auth.session_token=")).toBe(false);
    expect(hasSessionCookie("better-auth.session_data=abc")).toBe(false);
    expect(hasSessionCookie("x-better-auth.session_token=abc")).toBe(false);
    expect(hasSessionCookie("session_token=abc")).toBe(false);
  });
});
