import { describe, expect, it } from "vitest";
import { ipKey, resolveClientIp } from "./client-ip";

const h = (xff?: string) => new Headers(xff ? { "x-forwarded-for": xff } : {});

describe("resolveClientIp", () => {
  it("fără proxy de încredere (0) ignoră complet X-Forwarded-For", () => {
    expect(resolveClientIp(h("1.2.3.4"), 0)).toBeNull();
  });

  it("cu 1 proxy ia ultima adresă, nu pe cea scrisă de client", () => {
    expect(resolveClientIp(h("9.9.9.9, 203.0.113.7"), 1)).toBe("203.0.113.7");
  });

  it("cu 2 proxy-uri ia a doua de la dreapta", () => {
    expect(resolveClientIp(h("9.9.9.9, 203.0.113.7, 10.0.0.1"), 2)).toBe("203.0.113.7");
  });

  it("header lipsă sau mai scurt decât lanțul de proxy-uri => fără IP de încredere", () => {
    expect(resolveClientIp(h(), 1)).toBeNull();
    expect(resolveClientIp(h("1.1.1.1"), 2)).toBeNull();
    expect(resolveClientIp(undefined, 1)).toBeNull();
  });
});

describe("ipKey: IPv6 se cheamă pe /64 (C-40)", () => {
  it("IPv4 rămâne neschimbat", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("toate adresele dintr-un /64 au aceeași cheie, în orice formă de scriere", () => {
    const a = ipKey("2001:db8:abcd:12::1");
    expect(a).toBe(ipKey("2001:0db8:abcd:0012:ffff:ffff:ffff:ffff"));
    expect(a).toBe(ipKey("2001:DB8:ABCD:12:1:2:3:4"));
    expect(a).toBe("2001:db8:abcd:12::/64");
  });

  it("alt /64 → altă cheie", () => {
    expect(ipKey("2001:db8:abcd:13::1")).not.toBe(ipKey("2001:db8:abcd:12::1"));
  });

  it("IPv6 mapat pe IPv4 devine IPv4; ::1 și adresele scurte se normalizează", () => {
    expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
  });

  it("un șir care nu e adresă IP nu devine cheie (null), ca să nu intre text arbitrar în chei", () => {
    expect(ipKey("nu-e-ip")).toBeNull();
    expect(ipKey("999.1.1.1")).toBeNull();
    expect(ipKey("a".repeat(500))).toBeNull();
  });

  it("resolveClientIp întoarce cheia normalizată (IPv6 pe /64) și ignoră valori care nu sunt IP", () => {
    expect(resolveClientIp(h("9.9.9.9, 2001:db8:1:2:3:4:5:6"), 1)).toBe("2001:db8:1:2::/64");
    expect(resolveClientIp(h("9.9.9.9, nu-e-ip"), 1)).toBeNull();
  });
});
