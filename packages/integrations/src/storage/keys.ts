import { StorageError, type Visibility } from "./types";

const MAX_KEY_LENGTH = 512;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Rezervat pentru fișierul cu metadate al driverului local. */
const RESERVED_SUFFIX = ".meta.json";
/** Nume de dispozitiv Windows (CON, NUL, COM1…): nu pot fi fișiere pe discul local al dezvoltării. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Validează o cheie de obiect și întoarce vizibilitatea ei. Cheile sunt generate de aplicație
 * (uuid + extensie), dar le validăm oricum: sunt singura apărare împotriva path traversal pe
 * driverul local și împotriva scrierii în afara spațiilor `public/` și `private/`.
 */
export function visibilityOf(key: string): Visibility {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw invalid("lungime nepermisă");
  }
  const segments = key.split("/");
  if (segments.length < 2) throw invalid("cheia trebuie să aibă cel puțin două segmente");
  for (const segment of segments) {
    // Segmentele goale (`//`, slash final/inițial), `.` și `..` sunt respinse de regex-ul de mai
    // jos: primul caracter trebuie să fie alfanumeric. La fel `\`, NUL, `%`, spații.
    if (!SEGMENT.test(segment)) throw invalid("segment nepermis");
    if (segment.endsWith(".") || WINDOWS_RESERVED.test(segment)) throw invalid("segment nepermis");
  }
  if (key.toLowerCase().endsWith(RESERVED_SUFFIX)) throw invalid("sufix rezervat");
  const first = segments[0];
  if (first !== "public" && first !== "private") {
    throw invalid("cheia trebuie să înceapă cu public/ sau private/");
  }
  return first;
}

/**
 * Validează un prefix de listare: ca o cheie, dar terminat cu `/` și cu cel puțin un segment după
 * `public/` sau `private/` (nu se poate lista rădăcina unui spațiu întreg printr-o greșeală).
 */
export function assertValidPrefix(prefix: string): void {
  if (typeof prefix !== "string" || !prefix.endsWith("/")) throw invalid("prefix fără slash final");
  visibilityOf(`${prefix}x`);
  if (prefix.split("/").filter(Boolean).length < 2) throw invalid("prefix prea larg");
}

export function assertValidKey(key: string): void {
  visibilityOf(key);
}

export function isPublicKey(key: string): boolean {
  return visibilityOf(key) === "public";
}

/** Construiește o cheie din segmente; validarea rămâne la `visibilityOf`. */
export function buildKey(visibility: Visibility, ...segments: string[]): string {
  const key = [visibility, ...segments].join("/");
  visibilityOf(key);
  return key;
}

function invalid(reason: string): StorageError {
  // Cheia NU intră în mesaj: poate veni din date nesigure.
  return new StorageError("STORAGE_INVALID_KEY", `Cheie de storage invalidă: ${reason}`);
}
