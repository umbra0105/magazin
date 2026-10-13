/**
 * Regenerează variantele media din original: `pnpm media:regenerate <id | --failed | --stale | --all>`.
 *
 *   <id>      un fișier anume
 *   --failed  toate cele cu status `failed`
 *   --stale   cele rămase `pending`/`processing` de peste 5 minute (ex. punerea în coadă a eșuat)
 *   --all     toate fișierele (după schimbarea lățimilor sau calității din setări)
 *
 * Nu șterge nimic și nu atinge originalul: variantele noi se scriu cu chei noi, iar cele vechi se
 * scot din storage abia după ce rândul a fost actualizat. Afișează doar numărul de fișiere.
 */
import { loadEnv } from "@ecom/config";
import {
  AuditService,
  createPrismaAuditStore,
  createPrismaProcessingStore,
  requestMediaProcessing,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { createMediaQueue, mediaJobQueue } from "../src/media-queue";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // fără .env: variabilele vin din mediu
}

const arg = process.argv[2];
const usage = "Folosire: pnpm media:regenerate <id | --failed | --stale | --all>";
if (!arg) {
  console.error(usage);
  process.exit(1);
}

const STALE_MS = 5 * 60 * 1000;
const db = getDb();
const queue = createMediaQueue(loadEnv().REDIS_URL);
queue.on("error", () => undefined);

try {
  let ids: string[];
  if (arg === "--all") {
    ids = (await db.media.findMany({ select: { id: true } })).map((m) => m.id);
  } else if (arg === "--failed") {
    ids = (await db.media.findMany({ where: { status: "failed" }, select: { id: true } })).map(
      (m) => m.id,
    );
  } else if (arg === "--stale") {
    const before = new Date(Date.now() - STALE_MS);
    ids = (
      await db.media.findMany({
        where: { status: { in: ["pending", "processing"] }, updatedAt: { lt: before } },
        select: { id: true },
      })
    ).map((m) => m.id);
  } else if (arg.startsWith("--")) {
    console.error(usage);
    process.exit(1);
  } else {
    const found = await db.media.findUnique({ where: { id: arg }, select: { id: true } });
    if (!found) {
      console.error("Nu există niciun fișier cu acest id.");
      process.exit(1);
    }
    ids = [found.id];
  }

  const deps = { store: createPrismaProcessingStore(db), queue: mediaJobQueue(queue) };
  let queued = 0;
  for (const id of ids) {
    await requestMediaProcessing(deps, id);
    queued += 1;
  }

  await new AuditService(createPrismaAuditStore(db)).record({
    actorId: "cli",
    actorLabel: "cli:media:regenerate",
    action: "media.regenerate",
    entity: "media",
    entityId: ids.length === 1 ? (ids[0] ?? null) : null,
    after: { selection: arg.startsWith("--") ? arg : "id", count: queued },
  });
  console.log(
    queued === 0
      ? "Niciun fișier de regenerat."
      : `${queued} fișier(e) puse în coadă. Workerul (pnpm dev:web sau pnpm worker) le procesează.`,
  );
} catch (error) {
  console.error(
    "Regenerarea a eșuat (Redis și baza de date pornite?):",
    error instanceof Error ? error.name : "eroare",
  );
  process.exitCode = 1;
} finally {
  await queue.close();
  await db.$disconnect();
}
