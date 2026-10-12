import { describe, expect, it } from "vitest";
import { IntegrationService, type IntegrationRecord } from "../integrations/integration-service";
import { SettingsService } from "../settings/settings-service";
import { createFakeCache } from "../test-utils/fake-cache";
import { EmailNotConfiguredError, SMTP_INTEGRATION, loadMailerConfig } from "./smtp-config";

const APP_KEY = Buffer.alloc(32, 3).toString("base64");

function setup(emailSettings: Record<string, string> = {}) {
  const records = new Map<string, IntegrationRecord>();
  const integrations = new IntegrationService(
    {
      find: async (type, provider) => records.get(`${type}:${provider}`) ?? null,
      upsert: async (record) => {
        records.set(`${record.type}:${record.provider}`, record);
      },
    },
    APP_KEY,
  );
  const rows = Object.entries(emailSettings).map(([key, value]) => ({
    key: `email.${key}`,
    value,
  }));
  const settings = new SettingsService(
    { loadAll: async () => rows, upsert: async () => undefined },
    createFakeCache().cache,
  );
  return { integrations, settings, records };
}

describe("loadMailerConfig", () => {
  it("integrare lipsă sau inactivă => null (emailul nu pleacă, fără eroare)", async () => {
    const s = setup({ fromAddress: "noreply@magazin.test" });
    expect(await loadMailerConfig(s)).toBeNull();
    await s.integrations.save({
      ...SMTP_INTEGRATION,
      config: { host: "smtp.test", port: 587 },
      isActive: false,
    });
    expect(await loadMailerConfig(s)).toBeNull();
  });

  it("combină serverul din Integration cu expeditorul din setări; parola vine decriptată", async () => {
    const s = setup({ fromName: "Magazin", fromAddress: "noreply@magazin.test" });
    await s.integrations.save({
      ...SMTP_INTEGRATION,
      credentials: { password: "parola-smtp" },
      config: { host: "smtp.test", port: 465, secure: true, user: "apikey" },
      isActive: true,
    });
    expect(await loadMailerConfig(s)).toEqual({
      host: "smtp.test",
      port: 465,
      secure: true,
      user: "apikey",
      password: "parola-smtp",
      fromName: "Magazin",
      fromAddress: "noreply@magazin.test",
    });
    // În baza de date parola e criptată, nu în clar.
    const stored = s.records.get("email:smtp");
    expect(stored?.credentials).toMatch(/^v1:/);
    expect(JSON.stringify(stored)).not.toContain("parola-smtp");
  });

  it("fără autentificare (Mailpit): fără user/password", async () => {
    const s = setup({ fromAddress: "noreply@magazin.test" });
    await s.integrations.save({
      ...SMTP_INTEGRATION,
      config: { host: "localhost", port: 1025 },
      isActive: true,
    });
    const config = await loadMailerConfig(s);
    expect(config).toMatchObject({ host: "localhost", port: 1025, secure: false });
    expect(config).not.toHaveProperty("password");
    expect(config).not.toHaveProperty("user");
  });

  it("activă dar incompletă (fără expeditor sau cu config invalid) => EmailNotConfiguredError", async () => {
    const noSender = setup();
    await noSender.integrations.save({
      ...SMTP_INTEGRATION,
      config: { host: "smtp.test", port: 587 },
      isActive: true,
    });
    await expect(loadMailerConfig(noSender)).rejects.toBeInstanceOf(EmailNotConfiguredError);

    const badConfig = setup({ fromAddress: "noreply@magazin.test" });
    await badConfig.integrations.save({
      ...SMTP_INTEGRATION,
      config: { port: "nu-e-numar" },
      isActive: true,
    });
    await expect(loadMailerConfig(badConfig)).rejects.toBeInstanceOf(EmailNotConfiguredError);
  });
});
