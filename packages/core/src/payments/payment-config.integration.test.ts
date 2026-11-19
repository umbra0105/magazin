import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { TEST_APP_KEY } from "../test-utils/payment-fixtures";
import { PaymentConfigService } from "./payment-config";

/** Configurarea furnizorilor: garda «verificat în sandbox», revenirea în test la schimbarea cheilor, DEMO, ce poate primi plăți. */
const db = getDb();
afterAll(() => db.$disconnect());

const hex = (n: number) => randomBytes(n).toString("hex");
const euplatesc = () => ({ merchantId: `MID-${hex(3)}`, secretKey: hex(16) });
const publicKey = () =>
  generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
const netopia = () => ({
  apiKey: `API-${hex(8)}`,
  posSignature: `POS-${hex(6)}`,
  publicKey: publicKey(),
});

const NOW = new Date("2030-06-15T12:00:00.000Z");

async function withConfig<T>(
  fn: (config: PaymentConfigService, tx: TestTx) => Promise<T>,
  options: { card?: string; env?: Record<string, string> } = {},
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    const config = new PaymentConfigService({
      db: tx as unknown as PrismaClient,
      appKey: TEST_APP_KEY,
      env: options.env ?? {},
      readCardProvider: async () => options.card ?? "euplatesc",
      now: () => NOW,
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

describe("trecerea în LIVE", () => {
  it("e refuzată fără marca «verificat în sandbox», cu sau fără confirmare", async () => {
    await withConfig(async (config) => {
      await config.save("euplatesc", { credentials: euplatesc(), isActive: true });
      expect(await codeOf(config.save("euplatesc", { mode: "live", confirmLive: true }))).toBe(
        "PAYMENT_LIVE_NOT_VERIFIED",
      );
      expect((await config.state("euplatesc")).mode).toBe("test");
    });
  });

  it("cere confirmare explicită chiar și după verificare", async () => {
    await withConfig(async (config) => {
      await config.save("euplatesc", { credentials: euplatesc(), isActive: true });
      await config.markVerifiedInSandbox("euplatesc");
      expect(await codeOf(config.save("euplatesc", { mode: "live" }))).toBe(
        "PAYMENT_LIVE_CONFIRMATION_REQUIRED",
      );
      expect(await codeOf(config.save("euplatesc", { mode: "live", confirmLive: false }))).toBe(
        "PAYMENT_LIVE_CONFIRMATION_REQUIRED",
      );
      expect((await config.state("euplatesc")).mode).toBe("test");
      await config.save("euplatesc", { mode: "live", confirmLive: true });
      expect((await config.state("euplatesc")).mode).toBe("live");
    });
  });

  it("marca se pune o singură dată (nu se mută) și doar pentru furnizori reali", async () => {
    await withConfig(async (config, tx) => {
      await config.save("netopia", { credentials: netopia() });
      await config.markVerifiedInSandbox("netopia");
      const first = (await config.state("netopia")).verifiedInSandboxAt;
      expect(first).toEqual(NOW);
      const later = new PaymentConfigService({
        db: tx as unknown as PrismaClient,
        appKey: TEST_APP_KEY,
        env: {},
        readCardProvider: async () => "",
        now: () => new Date(NOW.getTime() + 86_400_000),
      });
      await later.markVerifiedInSandbox("netopia");
      expect((await config.state("netopia")).verifiedInSandboxAt).toEqual(first);
      await config.markVerifiedInSandbox("demo"); // nu face nimic și nu aruncă
    });
  });

  it("schimbarea cheilor în LIVE readuce modul în test și șterge marca (verificarea se refă)", async () => {
    await withConfig(async (config) => {
      const keys = euplatesc();
      await config.save("euplatesc", { credentials: keys, isActive: true });
      await config.markVerifiedInSandbox("euplatesc");
      await config.save("euplatesc", { mode: "live", confirmLive: true });
      const result = await config.save("euplatesc", { credentials: { secretKey: hex(16) } });
      expect(result).toMatchObject({ revertedToTest: true, verifiedCleared: true });
      const state = await config.state("euplatesc");
      expect(state).toMatchObject({ mode: "test", verifiedInSandboxAt: null });
      // aceeași valoare retrimisă nu e o schimbare
      await config.markVerifiedInSandbox("euplatesc");
      const same = await config.save("euplatesc", { credentials: { merchantId: keys.merchantId } });
      expect(same.verifiedCleared).toBe(false);
    });
  });
});

describe("ce poate primi plăți noi", () => {
  it("doar furnizorul ales, activ, complet configurat și, la LIVE, verificat", async () => {
    await withConfig(async (config, tx) => {
      expect(await config.activeCardProvider()).toBeNull(); // nimic salvat
      await config.save("euplatesc", { credentials: { merchantId: "MID" } });
      expect(await config.activeCardProvider()).toBeNull(); // incomplet
      await config.save("euplatesc", { credentials: euplatesc() });
      expect(await config.activeCardProvider()).toBeNull(); // inactiv
      await config.save("euplatesc", { isActive: true });
      expect(await config.activeCardProvider()).toEqual({ code: "euplatesc", mode: "test" });
      // LIVE fără marcă (stare impusă direct în bază): nu primește plăți
      await tx.integration.updateMany({
        where: { provider: "euplatesc" },
        data: { config: { mode: "live" } },
      });
      expect(await config.activeCardProvider()).toBeNull();
      await config.markVerifiedInSandbox("euplatesc");
      expect(await config.activeCardProvider()).toEqual({ code: "euplatesc", mode: "live" });
    });
  });

  it("alt furnizor ales în setări, sau niciunul, nu se folosește", async () => {
    await withConfig(async (config) => {
      await config.save("euplatesc", { credentials: euplatesc(), isActive: true });
      expect(await config.activeCardProvider()).not.toBeNull();
    });
    await withConfig(
      async (config) => {
        await config.save("euplatesc", { credentials: euplatesc(), isActive: true });
        expect(await config.activeCardProvider()).toBeNull();
      },
      { card: "netopia" },
    );
    await withConfig(
      async (config) => {
        await config.save("euplatesc", { credentials: euplatesc(), isActive: true });
        expect(await config.activeCardProvider()).toBeNull();
      },
      { card: "" },
    );
  });

  it("activarea cere câmpurile obligatorii", async () => {
    await withConfig(async (config) => {
      expect(await codeOf(config.save("netopia", { isActive: true }))).toBe(
        "PAYMENT_NOT_CONFIGURED",
      );
      expect(
        await codeOf(config.save("netopia", { credentials: { apiKey: "x" }, isActive: true })),
      ).toBe("PAYMENT_NOT_CONFIGURED");
    });
  });

  it("un furnizor dezactivat încă își poate verifica notificările și face rambursări (getProvider)", async () => {
    await withConfig(async (config) => {
      await config.save("euplatesc", { credentials: euplatesc(), isActive: false });
      expect(await config.getProvider("euplatesc")).not.toBeNull();
      expect(await config.getProvider("netopia")).toBeNull(); // neconfigurat
      expect(await config.getProvider("necunoscut")).toBeNull();
    });
  });

  it("formatele cheilor se validează (cheie hexazecimală, cheie RSA)", async () => {
    await withConfig(async (config) => {
      expect(
        await codeOf(config.save("euplatesc", { credentials: { secretKey: "nu-e-hex" } })),
      ).toBe("PAYMENT_CREDENTIALS_INVALID");
      expect(await codeOf(config.save("euplatesc", { credentials: { userApi: "zz" } }))).toBe(
        "PAYMENT_CREDENTIALS_INVALID",
      );
      expect(
        await codeOf(config.save("netopia", { credentials: { publicKey: "nu e o cheie" } })),
      ).toBe("PAYMENT_CREDENTIALS_INVALID");
    });
  });
});

describe("furnizorul DEMO", () => {
  const allowed = { E2E_HARNESS: "1" };

  it("în producție (garda neîndeplinită) nu apare, nu se salvează, nu se activează, nu se construiește", async () => {
    await withConfig(
      async (config) => {
        expect(config.visibleCodes()).toEqual(["netopia", "euplatesc"]);
        expect(await codeOf(config.save("demo", { isActive: true }))).toBe(
          "PAYMENT_DEMO_FORBIDDEN",
        );
        expect(await codeOf(config.state("demo"))).toBe("PAYMENT_DEMO_FORBIDDEN");
        expect(await config.getProvider("demo")).toBeNull();
      },
      { env: { NODE_ENV: "production", ECOM_DEMO_PAYMENTS: "1" }, card: "demo" },
    );
    await withConfig(
      async (config, tx) => {
        // chiar dacă cineva a scris direct în bază un rând DEMO activ, cardul nu se oferă
        await tx.integration.create({
          data: { type: "payment", provider: "demo", isActive: true, config: {} },
        });
        expect(await config.activeCardProvider()).toBeNull();
      },
      { env: { NODE_ENV: "production" }, card: "demo" },
    );
  });

  it("cu garda îndeplinită apare, se activează și devine furnizorul cardului", async () => {
    await withConfig(
      async (config) => {
        expect(config.visibleCodes()).toEqual(["netopia", "euplatesc", "demo"]);
        await config.save("demo", { isActive: true });
        expect(await config.activeCardProvider()).toEqual({ code: "demo", mode: "demo" });
        expect((await config.getProvider("demo"))?.mode).toBe("demo");
      },
      { env: allowed, card: "demo" },
    );
  });

  it("DEMO nu are mod live și nu ține credențiale", async () => {
    await withConfig(
      async (config, tx) => {
        await config.save("demo", { isActive: true, mode: "live", confirmLive: true });
        expect((await config.state("demo")).mode).toBe("test");
        const row = await tx.integration.findFirstOrThrow({ where: { provider: "demo" } });
        expect(row.credentials).toBeNull();
      },
      { env: allowed, card: "demo" },
    );
  });
});
