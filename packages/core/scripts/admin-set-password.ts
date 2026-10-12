/**
 * Schimbă parola unui cont existent: `pnpm admin:set-password <email>`. Pentru recuperare când
 * emailul nu e configurat (nu merge „am uitat parola"). Rulează într-un terminal interactiv; parola
 * se tastează de două ori, FĂRĂ echo, și nu poate veni din argumente, variabile de mediu, pipe sau
 * fișier. Închide toate sesiunile contului, resetează blocarea de login și scrie în audit
 * (motiv „schimbare din CLI"), fără parolă și fără hash.
 */
import { Redis } from "ioredis";
import { NotInteractiveError, PromptCancelledError, promptNewPassword } from "../src/cli/prompt";
import { AuthGuard } from "../src/auth/auth-guard";
import { createOwnerSchema, loadMinPasswordLength } from "../src/auth/create-admin";
import { RedisCounterStore } from "../src/auth/counter-store";
import { createRedisSecondaryStorage } from "../src/auth/redis-storage";
import { revokeCachedSessions, setAccountPassword } from "../src/auth/set-password";
import { settingGroups } from "../src/settings/registry";
import { z } from "zod";
import { getDb, loadRootEnv } from "./_runtime";

loadRootEnv();

const args = process.argv.slice(2);
const email = args[0]?.trim().toLowerCase();
if (args.length !== 1 || !email || !z.email().safeParse(email).success) {
  console.error("Folosire: pnpm admin:set-password <email>");
  console.error("Parola se cere interactiv; nu se dă ca argument.");
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error(new NotInteractiveError().message);
  process.exit(1);
}

const db = getDb();
const redisUrl = process.env["REDIS_URL"];
const redis = redisUrl
  ? new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true })
  : null;
redis?.on("error", () => undefined);

try {
  const user = await db.user.findUnique({ where: { email }, select: { name: true } });
  if (!user) {
    console.error("Nu există niciun utilizator cu acest email.");
    process.exitCode = 1;
  } else {
    console.log(`Schimb parola pentru ${email} (${user.name}).`);
    const minLength = await loadMinPasswordLength(db);
    const password = await promptNewPassword({
      validate: (value) => {
        const check = createOwnerSchema(minLength).shape.password.safeParse(value);
        return check.success ? null : check.error.issues.map((i) => i.message).join("; ");
      },
    });

    const result = await db.$transaction((tx) => setAccountPassword(tx, { email, password }));
    console.log(`Parola a fost schimbată. Sesiuni închise: ${result.sessionTokens.length}.`);

    // Curățarea Redis (sesiuni în cache, contoare de blocare) e best-effort, după commit.
    let redisOk = false;
    if (redis) {
      try {
        await redis.connect();
        redisOk = await revokeCachedSessions(
          createRedisSecondaryStorage(redis),
          result.userId,
          result.sessionTokens,
        );
        const guard = new AuthGuard(
          new RedisCounterStore(redis),
          z.object(settingGroups.auth).parse({}),
        );
        await guard.unlock(email);
      } catch {
        redisOk = false;
      }
    }
    if (!redisOk) {
      console.warn(
        "ATENȚIE: Redis nu a răspuns. Sesiunile din cache pot rămâne valide până expiră (și o blocare de cont nu a fost resetată). Repornește Redis și rulează din nou comanda, sau `pnpm admin:unlock <email>`.",
      );
    }
  }
} catch (error) {
  if (error instanceof PromptCancelledError) {
    console.error("\nAnulat. Nu s-a schimbat nimic.");
  } else {
    // Mesajele erorilor de domeniu și de validare nu conțin parola.
    console.error(error instanceof Error ? error.message : "Eroare necunoscută.");
  }
  process.exitCode = 1;
} finally {
  redis?.disconnect();
  await db.$disconnect();
}
