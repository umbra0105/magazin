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
    // Produsele de test (slug `e2e-…`) referă fișiere media (FK Restrict): se șterg ÎNAINTEA fișierelor.
    await client.query(`delete from product where slug like 'e2e-%'`);
    // Categoriile și brandurile de test (slug `e2e-…`) pot referi fișiere media (FK Restrict): se șterg
    // înaintea fișierelor. Categoriile se șterg frunzele întâi (părintele e Restrict).
    for (let i = 0; i < 6; i++) {
      const gone = await client.query(
        `delete from category c where c.slug like 'e2e-%' and not exists (select 1 from category k where k."parentId" = c.id)`,
      );
      if ((gone.rowCount ?? 0) === 0) break;
    }
    await client.query(`delete from brand where slug like 'e2e-%'`);
    // Fișierele media încărcate de conturile de test (rândurile; obiectele stau în directorul
    // temporar al E2E, șters de global-teardown) și folderele rămase goale cu prefixul testelor.
    await client.query(
      `delete from media where "uploadedById" in (select id from "user" where email like 'e2e-%@example.test')`,
    );
    await client.query(
      `delete from media_folder f where f.name like 'Produse %' and not exists (select 1 from media m where m."folderId" = f.id) and not exists (select 1 from media_folder c where c."parentId" = f.id)`,
    );
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
