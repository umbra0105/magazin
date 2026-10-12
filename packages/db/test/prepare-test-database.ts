import { execSync } from "node:child_process";
import { Client } from "pg";
import { assertTestDatabase, assertTestRedis } from "../../../test/support/test-env";

const NAME_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * Pregătește baza de test: o creează dacă lipsește (în același Postgres) și îi aplică migrațiile.
 * Refuză orice bază fără „test” în nume. Comună testelor de integrare (Vitest) și E2E (Playwright);
 * fără `import.meta`, ca să poată fi încărcată și ca CommonJS.
 *
 * @param prismaDir directorul pachetului `@ecom/db` (unde rulează `prisma migrate deploy`)
 */
export async function prepareTestDatabase(
  testUrl: string | undefined,
  testRedisUrl: string | undefined,
  prismaDir: string,
): Promise<void> {
  assertTestDatabase(testUrl);
  assertTestRedis(testRedisUrl);

  const name = new URL(testUrl).pathname.replace(/^\//, "");
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Nume de bază de test nepermis: „${name}” (doar litere, cifre și _).`);
  }

  // Conectare la baza de întreținere „postgres” de pe același server, ca să putem crea baza de test.
  const admin = new URL(testUrl);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (exists.rowCount === 0) {
      try {
        await client.query(`create database "${name}"`);
        console.log(`[teste] baza „${name}” creată`);
      } catch (error) {
        // 42P04 = există deja (rulări paralele)
        if ((error as { code?: string }).code !== "42P04") throw error;
      }
    }
  } finally {
    await client.end();
  }

  try {
    execSync("pnpm exec prisma migrate deploy", {
      cwd: prismaDir,
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "pipe",
    });
  } catch (error) {
    const out = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `Migrațiile pe baza de test „${name}” au eșuat:\n${out.stdout?.toString() ?? ""}${out.stderr?.toString() ?? ""}`,
      { cause: error },
    );
  }
}
