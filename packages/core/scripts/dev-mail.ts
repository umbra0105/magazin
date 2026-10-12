/**
 * Utilitar DOAR pentru dezvoltare și testele E2E (nu face parte din produs): configurează trimiterea
 * emailurilor spre Mailpit (docker compose), prin aceleași mecanisme ca în admin: `Integration`
 * (email/smtp) și setările `email.*`.
 *
 *   pnpm dev:mail [--host localhost] [--port 1025]
 *
 * Mailpit primește mesajele pe SMTP (1025) și le arată la http://localhost:8025. Fără autentificare,
 * deci nu există nicio parolă. Un magazin real își configurează SMTP din admin.
 */
import { createPrismaIntegrationStore } from "../src/integrations/prisma-store";
import { IntegrationService } from "../src/integrations/integration-service";
import { createPrismaSettingsStore } from "../src/settings/prisma-store";
import { SMTP_INTEGRATION } from "../src/email/smtp-config";
import { getDb, invalidateConfigCaches, loadRootEnv } from "./_runtime";

loadRootEnv();

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const host = option("host", "localhost");
const port = Number(option("port", "1025"));
const appKey = process.env["APP_KEY"];
if (!appKey || !Number.isInteger(port)) {
  console.error("Lipsește APP_KEY din mediu (.env) sau --port nu e un număr.");
  process.exit(1);
}

const db = getDb();
try {
  const integrations = new IntegrationService(createPrismaIntegrationStore(db), appKey);
  await integrations.save({
    ...SMTP_INTEGRATION,
    config: { host, port, secure: false },
    isActive: true,
  });

  const settings = createPrismaSettingsStore(db);
  await settings.upsert({ key: "email.fromName", group: "email", value: "Magazin Online" });
  await settings.upsert({
    key: "email.fromAddress",
    group: "email",
    value: "noreply@magazin.test",
  });

  const cleared = await invalidateConfigCaches();
  console.log(`Email configurat spre Mailpit (${host}:${port}); expeditor noreply@magazin.test.`);
  console.log(`  cache Redis: ${cleared ? "golit" : "indisponibil (expiră singur)"}`);
  console.log("  Mesajele se văd la http://localhost:8025");
} finally {
  await db.$disconnect();
}
