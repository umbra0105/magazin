# Jurnal de progres

## 2026-10-08 · Sesiunea 1 · Faza 1 (Fundație)
**Terminat:** punctele 1-3 din 11 (monorepo; Next.js + Tailwind + shadcn/ui; docker compose dev)
**În lucru:** punctul 4 — packages/config (schema de env Zod)
**Blocat:** —

**Ce funcționează acum:**
- Monorepo pnpm + Turborepo, git inițializat (ramura `main`), 9 pachete-schelet în `packages/`
- `apps/web`: Next.js 15 cu rutele `(storefront)`, `(admin)/admin`, `api`; `pnpm dev` și `pnpm build` merg
- Tailwind v4 cu CSS variables neutre, shadcn/ui inițializat (fără componente)

**Decizii luate în sesiune:**
- Sentry amânat până în Faza 2 (greu, nu are încă ce monitoriza)
- Playwright: se descarcă browserul la punctul 6
- `output: "standalone"` doar când `NEXT_OUTPUT=standalone` (Dockerfile, Faza 23): pe Windows eșuează cu EPERM la symlink
- MinIO în dev: `cgr.dev/chainguard/minio` (`minio/minio` a dispărut de pe Docker Hub, quay.io dă 401). Chainguard publică gratuit doar `latest`, deci imaginea e fixată prin DIGEST (`RELEASE.2026-09-22T19-25-18Z`)
- **Storage-ul de producție se decide la Faza 3 (Media).** Aplicația vorbește S3 generic (endpoint, regiune, bucket, chei din `.env`, path-style configurabil), fără cod specific MinIO, ca furnizorul să se schimbe fără modificări în cod. Candidați: Cloudflare R2, alt S3 gestionat, MinIO self-hosted
- `pnpm install` a generat `AGENTS.md` (din pachetul turbo); păstrat în repo, nu e folosit de proiect

**Datorie tehnică:**
- Culorile implicite din `globals.css` sunt fallback; în Faza 2 vin din `Branding`
- Docs/07 (secțiunea CLAUDE.md) e învechită (zice „multi-tenant"); `CLAUDE.md` din rădăcină e cel corect
- Prompturile din docs/07 mai amintesc „tenant" (ex. Promptul 4); de ignorat, regula e fără `tenantId`

**De unde reiau:** punctul 4 din Faza 1 — `packages/config` (schema de env Zod)
**Comandă de pornire:** `docker compose -f docker/docker-compose.dev.yml up -d && pnpm dev`
