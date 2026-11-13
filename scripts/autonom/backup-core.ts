/**
 * Copia de siguranță a bazei de dezvoltare (docs/20 §6.1): partea pură, testată. `db:backup` face un `pg_dump` al bazei LOCALE de
 * dezvoltare în `local-data/backups/` (în `.gitignore`) și păstrează ultimele 5 copii. Bazele de test sunt de unică folosință și nu
 * se salvează; un server care nu e local nu se atinge niciodată. Nicio funcție de aici nu tipărește parola.
 */
export const KEEP_BACKUPS = 5;

export interface DevDatabase {
  user: string;
  password: string;
  database: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SYSTEM_DATABASES = new Set(["postgres", "template0", "template1"]);

/** Baza de dezvoltare din `DATABASE_URL`; aruncă o eroare (fără parolă în mesaj) dacă nu e o bază locală de dezvoltare. */
export function parseDevDatabase(url: string): DevDatabase {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL lipsește sau nu e un URL valid");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL nu e un URL PostgreSQL");
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `serverul «${parsed.hostname}» nu e local: copia se face doar pentru baza locală de dezvoltare`,
    );
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (database === "") throw new Error("DATABASE_URL nu are numele bazei");
  if (/test/i.test(database)) {
    throw new Error(`«${database}» e o bază de test (de unică folosință): nu se salvează`);
  }
  if (SYSTEM_DATABASES.has(database.toLowerCase())) {
    throw new Error(`«${database}» e o bază de sistem: nu se salvează`);
  }
  const user = decodeURIComponent(parsed.username);
  if (user === "") throw new Error("DATABASE_URL nu are utilizatorul");
  return { user, password: decodeURIComponent(parsed.password), database };
}

const two = (value: number): string => String(value).padStart(2, "0");

/** `<baza>-AAAALLZZ-OOMMSS.sql`, în UTC: se sortează cronologic după nume. */
export function backupFileName(database: string, at: Date): string {
  const day = `${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}`;
  const time = `${two(at.getUTCHours())}${two(at.getUTCMinutes())}${two(at.getUTCSeconds())}`;
  return `${database}-${day}-${time}.sql`;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Copiile de șters ca să rămână cele mai noi `keep`; numai fișiere cu numele unei copii a acestei baze, niciodată altele. */
export function backupsToDelete(
  names: readonly string[],
  database: string,
  keep: number = KEEP_BACKUPS,
): string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new Error("se păstrează cel puțin o copie");
  const own = new RegExp(`^${escapeRegExp(database)}-\\d{8}-\\d{6}\\.sql$`);
  return names
    .filter((name) => own.test(name))
    .sort()
    .reverse()
    .slice(keep);
}
