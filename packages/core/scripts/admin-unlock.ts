/**
 * Deblochează un cont blocat după prea multe încercări de login: `pnpm admin:unlock <email>`.
 * Scoate blocarea și contorul de eșecuri din Redis. Nu cere și nu afișează parole.
 * Limita de cereri pe perechea IP+email (5 / 15 minute) expiră singură; dacă ai încercat tu de
 * mai multe ori de pe același IP, mai poți primi "prea multe încercări" până la expirarea ferestrei.
 */
import { Redis } from "ioredis";
import { z } from "zod";
import { AuditService, createPrismaAuditStore } from "../src/audit";
import { AuthGuard } from "../src/auth/auth-guard";
import { RedisCounterStore } from "../src/auth/counter-store";
import { settingGroups } from "../src/settings/registry";
import { getDb, loadRootEnv } from "./_runtime";

loadRootEnv();

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !z.email().safeParse(email).success) {
  console.error("Folosire: pnpm admin:unlock <email>");
  process.exit(1);
}
const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) {
  console.error("REDIS_URL lipsește din mediu (.env).");
  process.exit(1);
}

const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
redis.on("error", () => undefined);
const db = getDb();

try {
  const guard = new AuthGuard(new RedisCounterStore(redis), z.object(settingGroups.auth).parse({}));
  await guard.unlock(email);

  const user = await db.user.findUnique({ where: { email } });
  if (user) {
    await new AuditService(createPrismaAuditStore(db)).record({
      actorId: "cli",
      actorLabel: "cli:admin:unlock",
      action: "auth.account_unlocked",
      entity: "user",
      entityId: user.id,
      after: { cleared: true },
    });
  }
  console.log(
    `Blocările și contoarele de eșecuri pentru ${email} au fost șterse, de pe toate adresele.`,
  );
  if (!user) console.log("Atenție: nu există niciun utilizator cu acest email.");
} catch (error) {
  console.error(
    "Deblocarea a eșuat (Redis pornit?):",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  redis.disconnect();
  await db.$disconnect();
}
