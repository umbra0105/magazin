import { describe, expect, it } from "vitest";
import { resolveClientIp } from "./client-ip";

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
