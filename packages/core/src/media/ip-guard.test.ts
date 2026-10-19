import { describe, expect, it } from "vitest";
import { normalizeHostname } from "./host";
import { isPublicAddress, isPublicIPv4, isPublicIPv6 } from "./ip-guard";

describe("adrese IPv4 publice și nepublice", () => {
  it("acceptă adrese publice obișnuite", () => {
    for (const address of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "151.101.1.69",
      "100.63.255.255",
      "172.15.0.1",
      "172.32.0.1",
      "192.169.0.1",
      "198.20.0.1",
      "223.255.255.254",
    ]) {
      expect(isPublicIPv4(address), address).toBe(true);
    }
  });

  it("refuză loopback, privat, link-local (metadata cloud), CGNAT, 0.0.0.0/8, multicast, rezervat, documentare", () => {
    for (const address of [
      "127.0.0.1",
      "127.255.255.254",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "192.168.255.255",
      "169.254.169.254",
      "169.254.0.1",
      "100.64.0.1",
      "100.127.255.255",
      "0.0.0.0",
      "0.1.2.3",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.1",
      "255.255.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
      "198.18.0.1",
      "198.19.255.255",
      "192.88.99.1",
    ]) {
      expect(isPublicIPv4(address), address).toBe(false);
    }
  });

  it("sintaxă invalidă = nepublic", () => {
    for (const value of [
      "",
      "1.2.3",
      "1.2.3.4.5",
      "256.1.1.1",
      "1.2.3.-1",
      "a.b.c.d",
      "08.8.8.8x",
    ]) {
      expect(isPublicIPv4(value), value).toBe(false);
    }
  });
});

describe("adrese IPv6 publice și nepublice", () => {
  it("acceptă unicast global", () => {
    for (const address of [
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "2a00:1450:4001:81b::200e",
      "2620:0:ccc::2",
    ]) {
      expect(isPublicIPv6(address), address).toBe(true);
    }
  });

  it("refuză loopback, nespecificată, unique-local, link-local, site-local, multicast", () => {
    for (const address of [
      "::1",
      "::",
      "fc00::1",
      "fd12:3456:789a::1",
      "fe80::1",
      "febf::1",
      "fec0::1",
      "ff02::1",
      "ff00::",
    ]) {
      expect(isPublicIPv6(address), address).toBe(false);
    }
  });

  it("refuză IPv4-mapped (orice IPv4 încorporat), IPv4-compatible, NAT64, 6to4, Teredo, documentare", () => {
    for (const address of [
      "::ffff:127.0.0.1",
      "::ffff:8.8.8.8",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "0:0:0:0:0:ffff:10.0.0.1",
      "::127.0.0.1",
      "::8.8.8.8",
      "64:ff9b::808:808",
      "64:ff9b:1::1",
      "100::1",
      "2002:7f00:1::1",
      "2002:808:808::1",
      "2001::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2001:db8::1",
      "2001:10::1",
      "3fff::1",
    ]) {
      expect(isPublicIPv6(address), address).toBe(false);
    }
  });

  it("zona, sintaxa invalidă și adresele neunicast global = nepublic", () => {
    for (const value of [
      "fe80::1%eth0",
      "2606:4700::1111%1",
      "::1::2",
      "2606:4700:4700:0:0:0:0:0:1",
      "g::1",
      "1::2::3",
      "[::1]",
      "",
    ]) {
      expect(isPublicIPv6(value), value).toBe(false);
    }
  });
});

describe("isPublicAddress", () => {
  it("alege familia și refuză ce nu e IP", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    for (const value of [
      "localhost",
      "exemplu.ro",
      "2130706433",
      "0x7f.0.0.1",
      "0177.0.0.1",
      "127.1",
      "",
    ]) {
      expect(isPublicAddress(value), value).toBe(false);
    }
  });
});

describe("normalizeHostname", () => {
  it("litere mici, fără punct final, punycode", () => {
    expect(normalizeHostname("PiscineShop.RO")).toBe("piscineshop.ro");
    expect(normalizeHostname("piscineshop.ro.")).toBe("piscineshop.ro");
    expect(normalizeHostname("cdn.piscineshop.ro")).toBe("cdn.piscineshop.ro");
    expect(normalizeHostname("pișcine.ro")).toBe("xn--picine-4lc.ro");
    expect(normalizeHostname("  exemplu.ro  ")).toBe("exemplu.ro");
  });

  it("refuză IP-uri (în orice formă), wildcard, port, schemă, cale, utilizator, spații, un singur nivel", () => {
    for (const value of [
      "127.0.0.1",
      "8.8.8.8",
      "2130706433",
      "0x7f.0.0.1",
      "0177.0.0.1",
      "127.1",
      "[::1]",
      "::1",
      "*.piscineshop.ro",
      "piscineshop.ro:443",
      "https://piscineshop.ro",
      "piscineshop.ro/x",
      "u@piscineshop.ro",
      "pisc ineshop.ro",
      "localhost",
      "",
      "ro",
      ".",
      "-a.ro",
      "a-.ro",
      "a..ro",
      "exemplu.123",
    ]) {
      expect(normalizeHostname(value), value).toBeNull();
    }
  });
});
