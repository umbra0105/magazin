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

/**
 * Scrie o setare în baza de TEST (aceeași formă ca `Setting`: key, group, value JSON). Folosit de
 * global setup-ul E2E (ex. `auth.trustedProxyHops`), înaintea seed-ului care invalidează cache-urile.
 */
export async function setTestSetting(
  databaseUrl: string | undefined,
  key: string,
  value: unknown,
): Promise<void> {
  assertTestDatabase(databaseUrl);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `insert into setting (key, "group", value, "updatedAt") values ($1, $2, $3::jsonb, now())
       on conflict (key) do update set value = excluded.value, "updatedAt" = now()`,
      [key, key.split(".")[0], JSON.stringify(value)],
    );
  } finally {
    await client.end();
  }
}
