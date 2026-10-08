# Jurnal de progres

## 2026-10-08 · Sesiunea 1 · Faza 1 (Fundație)
**Terminat (confirmat de utilizator):** punctele 1-6 din 11 (monorepo; Next.js + Tailwind + shadcn/ui; docker compose dev; schema de env; ESLint/Prettier/Husky/commitlint; Vitest + Playwright)
**În lucru:** punctul 7 — logger Pino cu requestId (făcut și comis, așteaptă confirmarea utilizatorului)
**Blocat:** — (de decis: Sentry, vezi mai jos)

**Ce funcționează acum:**
- Monorepo pnpm + Turborepo, git inițializat (ramura `main`), 9 pachete-schelet în `packages/`
- `apps/web`: Next.js 15 cu rutele `(storefront)`, `(admin)/admin`, `api`; `pnpm dev` și `pnpm build` merg
- Tailwind v4 cu CSS variables neutre, shadcn/ui inițializat (fără componente)

**Abateri de la plan, neaprobate de utilizator:**
- ⚠️ **Sentry amânat** (Promptul 1 îl include). A fost recomandarea mea (dependență grea, nu are încă ce monitoriza), nu o decizie a utilizatorului. În planul inițial am întrebat „acum sau amânat?" și am scris că, la „ok", iau implicit „amânat". Răspunsul „ok" nu a fost o alegere explicită pe Sentry. Rămâne deschis: ori punct nou, mic, în Faza 1, ori mutat explicit în Faza 2. Până la decizie, punctul „Logger Pino + Sentry opțional" din TODO NU se bifează complet.

**Decizii luate în sesiune:**
- Playwright: browserul se descarcă la punctul 6. Descărcarea mea nu a ajuns pe mașina utilizatorului, care a rulat el `playwright install chromium`; pasul intră în README (punctul 10)
- `pnpm-workspace.yaml`: `allowBuilds: unrs-resolver: false` (pnpm 12 blochează scriptul de build al acestei dependențe; binarele native vin prebuilt)
- `output: "standalone"` doar când `NEXT_OUTPUT=standalone` (Dockerfile, Faza 23): pe Windows eșuează cu EPERM la symlink
- MinIO în dev: `cgr.dev/chainguard/minio` (`minio/minio` a dispărut de pe Docker Hub, quay.io dă 401). Chainguard publică gratuit doar `latest`, deci imaginea e fixată prin DIGEST (`RELEASE.2026-09-22T19-25-18Z`)
- **Storage-ul de producție se decide la Faza 3 (Media).** Aplicația vorbește S3 generic (endpoint, regiune, bucket, chei din `.env`, path-style configurabil), fără cod specific MinIO, ca furnizorul să se schimbe fără modificări în cod. Candidați: Cloudflare R2, alt S3 gestionat, MinIO self-hosted
- `pnpm install` a generat `AGENTS.md` (din pachetul turbo); păstrat în repo, nu e folosit de proiect

**Datorie tehnică:**
- Culorile implicite din `globals.css` sunt fallback; în Faza 2 vin din `Branding`
- Docs/07 (secțiunea CLAUDE.md) e învechită (zice „multi-tenant"); `CLAUDE.md` din rădăcină e cel corect
- Prompturile din docs/07 mai amintesc „tenant" (ex. Promptul 4); de ignorat, regula e fără `tenantId`

**De unde reiau:** decizia despre Sentry, apoi punctul 8 din Faza 1 — `/api/health` (cere `pg` + `ioredis`, aprobare pendinte)
**Comandă de pornire:** `docker compose -f docker/docker-compose.dev.yml up -d && pnpm dev`
