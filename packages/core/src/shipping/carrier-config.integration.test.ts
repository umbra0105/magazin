import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { TEST_APP_KEY } from "../test-utils/payment-fixtures";
import { CarrierConfigService } from "./carrier-config";

/**
 * Configurarea curierilor: garda «testat cu cont real», revenirea în test la schimbarea cheilor, cheile criptate și niciodată
 * întoarse, curierul DEMO doar cu garda, ce curier se poate folosi. Tot cu răspunsuri SIMULATE (niciun cont real).
 */
const db = getDb();
afterAll(() => db.$disconnect());

const hex = (n: number) => randomBytes(n).toString("hex");
const wootpro = () => ({ publicKey: hex(16), secretKey: hex(16), senderAddressId: "77" });
const NOW = new Date("2030-06-15T12:00:00.000Z");

const authOk = async (): Promise<Response> =>
  new Response(JSON.stringify({ success: true, token: "t", expire: 3600 }), { status: 200 });
const authRefused = async (): Promise<Response> => new Response("{}", { status: 401 });

async function withConfig<T>(
  fn: (config: CarrierConfigService, tx: TestTx) => Promise<T>,
  options: { selected?: string; env?: Record<string, string>; reachable?: boolean } = {},
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    const config = new CarrierConfigService({
      db: tx as unknown as PrismaClient,
      appKey: TEST_APP_KEY,
      env: options.env ?? {},
      readSelected: async () => options.selected ?? "wootpro",
      now: () => NOW,
      fetch: options.reachable === false ? authRefused : authOk,
    });
    return fn(config, tx);
  });
}

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "nicio eroare";
  } catch (error) {
    return (error as { code?: string }).code ?? "fără cod";
  }
};

describe("credențialele curierilor", () => {
  it("se salvează criptat, iar starea publică spune doar «salvat», niciodată valoarea", async () => {
    await withConfig(async (config, tx) => {
      const creds = wootpro();
      await config.save("wootpro", { credentials: creds });
      const state = await config.state("wootpro");
      expect(state.saved).toEqual({ publicKey: true, secretKey: true, senderAddressId: true });
      expect(JSON.stringify(state)).not.toContain(creds.secretKey);
      expect(JSON.stringify(state)).not.toContain(creds.publicKey);
      const stored = await tx.integration.findFirstOrThrow({
        where: { type: "shipping", provider: "wootpro" },
      });
      expect(stored.credentials).toMatch(/^v1:/);
      expect(stored.credentials).not.toContain(creds.secretKey);
    });
  });

  it("câmpurile goale păstrează valoarea salvată; numele câmpurilor schimbate se întorc, nu valorile", async () => {
    await withConfig(async (config) => {
      await config.save("wootpro", { credentials: wootpro() });
      const result = await config.save("wootpro", {
        credentials: { publicKey: "", secretKey: hex(16) },
      });
      expect(result.changedFields).toEqual(["secretKey"]);
      expect((await config.state("wootpro")).saved["publicKey"]).toBe(true);
    });
  });

  it("ID-uri care nu sunt numere: refuzate", async () => {
    await withConfig(async (config) => {
      expect(
        await codeOf(
          config.save("wootpro", { credentials: { ...wootpro(), senderAddressId: "abc" } }),
        ),
      ).toBe("SHIPPING_CREDENTIALS_INVALID");
      expect(
        await codeOf(
          config.save("sameday", {
            credentials: {
              username: "u",
              password: "p",
              pickupPointId: "x1",
              defaultServiceId: "7",
            },
          }),
        ),
      ).toBe("SHIPPING_CREDENTIALS_INVALID");
    });
  });

  it("nu se poate activa un curier cu credențiale incomplete", async () => {
    await withConfig(async (config) => {
      expect(
        await codeOf(
          config.save("wootpro", { credentials: { publicKey: hex(16) }, isActive: true }),
        ),
      ).toBe("SHIPPING_NOT_CONFIGURED");
    });
  });
});

describe("trecerea în LIVE", () => {
  it("e refuzată fără marca «testat cu cont real», cu sau fără confirmare", async () => {
    await withConfig(async (config) => {
      await config.save("wootpro", { credentials: wootpro(), isActive: true });
      expect(await codeOf(config.save("wootpro", { mode: "live", confirmLive: true }))).toBe(
        "SHIPPING_LIVE_NOT_VERIFIED",
      );
      expect((await config.state("wootpro")).mode).toBe("test");
    });
  });

  it("marca se pune doar după o conexiune de test reușită; cu conexiune refuzată rămâne nepusă", async () => {
    await withConfig(
      async (config) => {
        await config.save("wootpro", { credentials: wootpro(), isActive: true });
        const result = await config.confirmVerifiedInSandbox("wootpro");
        expect(result.ok).toBe(false);
        expect((await config.state("wootpro")).verifiedInSandboxAt).toBeNull();
      },
      { reachable: false },
    );
    await withConfig(async (config) => {
      await config.save("wootpro", { credentials: wootpro(), isActive: true });
      expect((await config.confirmVerifiedInSandbox("wootpro")).ok).toBe(true);
      expect((await config.state("wootpro")).verifiedInSandboxAt).toEqual(NOW);
    });
  });

  it("cere confirmare explicită chiar și după verificare; apoi trece", async () => {
    await withConfig(async (config) => {
      await config.save("wootpro", { credentials: wootpro(), isActive: true });
      await config.confirmVerifiedInSandbox("wootpro");
      expect(await codeOf(config.save("wootpro", { mode: "live" }))).toBe(
        "SHIPPING_LIVE_CONFIRMATION_REQUIRED",
      );
      await config.save("wootpro", { mode: "live", confirmLive: true });
      expect((await config.state("wootpro")).mode).toBe("live");
    });
  });

  it("schimbarea credențialelor în LIVE readuce modul în test și șterge marca", async () => {
    await withConfig(async (config) => {
      await config.save("wootpro", { credentials: wootpro(), isActive: true });
      await config.confirmVerifiedInSandbox("wootpro");
      await config.save("wootpro", { mode: "live", confirmLive: true });
      const result = await config.save("wootpro", { credentials: { secretKey: hex(16) } });
      expect(result).toMatchObject({
        revertedToTest: true,
        verifiedCleared: true,
        modeAfter: "test",
      });
      const state = await config.state("wootpro");
      expect(state.mode).toBe("test");
      expect(state.verifiedInSandboxAt).toBeNull();
    });
  });
});

describe("ce curier se poate folosi", () => {
  it("niciunul dacă nu e ales, nu e activ sau nu e complet configurat", async () => {
    await withConfig(async (config) => {
      await config.save("wootpro", { credentials: wootpro(), isActive: false });
      expect(await config.activeCarrier()).toBeNull();
    });
    await withConfig(
      async (config) => {
        await config.save("wootpro", { credentials: wootpro(), isActive: true });
        expect(await config.activeCarrier()).toBeNull();
      },
      { selected: "" },
    );
    await withConfig(async (config) => {
      await config.save("wootpro", { credentials: wootpro(), isActive: true });
      expect(await config.activeCarrier()).toEqual({ code: "wootpro", mode: "test" });
    });
  });

  it("un curier în LIVE neverificat nu se construiește și nu devine activ", async () => {
    await withConfig(async (config, tx) => {
      await config.save("wootpro", { credentials: wootpro(), isActive: true });
      // stare imposibilă prin interfață, forțată în bază: LIVE fără marcă
      await tx.integration.updateMany({
        where: { type: "shipping", provider: "wootpro" },
        data: { config: { mode: "live" } },
      });
      expect(await config.activeCarrier()).toBeNull();
      expect(await config.getCarrier("wootpro")).toBeNull();
    });
  });

  it("urmărirea unui curier dezactivat rămâne posibilă (getCarrier nu cere activ)", async () => {
    await withConfig(async (config) => {
      await config.save("wootpro", { credentials: wootpro(), isActive: false });
      expect(await config.getCarrier("wootpro")).not.toBeNull();
    });
  });

  it("curierul DEMO: doar cu garda; altfel nu apare, nu se salvează, nu se construiește", async () => {
    await withConfig(async (config) => {
      expect(config.visibleCodes()).toEqual(["wootpro", "sameday"]);
      expect(await codeOf(config.save("demo", { isActive: true }))).toBe("SHIPPING_DEMO_FORBIDDEN");
      expect(await config.getCarrier("demo")).toBeNull();
      expect(await config.activeCarrier()).toBeNull();
    });
    await withConfig(
      async (config) => {
        expect(config.visibleCodes()).toContain("demo");
        await config.save("demo", { isActive: true });
        expect(await config.activeCarrier()).toEqual({ code: "demo", mode: "test" });
      },
      { selected: "demo", env: { E2E_HARNESS: "1" } },
    );
  });

  it("cod necunoscut (cargus nu există): refuzat", async () => {
    await withConfig(async (config) => {
      expect(await codeOf(config.state("cargus"))).toBe("SHIPPING_PROVIDER_UNKNOWN");
    });
  });
});
