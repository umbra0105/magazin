import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_CACHE_MS,
  MAINTENANCE_RETRY_AFTER_SECONDS,
  createMaintenanceProbe,
  isMaintenanceExempt,
} from "./maintenance";

describe("isMaintenanceExempt: ce rămâne accesibil în mentenanță", () => {
  it("adminul, API-ul, autentificarea, fișierele statice, tema și media", () => {
    for (const path of [
      "/admin",
      "/admin/setari/mentenanta",
      "/api/health",
      "/api/auth/sign-in/email",
      "/autentificare",
      "/recuperare-parola",
      "/resetare-parola",
      "/verificare-email",
      "/_next/static/x.js",
      "/theme.css",
      "/theme-light.css",
      "/theme-dark.css",
      "/media/a/b.webp",
      "/storage/x",
      "/favicon.ico",
      "/robots.txt",
    ]) {
      expect(isMaintenanceExempt(path), path).toBe(true);
    }
  });

  it("vitrina (inclusiv pagina de mentenanță și contul clientului) este blocată", () => {
    for (const path of [
      "/",
      "/magazin",
      "/produs/pompa",
      "/categorie/pompe/de-caldura",
      "/cont",
      "/inregistrare",
      "/mentenanta",
      "/pagina-inexistenta",
    ]) {
      expect(isMaintenanceExempt(path), path).toBe(false);
    }
  });

  it("nu confundă prefixe de nume (/administrator, /apiary nu sunt /admin, /api)", () => {
    expect(isMaintenanceExempt("/administrator")).toBe(false);
    expect(isMaintenanceExempt("/apiary")).toBe(false);
    expect(isMaintenanceExempt("/themes")).toBe(false);
  });
});

const ORIGIN = "http://localhost:3000";

describe("createMaintenanceProbe: citirea steagului din middleware, cu cache scurt", () => {
  const make = (results: Array<boolean | Error>) => {
    let now = 1_000_000;
    let calls = 0;
    const probe = createMaintenanceProbe({
      read: async () => {
        const next = results[Math.min(calls, results.length - 1)];
        calls += 1;
        if (next instanceof Error) throw next;
        return next ?? false;
      },
      now: () => now,
    });
    return { probe, calls: () => calls, advance: (ms: number) => (now += ms) };
  };

  it("citește o dată și păstrează răspunsul cât ține cache-ul; apoi reciteste", async () => {
    const t = make([true, false]);
    expect(await t.probe(ORIGIN)).toBe(true);
    expect(await t.probe(ORIGIN)).toBe(true);
    expect(t.calls()).toBe(1);
    t.advance(MAINTENANCE_CACHE_MS + 1);
    expect(await t.probe(ORIGIN)).toBe(false);
    expect(t.calls()).toBe(2);
  });

  it("cereri simultane partajează o singură citire", async () => {
    const t = make([true]);
    const results = await Promise.all([t.probe(ORIGIN), t.probe(ORIGIN), t.probe(ORIGIN)]);
    expect(results).toEqual([true, true, true]);
    expect(t.calls()).toBe(1);
  });

  it("dacă citirea eșuează, magazinul rămâne deschis (nu se blochează din cauza unei erori) și se încearcă din nou la cererea următoare", async () => {
    const t = make([new Error("baza e picată"), true]);
    expect(await t.probe(ORIGIN)).toBe(false);
    expect(await t.probe(ORIGIN)).toBe(true);
    expect(t.calls()).toBe(2);
  });

  it("Retry-After rezonabil (o oră)", () => {
    expect(MAINTENANCE_RETRY_AFTER_SECONDS).toBe(3600);
  });
});

describe("createMaintenanceProbe: originea ajunge la citire", () => {
  it("citirea primește originea cererii care a declanșat-o", async () => {
    const seen: string[] = [];
    const probe = createMaintenanceProbe({
      read: async (origin) => {
        seen.push(origin);
        return false;
      },
      now: () => 0,
    });
    await probe("https://magazin.ro");
    expect(seen).toEqual(["https://magazin.ro"]);
  });
});
