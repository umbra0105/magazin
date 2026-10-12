import { Client } from "pg";
import { Redis } from "ioredis";
import { assertTestDatabase, assertTestRedis } from "../../../test/support/test-env";

/**
 * Ajutoare pentru testele E2E, care pregătesc starea direct în baza de TEST (după ce conturile se
 * creează prin API-ul real): rol, email verificat, vârsta sesiunii, flag-uri. Fiecare funcție
 * refuză să ruleze fără baza/Redis-ul de test (aceeași gardă ca la integrare). Fără `import.meta`,
 * ca să poată fi încărcat și de Playwright (CommonJS).
 */

const dbUrl = (): string => {
  const url = process.env["TEST_DATABASE_URL"];
  assertTestDatabase(url);
  return url;
};

const redisUrl = (): string => {
  const url = process.env["TEST_REDIS_URL"];
  assertTestRedis(url);
  return url;
};

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: dbUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withRedis<T>(fn: (redis: Redis) => Promise<T>): Promise<T> {
  const redis = new Redis(redisUrl());
  try {
    return await fn(redis);
  } finally {
    redis.disconnect();
  }
}

/** Marchează emailul ca verificat și (opțional) atribuie un rol de sistem (`owner`, `support`, …). */
export async function promoteE2eUser(email: string, roleKey: string | null): Promise<void> {
  await withClient(async (db) => {
    const user = await db.query(
      `update "user" set "emailVerified" = true where email = $1 returning id`,
      [email],
    );
    const userId = user.rows[0]?.id as string | undefined;
    if (!userId) throw new Error(`Utilizatorul de test ${email} nu există`);
    if (roleKey) {
      const role = await db.query(`select id from role where key = $1`, [roleKey]);
      const roleId = role.rows[0]?.id as string | undefined;
      if (!roleId) throw new Error(`Rolul ${roleKey} nu există în baza de test (seed lipsă?)`);
      await db.query(
        `insert into user_role ("userId", "roleId") values ($1, $2) on conflict do nothing`,
        [userId, roleId],
      );
    }
  });
}

/**
 * „Îmbătrânește” sesiunile unui utilizator cu `hours` ore (createdAt în DB) și șterge copiile din
 * cache-ul Redis al sesiunilor, ca următoarea cerere să citească vârsta nouă din DB.
 */
export async function ageE2eSessions(email: string, hours: number): Promise<number> {
  const tokens = await withClient(async (db) => {
    const result = await db.query(
      `update session set "createdAt" = now() - ($2 || ' hours')::interval
       where "userId" = (select id from "user" where email = $1) returning token, "userId"`,
      [email, String(hours)],
    );
    return result.rows as { token: string; userId: string }[];
  });
  await withRedis(async (redis) => {
    for (const { token, userId } of tokens) {
      await redis.del(`ecom:auth:${token}`, `ecom:auth:active-sessions-${userId}`);
    }
  });
  return tokens.length;
}

/** Face expirat tokenul de verificare al emailului unui utilizator (expiresAt în trecut). */
export async function expireE2eVerificationToken(email: string): Promise<number> {
  return withClient(async (db) => {
    const result = await db.query(
      `update verification set "expiresAt" = now() - interval '1 minute'
       where identifier = 'ecom:verify-email:' || (select id from "user" where email = $1)`,
      [email],
    );
    return result.rowCount ?? 0;
  });
}

/** Emailul utilizatorului e verificat? (pentru aserțiuni în teste). */
export async function isE2eUserVerified(email: string): Promise<boolean> {
  return withClient(async (db) => {
    const result = await db.query(`select "emailVerified" as v from "user" where email = $1`, [
      email,
    ]);
    return result.rows[0]?.v === true;
  });
}

/** Pornește/oprește un flag de funcționalitate și invalidează cache-ul lui. */
export async function setE2eFeatureFlag(key: string, enabled: boolean): Promise<void> {
  await withClient(async (db) => {
    await db.query(
      `insert into feature_flag (key, enabled, "updatedAt") values ($1, $2, now())
       on conflict (key) do update set enabled = excluded.enabled, "updatedAt" = now()`,
      [key, enabled],
    );
  });
  await withRedis((redis) => redis.del("ecom:feature-flags:v1"));
}

/** Șterge contoarele de limitare (`ecom:rl:*`) din Redis-ul de TEST, ca o rulare să nu o moștenească pe alta. */
export async function clearE2eRateLimits(): Promise<number> {
  return withRedis(async (redis) => {
    let removed = 0;
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "ecom:rl:*", "COUNT", 200);
      cursor = next;
      if (keys.length > 0) removed += await redis.del(...keys);
    } while (cursor !== "0");
    return removed;
  });
}
