# Platformă eCommerce white-label

Pachet instalabil de eCommerce în Next.js: o instalare = un magazin. Branding, conținut și
integrări se configurează din panoul de administrare, nu din cod. Piața țintă: România.

Specificațiile proiectului sunt în [`docs/`](docs/README.md). Regulile de lucru sunt în
[`CLAUDE.md`](CLAUDE.md), iar protocolul de raportare în
[`docs/13-protocol-de-lucru.md`](docs/13-protocol-de-lucru.md).

## Cerințe

| Unealtă        | Versiune                                       |
| -------------- | ---------------------------------------------- |
| Node.js        | 24 LTS (`.nvmrc`)                              |
| pnpm           | 12 (versiunea exactă e în `package.json`)      |
| Docker Desktop | pentru Postgres, Redis, MinIO și Mailpit local |
| Git            | orice versiune recentă                         |

## Pornire locală de la zero

```bash
# 1. Dependențe (instalează și hook-urile Git prin Husky)
pnpm install

# 2. Configurare: copiază exemplul și, dacă e nevoie, ajustează valorile
cp .env.example .env            # în PowerShell: Copy-Item .env.example .env

# 3. Servicii locale: Postgres, Redis, MinIO, Mailpit
docker compose -f docker/docker-compose.dev.yml up -d

# 4. Browserul pentru testele E2E (o singură dată pe fiecare calculator)
pnpm exec playwright install chromium

# 5. Aplicația
pnpm dev
```

Verifică:

- Magazinul: <http://localhost:3000>
- Administrare: <http://localhost:3000/admin>
- Starea serviciilor: <http://localhost:3000/api/health> (200 dacă Postgres și Redis răspund)
- Emailuri prinse local (Mailpit): <http://localhost:8025>
- Consola MinIO: <http://localhost:9001>

Pasul 4 e necesar doar pentru `pnpm test:e2e`. Fără el, restul funcționează.
Toate valorile din `.env.example` sunt pentru dezvoltare locală, inclusiv `APP_KEY`.
Pentru producție generezi propriile secrete (`openssl rand -base64 32`).

> ⚠️ **`APP_KEY` — păstreaz-o separat și în siguranță.** Din ea se derivă cheia care criptează
> credențialele integrărilor (plăți, curieri, facturare) salvate în baza de date. **Dacă pierzi
> sau schimbi `APP_KEY`, toate credențialele salvate devin ilizibile** și trebuie reintroduse
> manual din admin. Fă-i backup într-un loc separat de backup-ul bazei de date (un manager de
> parole sau un seif), nu o pune în repo și nu o trimite pe email sau chat. Pe mașina de
> producție, `APP_KEY` din `.env` trebuie să rămână aceeași la fiecare repornire și actualizare.

## Comenzi

| Comandă                 | Ce face                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `pnpm dev`              | pornește aplicația (Next.js, port 3000)                                     |
| `pnpm build`            | build de producție                                                          |
| `pnpm lint`             | ESLint pe toate pachetele                                                   |
| `pnpm lint:root`        | ESLint pe fișierele de config și pe `e2e/`                                  |
| `pnpm format`           | formatează cu Prettier (`format:check` doar verifică)                       |
| `pnpm typecheck`        | TypeScript strict pe toate pachetele                                        |
| `pnpm test`             | teste unitare (Vitest)                                                      |
| `pnpm test:integration` | teste de integrare; cer serviciile Docker pornite                           |
| `pnpm test:e2e`         | teste end-to-end (Playwright); pornesc singure aplicația                    |
| `pnpm db:migrate`       | aplică migrațiile pe baza de date locală                                    |
| `pnpm db:seed`          | seed de pachet: roluri, permisiuni, setări, flag-uri (idempotent)           |
| `pnpm db:seed:store`    | seed specific magazinului (rulat doar de proprietar)                        |
| `pnpm dev:preset`       | doar dev: aplică un preset de temă (`minimal`/`bold`/`editorial`, `--dark`) |

> `pnpm test:integration` șterge din baza locală setările, flag-urile și brandingul (testele își pregătesc
> singure datele). După ele rulează din nou `pnpm db:seed` (e idempotent) ca să le recapeți.

Serviciile Docker:

```bash
docker compose -f docker/docker-compose.dev.yml up -d      # pornește
docker compose -f docker/docker-compose.dev.yml ps         # starea (toate trebuie "healthy")
docker compose -f docker/docker-compose.dev.yml down       # oprește (datele rămân în volume)
docker compose -f docker/docker-compose.dev.yml down -v    # oprește ȘI șterge datele
```

## Structura

```
apps/web            aplicația Next.js: (storefront), (admin), api
packages/config     schema de env (Zod), versiunea pachetului
packages/core       logica de business, fără React (deocamdată: health)
packages/shared     logger Pino, requestId, tipuri și utilitare
packages/db         schema Prisma, migrații, seed (Faza 2)
packages/ui         design system
packages/integrations  adaptoare externe: plăți, curieri, facturare
packages/jobs       workers BullMQ
packages/emails     șabloane React Email
packages/extensions registry de hook-uri pentru personalizări
docker/             compose pentru dezvoltare locală
e2e/                teste Playwright
docs/               specificațiile proiectului
```

## Reguli esențiale

Detaliile complete sunt în `CLAUDE.md`. Pe scurt:

- **Nimic hardcodat:** numele magazinului, culorile, datele firmei, TVA, textele legale vin din
  baza de date. `.env` conține doar secrete și conexiuni.
- **Bani:** `int` în bani (`1999` = 19,99 lei), niciodată `float`.
- **Logica de business** stă în `packages/core`, nu în componente React.
- **Commit-uri:** conventional commits, în română (`feat(catalog): …`). Hook-urile Husky rulează
  lint-staged la commit și commitlint la mesaj; un commit cu mesaj greșit e respins.

## Integrare continuă

`.github/workflows/ci.yml` rulează la push pe `main` și la pull request: lint, format, typecheck,
teste unitare, teste de integrare (cu Postgres și Redis ca servicii), build și E2E.
Aceiași pași îi poți rula local, în aceeași ordine, cu comenzile de mai sus.

## Probleme frecvente

**`EnvValidationError` la pornire.** Lipsește sau e greșită o variabilă din `.env`. Mesajul
listează fiecare variabilă problematică. Pornește de la `.env.example`.

**`/api/health` întoarce 503.** Un serviciu nu răspunde. Verifică
`docker compose -f docker/docker-compose.dev.yml ps`. Detaliul tehnic apare în logurile
serverului (nu în răspuns), împreună cu `requestId`.

**Playwright: `Executable doesn't exist`.** Nu ai rulat pasul 4 (`pnpm exec playwright install chromium`).

**Windows: `EPERM … symlink` la build.** Build-ul `standalone` cere drepturi de symlink. Este
activat doar când `NEXT_OUTPUT=standalone` (build-ul Docker), deci `pnpm build` obișnuit nu e afectat.

**pnpm: `Ignored build scripts`.** pnpm 12 blochează scripturile de build ale dependențelor.
Cele respinse intenționat sunt listate în `pnpm-workspace.yaml`, la `allowBuilds`.

**Port ocupat (5432, 6379, 9000, 9001, 1025, 8025).** Alt serviciu local folosește portul.
Oprește-l sau schimbă maparea în `docker/docker-compose.dev.yml` și valorile din `.env`.

**Imaginea MinIO.** Compose-ul folosește `cgr.dev/chainguard/minio`, fixată prin digest, pentru că
`minio/minio` nu mai este pe Docker Hub. Aplicația vorbește S3 generic, deci furnizorul de storage
de producție se alege în Faza 3 fără modificări de cod.
