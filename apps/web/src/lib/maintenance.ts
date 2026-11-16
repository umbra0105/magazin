/**
 * Modul de mentenanță al vitrinei: logica pură, folosită de middleware (Edge: fără baza de date, fără Redis). Când e pornit
 * (`maintenance.enabled`), vizitatorii vitrinei primesc pagina de mentenanță cu statusul 503 și `Retry-After` (motoarele de căutare
 * înțeleg că e temporar), iar adminul, API-ul, autentificarea și fișierele statice rămân accesibile, ca administratorul să poată
 * opri modul. Flagul se citește din aplicație (`/api/maintenance`) cu un cache scurt în memoria procesului; dacă citirea eșuează,
 * magazinul rămâne DESCHIS (o eroare de citire nu are voie să-l închidă).
 */
export const MAINTENANCE_PATH = "/mentenanta";
export const MAINTENANCE_CACHE_MS = 5_000;
export const MAINTENANCE_RETRY_AFTER_SECONDS = 3600;
export const MAINTENANCE_FLAG_PATH = "/api/maintenance";

const EXEMPT_SECTIONS = [
  "/admin",
  "/api",
  "/_next",
  "/media",
  "/storage",
  "/autentificare",
  "/recuperare-parola",
  "/resetare-parola",
  "/verificare-email",
];
const EXEMPT_FILES = [
  "/theme.css",
  "/theme-light.css",
  "/theme-dark.css",
  "/favicon.ico",
  "/robots.txt",
];

const inSection = (pathname: string, base: string): boolean =>
  pathname === base || pathname.startsWith(`${base}/`);

/** Calea rămâne accesibilă în mentenanță? Doar adminul, API-ul, autentificarea, fișierele statice, tema și media. */
export function isMaintenanceExempt(pathname: string): boolean {
  return (
    EXEMPT_FILES.includes(pathname) || EXEMPT_SECTIONS.some((base) => inSection(pathname, base))
  );
}

export interface MaintenanceProbeDeps {
  /** Citește flagul de la aplicație (de exemplu printr-un `fetch` către `${origin}/api/maintenance`). Poate arunca. */
  read: (origin: string) => Promise<boolean>;
  now: () => number;
}

/**
 * Citirea flagului cu cache scurt (`MAINTENANCE_CACHE_MS`) și o singură citire pentru cererile simultane. La eroare întoarce
 * `false` (magazin deschis) și NU memorează rezultatul, deci următoarea cerere încearcă din nou.
 */
export function createMaintenanceProbe(
  deps: MaintenanceProbeDeps,
): (origin: string) => Promise<boolean> {
  let cached: { value: boolean; at: number } | null = null;
  let inFlight: Promise<boolean> | null = null;
  return async (origin) => {
    if (cached && deps.now() - cached.at < MAINTENANCE_CACHE_MS) return cached.value;
    if (!inFlight) {
      inFlight = deps
        .read(origin)
        .then((value) => {
          cached = { value, at: deps.now() };
          return value;
        })
        .catch(() => false)
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
}
