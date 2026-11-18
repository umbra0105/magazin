import { describe, expect, it } from "vitest";
import { signOrderAccess, verifyOrderAccess } from "./order-access";

const KEY = Buffer.alloc(32, 3);
const OTHER = Buffer.alloc(32, 4);
const ID = "cmabc123def456";

describe("accesul la confirmarea comenzii (cookie semnat)", () => {
  it("un jeton valid dă ID-ul comenzii până la expirare, inclusiv", () => {
    const token = signOrderAccess(ID, KEY, 1_000);
    expect(verifyOrderAccess(token, KEY, 999)).toBe(ID);
    expect(verifyOrderAccess(token, KEY, 1_000)).toBe(ID);
    expect(verifyOrderAccess(token, KEY, 1_001)).toBeNull();
  });
  it("altă cheie, semnătură schimbată sau ID schimbat → null", () => {
    const token = signOrderAccess(ID, KEY, 1_000);
    expect(verifyOrderAccess(token, OTHER, 10)).toBeNull();
    const [, expires, signature] = token.split(".");
    expect(verifyOrderAccess(`altid12345.${expires}.${signature}`, KEY, 10)).toBeNull();
    expect(verifyOrderAccess(`${ID}.${Number(expires) + 100}.${signature}`, KEY, 10)).toBeNull();
    expect(verifyOrderAccess(`${ID}.${expires}.${signature}x`, KEY, 10)).toBeNull();
  });
  it("jetoane stricate → null, fără să arunce", () => {
    for (const bad of [
      "",
      "a",
      "a.b",
      "a.b.c.d",
      `${ID}.abc.xyz`,
      `${ID}.-5.xyz`,
      "...",
      `${ID}..`,
    ]) {
      expect(verifyOrderAccess(bad, KEY, 10), bad).toBeNull();
    }
  });
  it("refuză să semneze un ID sau un termen nevalid", () => {
    expect(() => signOrderAccess("a.b", KEY, 1000)).toThrow(RangeError);
    expect(() => signOrderAccess(ID, KEY, 0)).toThrow(RangeError);
    expect(() => signOrderAccess(ID, KEY, 1.5)).toThrow(RangeError);
  });
});
