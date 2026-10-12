/**
 * DOAR PENTRU DEZVOLTARE: `pnpm dev:age-session <email> <ore>` „îmbătrânește” sesiunile unui utilizator
 * cu <ore> ore, ca să poți vedea manual expirarea sesiunii de admin („Sesiunea a expirat”), fără să
 * aștepți. Refuză în producție. Nu cere și nu afișează parole sau tokenuri.
 */
import { Redis } from "ioredis";
import { parseAgeSessionArgs } from "./_dev-age-session-args";
import { getDb, loadRootEnv } from "./_runtime";

loadRootEnv();

const args = parseAgeSessionArgs(process.argv.slice(2), process.env);
if (!args.ok) {
  console.error(args.message);
  process.exit(1);
}

const db = getDb();
const redisUrl = process.env["REDIS_URL"];
const redis = redisUrl
  ? new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000 })
  : null;
redis?.on("error", () => undefined);

try {
  const user = await db.user.findUnique({ where: { email: args.email } });
  if (!user) {
    console.error(`Nu există niciun utilizator cu emailul ${args.email}.`);
    process.exit(1);
  }
  const sessions = await db.session.findMany({
    where: { userId: user.id },
    select: { token: true },
  });
  const createdAt = new Date(Date.now() - args.hours * 3600 * 1000);
  await db.session.updateMany({ where: { userId: user.id }, data: { createdAt } });

  // Copiile din cache-ul Redis al sesiunilor, ca următoarea cerere să citească vârsta nouă din DB.
  let cacheCleared = true;
  try {
    await redis?.connect();
    for (const { token } of sessions) {
      await redis?.del(`ecom:auth:${token}`);
    }
    await redis?.del(`ecom:auth:active-sessions-${user.id}`);
  } catch {
    cacheCleared = false;
  }

  console.log(
    `${sessions.length} sesiuni ale lui ${args.email} au acum vârsta de ${args.hours} ore.` +
      (cacheCleared
        ? ""
        : " Atenție: cache-ul Redis nu a putut fi curățat; reîncearcă cu Redis pornit."),
  );
  if (sessions.length === 0)
    console.log("Utilizatorul nu are sesiuni active (autentifică-te întâi).");
} catch (error) {
  console.error("Comanda a eșuat:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  redis?.disconnect();
  await db.$disconnect();
}
