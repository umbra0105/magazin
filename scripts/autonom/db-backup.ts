/**
 * `npm.cmd run db:backup`: copia de siguranță a bazei LOCALE de dezvoltare (docs/20 §6.1), la începutul fiecărei faze autonome. Face un
 * `pg_dump` (SQL simplu) prin containerul Postgres de dezvoltare, în `local-data/backups/<baza>-AAAALLZZ-OOMMSS.sql` (în `.gitignore`),
 * și păstrează ultimele 5. Doar CITEȘTE din bază; refuză bazele de test, bazele de sistem și serverele care nu sunt locale. Parola nu se
 * tipărește și nu apare în argumente: ajunge în container prin variabila de mediu `PGPASSWORD`. Tipărește o linie gata de pus în
 * `docs/AUTONOM-LOG.md`. Dacă Docker sau baza nu răspund, se oprește curat (cod 1), fără să încerce să pornească nimic.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { KEEP_BACKUPS, backupFileName, backupsToDelete, parseDevDatabase } from "./backup-core";

const ROOT = process.cwd();
const POSTGRES_CONTAINER = "ecom-dev-postgres-1";

function dump(
  target: string,
  db: ReturnType<typeof parseDevDatabase>,
): Promise<{ code: number; error: string }> {
  return new Promise((resolve) => {
    const out = createWriteStream(target);
    // `-e PGPASSWORD` fără valoare: Docker o ia din mediul acestui proces (parola nu apare în lista de argumente)
    const child = spawn(
      "docker",
      [
        "exec",
        "-e",
        "PGPASSWORD",
        POSTGRES_CONTAINER,
        "pg_dump",
        "-U",
        db.user,
        "-d",
        db.database,
        "--no-owner",
      ],
      { cwd: ROOT, env: { ...process.env, PGPASSWORD: db.password }, windowsHide: true },
    );
    let error = "";
    child.stdout.pipe(out);
    child.stderr.on("data", (chunk: Buffer) => (error += chunk.toString("utf8")));
    child.on("error", (spawnError) => {
      out.end();
      resolve({ code: 127, error: spawnError.message });
    });
    child.on("close", (code) => out.end(() => resolve({ code: code ?? 1, error })));
  });
}

async function main(): Promise<number> {
  try {
    process.loadEnvFile(join(ROOT, ".env"));
  } catch {
    console.error("db:backup: lipsește .env (DATABASE_URL).");
    return 1;
  }
  let db: ReturnType<typeof parseDevDatabase>;
  try {
    db = parseDevDatabase(process.env["DATABASE_URL"] ?? "");
  } catch (error) {
    console.error(`db:backup: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const dir = join(ROOT, "local-data", "backups");
  mkdirSync(dir, { recursive: true });
  const name = backupFileName(db.database, new Date());
  const target = join(dir, name);
  const result = await dump(target, db);
  if (result.code !== 0 || statSync(target).size === 0) {
    rmSync(target, { force: true });
    console.error(
      `db:backup: pg_dump a eșuat (cod ${result.code}). Docker sau Postgres nu răspund; nu pornesc nimic. ${result.error.trim()}`,
    );
    return 1;
  }

  for (const old of backupsToDelete(readdirSync(dir), db.database, KEEP_BACKUPS)) {
    rmSync(join(dir, old), { force: true });
  }
  const kept = readdirSync(dir).filter(
    (file) => file.startsWith(`${db.database}-`) && file.endsWith(".sql"),
  ).length;
  const kb = Math.round(statSync(target).size / 1024);
  console.log(
    `Copie a bazei «${db.database}»: local-data/backups/${name} (${kb} KB; se păstrează ultimele ${KEEP_BACKUPS}, acum ${kept}).`,
  );
  console.log(`Pentru docs/AUTONOM-LOG.md: copie bază: local-data/backups/${name}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      `db:backup: eroare neașteptată: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  },
);
