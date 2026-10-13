/**
 * Doar citire: ultimele 5 fișiere din biblioteca media: `pnpm media:recent` (sau `npm run media:recent`).
 * Arată id, status, dimensiuni, blurhash, numărul de variante și codul de eroare. Nu afișează
 * chei de storage, URL-uri, nume de fișier sau credențiale și nu modifică nimic.
 */
import { getDb, loadRootEnv } from "./_runtime";

loadRootEnv();
const db = getDb();

try {
  const rows = await db.media.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      status: true,
      width: true,
      height: true,
      blurhash: true,
      variants: true,
      processingError: true,
      createdAt: true,
    },
  });
  if (rows.length === 0) {
    console.log("Nu există încă niciun fișier în biblioteca media.");
  } else {
    console.table(
      rows.map((r) => ({
        id: r.id,
        status: r.status,
        width: r.width,
        height: r.height,
        blurhash: r.blurhash,
        variante: Array.isArray(r.variants) ? r.variants.length : 0,
        eroare: r.processingError,
        creat: r.createdAt.toISOString().slice(0, 19).replace("T", " "),
      })),
    );
  }
} catch (error) {
  console.error(
    "Citirea a eșuat (Postgres pornit?):",
    error instanceof Error ? error.name : "eroare",
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
