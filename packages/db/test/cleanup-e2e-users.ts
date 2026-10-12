import { Client } from "pg";
import { assertTestDatabase } from "../../../test/support/test-env";

/**
 * Șterge utilizatorii creați de testele E2E (emailul `e2e-<id>@example.test`) din baza de TEST;
 * conturile, sesiunile și rolurile lor dispar în cascadă. Refuză orice bază fără „test” în nume.
 */
export async function cleanupE2eUsers(databaseUrl: string | undefined): Promise<number> {
  assertTestDatabase(databaseUrl);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(`delete from "user" where email like 'e2e-%@example.test'`);
    return result.rowCount ?? 0;
  } finally {
    await client.end();
  }
}
