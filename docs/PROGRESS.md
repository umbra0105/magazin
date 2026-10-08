# Jurnal de progres

## 2026-10-08 · Sesiunea 1 · Faza 1 (Fundație)
**Terminat (confirmat de utilizator):** punctele 1-11 din 11 (Faza 1 completă, verificată cap-coadă de utilizator)
**În lucru:** —
**Blocat:** —
**Stare fază:** 🏁 Faza 1 TERMINATĂ și confirmată. Conectarea la GitHub: se face împreună cu utilizatorul, cu un ghid separat, după ultimul commit al fazei

**Ce funcționează acum:**
- Monorepo pnpm + Turborepo, git inițializat (ramura `main`), 9 pachete-schelet în `packages/`
- `apps/web`: Next.js 15 cu rutele `(storefront)`, `(admin)/admin`, `api`; `pnpm dev` și `pnpm build` merg
- Tailwind v4 cu CSS variables neutre, shadcn/ui inițializat (fără componente)

**Decizii luate în sesiune:**
- **Sentry → Faza 2 (decizie EXPLICITĂ a utilizatorului, opțiunea B).** Punct separat la începutul Fazei 2 în `06-todo-master.md`, cu DSN din tabela `Setting` (editabil din admin), nu din `.env`, ca să nu se facă munca de două ori. Istoric: inițial am amânat Sentry din inițiativa mea, fără o alegere explicită a utilizatorului, iar jurnalul a fost corectat; apoi utilizatorul a ales explicit B.
- **Regulă de lucru (utilizator):** când e nevoie de o decizie → 🛑 STOP și așteptare de răspuns explicit la întrebarea respectivă. Un „ok" general la plan NU înseamnă acceptarea valorilor implicite propuse. Orice decizie luată de Claude se notează aici ca atare.
- Dependențe aprobate de utilizator pentru punctul 8: `pg` și `ioredis`
- **CI (punctul 9) — decizie EXPLICITĂ a utilizatorului, opțiunea A:** workflow-ul GitHub Actions include servicii Postgres și Redis și un test de integrare pentru `/api/health`
- `/api/health`: răspunsul public are doar starea și latența, erorile tehnice merg în loguri; `.env` din rădăcină se încarcă din `next.config.ts` cu `process.loadEnvFile` (Next îl caută doar în `apps/web`)
- ESLint/Next: regulile Next.js erau active, dar avertismentul „Next.js plugin was not detected" apărea fiindcă detectorul Next caută în `apps/web`. Regulile au fost mutate în `apps/web/eslint.config.mjs` (extinde configul din rădăcină); avertismentul a dispărut
- Logger Pino: `requestId` prin `AsyncLocalStorage`; partea sigură pentru Edge (`resolveRequestId`) e în fișier separat, importat din `@ecom/shared/request-id`
- Playwright: browserul descărcat de mine nu a ajuns pe mașina utilizatorului, care a rulat el `playwright install chromium`; pasul e în README
- `pnpm-workspace.yaml`: `allowBuilds: unrs-resolver: false` (pnpm 12 blochează scriptul de build al acestei dependențe; binarele native vin prebuilt)
- `output: "standalone"` doar când `NEXT_OUTPUT=standalone` (Dockerfile, Faza 23): pe Windows eșuează cu EPERM la symlink
- MinIO în dev: `cgr.dev/chainguard/minio` (`minio/minio` a dispărut de pe Docker Hub, quay.io dă 401). Chainguard publică gratuit doar `latest`, deci imaginea e fixată prin DIGEST (`RELEASE.2026-09-22T19-25-18Z`)
- **Storage-ul de producție se decide la Faza 3 (Media).** Aplicația vorbește S3 generic (endpoint, regiune, bucket, chei din `.env`, path-style configurabil), fără cod specific MinIO, ca furnizorul să se schimbe fără modificări în cod. Candidați: Cloudflare R2, alt S3 gestionat, MinIO self-hosted
- `AGENTS.md` este generat de `turbo` (vezi „Rezolvat după verificarea finală")

**Ce a rămas deschis din Faza 1:**
- **Sentry** → primul punct din Faza 2 (decizia utilizatorului). Fără el, "Logger Pino + Sentry" din Promptul 1 e acoperit doar pe jumătate de logger
- **GitHub / CI:** workflow-ul nu a rulat niciodată pe GitHub (nu există remote). Se conectează la finalul fazei (decizia utilizatorului). La primul run pot apărea probleme cu `pnpm/action-setup@v4` + pnpm 12 sau cu instalarea Playwright
- **E2E subțire:** un singur test (homepage). `/api/health` e acoperit de testul de integrare, nu de E2E

**Rezolvat după verificarea finală (la cererea utilizatorului):**
- Imagini Docker fixate pe versiune exactă + digest: `postgres:16.15`, `redis:7.4.11`, `axllent/mailpit:v1.31.4`, MinIO (digest). CI folosește aceleași versiuni (`postgres:16.15`, `redis:7.4.11`)
- `.gitattributes` adăugat (LF în repo, `.sh` mereu LF, `.bat`/`.ps1` CRLF). Repo-ul era deja în LF, deci fără modificări în fișierele existente
- `AGENTS.md` PĂSTRAT (decizie Claude, comunicată utilizatorului): nu dublează `CLAUDE.md`. Este un bloc gestionat de `turbo`, cu instrucțiuni despre citirea documentației versiunii instalate de Turborepo. Turbo îl re-adaugă la fiecare invocare detectată ca agent AI, deci ștergerea ar crea modificări necomise recurente. Dezactivare posibilă cu `"agentGuidance": false` în `turbo.json` — doar la cererea utilizatorului

**Datorie tehnică (pentru fazele următoare):**
- Culorile implicite din `globals.css` sunt fallback; în Faza 2 vin din `Branding`
- `/api/health` nu are rate limiting (vine în Faza 2)
- Docs/07 (secțiunea CLAUDE.md) e învechită (zice „multi-tenant"); `CLAUDE.md` din rădăcină e cel corect
- Prompturile din docs/07 mai amintesc „tenant" (ex. Promptul 4); de ignorat, regula e fără `tenantId`
- README verificat pe o clonă curată (install → lint → typecheck → teste → build)

**De unde reiau:** Faza 2 — Bază de date, setări, autentificare (SESIUNE NOUĂ, Promptul 2). Primul punct: Sentry cu DSN din `Setting`, după Service de setări
**Comandă de pornire:** `docker compose -f docker/docker-compose.dev.yml up -d && pnpm dev`
