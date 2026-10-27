/**
 * Proba de dezvoltare pentru emailul «Anunță-mă când revine» (Faza 5, punctul 11b), pe baza de DEZVOLTARE (cea din `.env`),
 * ca să vezi emailul în Mailpit. Scriptul nu schimbă stocul și nu trimite nimic el însuși: doar înregistrează, arată și
 * șterge o cerere de test; emailul îl trimite jobul `stock-back-in-stock` din worker, după ce tu adaugi stoc din admin.
 *
 *   npm.cmd run dev:back-in-stock -- add <SKU>      înregistrează cererea de test pentru varianta cu acel SKU
 *   npm.cmd run dev:back-in-stock -- status <SKU>   spune în ce stare e cererea ta de test (și câte cereri sunt în total)
 *   npm.cmd run dev:back-in-stock -- clean <SKU>    șterge DOAR cererea ta de test pentru acel SKU
 *
 * Adresa de test se citește din variabila de mediu `PROBE_EMAIL`, NU din linia de comandă, și nu se afișează nicăieri
 * (nici în rezultate, nici în erori). Cererile altor adrese nu se ating.
 */
import { Redis } from "ioredis";
import {
  BackInStockError,
  SettingsService,
  createPrismaSettingsStore,
  normalizeAlertEmail,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { createBackInStockService } from "../src/back-in-stock-runtime";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // fără .env: variabilele vin din mediu
}

const [command, sku] = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!["add", "status", "clean"].includes(command ?? "") || !sku) {
  fail("Folosire: npm.cmd run dev:back-in-stock -- <add|status|clean> <SKU>");
}
const rawEmail = process.env["PROBE_EMAIL"];
if (!rawEmail) {
  fail(
    'Lipsește variabila PROBE_EMAIL. În PowerShell: $env:PROBE_EMAIL = Read-Host "Adresa de test" (se aplică doar ferestrei curente).',
  );
}
let email: string;
try {
  email = normalizeAlertEmail(rawEmail);
} catch {
  fail("PROBE_EMAIL nu este o adresă de email validă.");
}

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) fail("DATABASE_URL lipsește (.env).");
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));

const db = getDb();
const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) fail("REDIS_URL lipsește (.env).");
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
redis.on("error", () => undefined); // cache-ul setărilor cade pe baza de date

async function main(): Promise<void> {
  const variant = await db.productVariant.findUnique({
    where: { sku: sku! },
    select: { id: true, product: { select: { title: true, status: true } } },
  });
  if (!variant) fail(`Nu există nicio variantă cu SKU «${sku}».`);
  console.log(
    `Baza de date: ${databaseName}. Produs: ${variant.product.title} (${variant.product.status}).`,
  );

  if (command === "add") {
    const service = createBackInStockService(
      db,
      new SettingsService(createPrismaSettingsStore(db), redis),
    );
    try {
      const result = await service.subscribe({ variantId: variant.id, email });
      if (result.status === "available") {
        console.log(
          "Varianta se poate comanda deja, deci nu s-a păstrat nicio cerere. Pune stocul la 0 (Admin → Stoc) și rulează din nou.",
        );
      } else {
        console.log(
          "Cererea de test e înregistrată. Acum adaugă stoc ≥ 1 pe acest produs din admin; în cel mult ~2 minute apare emailul în Mailpit.",
        );
      }
    } catch (error) {
      if (error instanceof BackInStockError) fail(`Cererea a fost refuzată: ${error.code}.`);
      throw error;
    }
    return;
  }

  const mine = await db.$queryRaw<Array<{ notified: boolean }>>`
    SELECT ("notifiedAt" IS NOT NULL) AS notified FROM back_in_stock_alert
    WHERE "variantId" = ${variant.id} AND lower("email") = ${email}`;

  if (command === "status") {
    const pending = await db.backInStockAlert.count({
      where: { variantId: variant.id, notifiedAt: null },
    });
    const sent = await db.backInStockAlert.count({
      where: { variantId: variant.id, notifiedAt: { not: null } },
    });
    const own =
      mine.length === 0
        ? "nu există (neînregistrată sau deja trimisă și ștearsă)"
        : mine.some((r) => !r.notified)
          ? "în așteptare"
          : "luată pentru trimitere, încă neștearsă (se șterge după trimitere; altfel, curățarea de siguranță)";
    console.log(`Cererea ta de test: ${own}.`);
    console.log(`Pe această variantă, în total: ${pending} în așteptare, ${sent} luate.`);
    return;
  }

  const deleted = await db.$executeRaw`
    DELETE FROM back_in_stock_alert WHERE "variantId" = ${variant.id} AND lower("email") = ${email}`;
  console.log(
    deleted === 0
      ? "Nu aveai nicio cerere de test pe această variantă."
      : `Am șters ${deleted} cerere(i) de test.`,
  );
}

main()
  .catch((error: unknown) => {
    // doar tipul erorii: mesajele bazei de date pot cita valorile din interogare, adică adresa
    console.error(`Eroare: ${error instanceof Error ? error.name : "necunoscută"}.`);
    process.exitCode = 1;
  })
  .finally(async () => {
    redis.disconnect();
    await db.$disconnect();
  });
