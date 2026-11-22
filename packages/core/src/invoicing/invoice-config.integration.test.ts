import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { TEST_APP_KEY } from "../test-utils/payment-fixtures";
import { InvoicingConfigService } from "./invoice-config";

/**
 * Configurarea furnizorilor de facturare: garda «testat cu cont real», revenirea în test la schimbarea cheilor, cheile criptate și
 * niciodată întoarse, furnizorul DEMO doar cu garda. Tot cu răspunsuri SIMULATE (niciun cont real, niciun document emis).
 */
const db = getDb();
afterAll(() => db.$disconnect());

const hex = (n: number) => randomBytes(n).toString("hex");
const NOW = new Date("2030-06-15T12:00:00.000Z");
const smartbill = () => ({
  email: "cont@exemplu.invalid",
  token: hex(16),
  companyVatCode: "RO12345678",
  invoiceSeries: "FCT",
  proformaSeries: "PRF",
  taxName: "Normala",
});

const seriesOk = async (): Promise<Response> =>
  new Response(
    JSON.stringify({ errorText: "", list: [{ name: "FCT", nextNumber: 1, type: "f" }] }),
    {
      status: 200,
    },
  );
const refused = async (): Promise<Response> => new Response("{}", { status: 401 });

async function withConfig<T>(
  fn: (config: InvoicingConfigService, tx: TestTx) => Promise<T>,
  options: { env?: Record<string, string>; reachable?: boolean; selected?: string } = {},
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    if (options.selected !== undefined) {
      await tx.setting.upsert({
        where: { key: "invoicing.provider" },
        create: { key: "invoicing.provider", group: "invoicing", value: options.selected },
        update: { value: options.selected },
      });
    }
    const config = new InvoicingConfigService({
      db: tx as unknown as PrismaClient,
      appKey: TEST_APP_KEY,
      env: options.env ?? {},
      now: () => NOW,
      fetch: options.reachable === false ? refused : seriesOk,
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

describe("credențialele furnizorilor de facturare", () => {
  it("se salvează criptat; starea publică spune doar «salvat» pentru secrete și arată valorile ne-secrete", async () => {
    await withConfig(async (config, tx) => {
      const creds = smartbill();
      await config.save("smartbill", { credentials: creds });
      const state = await config.state("smartbill");
      expect(state.saved["token"]).toBe(true);
      expect(JSON.stringify(state)).not.toContain(creds.token);
      expect(state.values["invoiceSeries"]).toBe("FCT");
      expect(state.values).not.toHaveProperty("token");
      const stored = await tx.integration.findFirstOrThrow({
        where: { type: "invoicing", provider: "smartbill" },
      });
      expect(stored.credentials).toMatch(/^v1:/);
      expect(stored.credentials).not.toContain(creds.token);
    });
  });

  it("câmpurile goale păstrează valoarea salvată; se întorc numele câmpurilor schimbate, nu valorile", async () => {
    await withConfig(async (config) => {
      await config.save("smartbill", { credentials: smartbill() });
      const result = await config.save("smartbill", { credentials: { email: "", token: hex(16) } });
      expect(result.changedFields).toEqual(["token"]);
    });
  });

  it("email invalid și valori prea lungi: refuzate", async () => {
    await withConfig(async (config) => {
      expect(await codeOf(config.save("smartbill", { credentials: { email: "nu-e-email" } }))).toBe(
        "INVOICING_CREDENTIALS_INVALID",
      );
      expect(
        await codeOf(config.save("smartbill", { credentials: { invoiceSeries: "x".repeat(400) } })),
      ).toBe("INVOICING_CREDENTIALS_INVALID");
    });
  });
});

describe("garda LIVE: «testat cu un cont real»", () => {
  it("LIVE e refuzat fără confirmare explicită, apoi fără marca de verificare", async () => {
    await withConfig(async (config) => {
      await config.save("smartbill", { credentials: smartbill() });
      expect(await codeOf(config.save("smartbill", { mode: "live" }))).toBe(
        "INVOICING_LIVE_CONFIRMATION_REQUIRED",
      );
      expect(await codeOf(config.save("smartbill", { mode: "live", confirmLive: true }))).toBe(
        "INVOICING_LIVE_NOT_VERIFIED",
      );
      expect((await config.state("smartbill")).mode).toBe("test");
    });
  });

  it("după testul cu cont real LIVE se permite; schimbarea cheilor șterge marca și readuce modul în test", async () => {
    await withConfig(async (config) => {
      await config.save("smartbill", { credentials: smartbill() });
      expect((await config.confirmVerifiedInSandbox("smartbill")).ok).toBe(true);
      await config.save("smartbill", { mode: "live", confirmLive: true });
      expect((await config.state("smartbill")).mode).toBe("live");
      const changed = await config.save("smartbill", { credentials: { token: hex(16) } });
      expect(changed).toMatchObject({
        revertedToTest: true,
        verifiedCleared: true,
        modeAfter: "test",
      });
      expect((await config.state("smartbill")).verifiedInSandboxAt).toBeNull();
    });
  });

  it("marca nu se pune dacă testul de conexiune eșuează", async () => {
    await withConfig(
      async (config) => {
        await config.save("smartbill", { credentials: smartbill() });
        const out = await config.confirmVerifiedInSandbox("smartbill");
        expect(out.ok).toBe(false);
        expect((await config.state("smartbill")).verifiedInSandboxAt).toBeNull();
      },
      { reachable: false },
    );
  });

  it("un furnizor în LIVE neverificat nu se construiește (nici dacă ar ajunge așa în bază)", async () => {
    await withConfig(async (config, tx) => {
      await config.save("smartbill", { credentials: smartbill(), isActive: true });
      await config.confirmVerifiedInSandbox("smartbill");
      await config.save("smartbill", { mode: "live", confirmLive: true });
      await tx.integration.updateMany({
        where: { type: "invoicing", provider: "smartbill" },
        data: { verifiedInSandboxAt: null },
      });
      expect(await config.provider("smartbill")).toBeNull();
    });
  });
});

describe("ce furnizor se folosește", () => {
  it("doar cel ales, activ și complet configurat", async () => {
    await withConfig(
      async (config) => {
        expect(await config.active()).toBeNull(); // nesalvat
        await config.save("smartbill", { credentials: smartbill() });
        expect(await config.active()).toBeNull(); // inactiv
        await config.save("smartbill", { isActive: true });
        expect(await config.active()).toBe("smartbill");
      },
      { selected: "smartbill" },
    );
  });

  it("alegerea e în setări: fără alegere nu se folosește nimic", async () => {
    await withConfig(async (config) => {
      await config.save("smartbill", { credentials: smartbill(), isActive: true });
      expect(await config.active()).toBeNull();
    });
  });

  it("nu se poate activa un furnizor cu date lipsă", async () => {
    await withConfig(async (config) => {
      expect(await codeOf(config.save("smartbill", { isActive: true }))).toBe(
        "INVOICING_NOT_CONFIGURED",
      );
    });
  });
});

describe("furnizorul DEMO", () => {
  it("există doar dacă garda o permite", async () => {
    await withConfig(async (config) => {
      expect(await codeOf(config.state("demo"))).toBe("INVOICING_DEMO_FORBIDDEN");
      expect(config.visibleCodes()).toEqual(["smartbill"]);
      expect(await config.provider("demo")).toBeNull();
    });
    await withConfig(
      async (config) => {
        expect(config.visibleCodes()).toEqual(["smartbill", "demo"]);
        await config.save("demo", { isActive: true });
        const provider = await config.provider("demo");
        expect(provider?.simulated).toBe(true);
      },
      { env: { NODE_ENV: "development", ECOM_DEMO_PAYMENTS: "1" }, selected: "demo" },
    );
  });
});
