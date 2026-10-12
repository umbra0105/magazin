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

| Comandă                                         | Ce face                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm dev`                                      | pornește aplicația (Next.js, port 3000)                                      |
| `pnpm build`                                    | build de producție                                                           |
| `pnpm lint`                                     | ESLint pe toate pachetele                                                    |
| `pnpm lint:root`                                | ESLint pe fișierele de config și pe `e2e/`                                   |
| `pnpm format`                                   | formatează cu Prettier (`format:check` doar verifică)                        |
| `pnpm typecheck`                                | TypeScript strict pe toate pachetele                                         |
| `pnpm test`                                     | teste unitare (Vitest)                                                       |
| `pnpm test:integration`                         | teste de integrare; cer serviciile Docker pornite                            |
| `pnpm test:e2e`                                 | teste end-to-end (Playwright); pornesc singure aplicația                     |
| `pnpm db:migrate`                               | aplică migrațiile pe baza de date locală                                     |
| `pnpm db:seed`                                  | seed de pachet: roluri, permisiuni, setări, flag-uri (idempotent)            |
| `pnpm db:seed:store`                            | seed specific magazinului (rulat doar de proprietar)                         |
| `pnpm dev:preset`                               | doar dev: aplică un preset de temă (`minimal`/`bold`/`editorial`, `--dark`)  |
| `pnpm admin:create`                             | creează contul Owner; interactiv, parola fără echo (rulează `db:seed` întâi) |
| `pnpm admin:unlock <email>`                     | deblochează un cont blocat după prea multe încercări de login                |
| `pnpm rbac:revoke <rol> <permisiune> [--apply]` | scoate explicit o permisiune dintr-un rol (simulare fără `--apply`)          |
| `pnpm admin:set-password <email>`               | schimbă parola unui cont (recuperare când emailul nu e configurat)           |
| `pnpm cli:tty-test`                             | verifică terminalul: tastele ajung la CLI și nu se afișează                  |

### Windows: dacă turbo e blocat

Pe unele instalări Windows, politica „Application Control” / Smart App Control blochează binarul
`turbo.exe` și comenzile `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm lint` cad cu
`spawn UNKNOWN` (iar Next.js poate avertiza că binarul SWC e blocat și trece singur pe wasm, mai
lent). **Nu e nevoie să schimbi setări de securitate**: aceleași comenzi există fără turbo.
CI-ul (Linux) folosește în continuare turbo.

| Comandă                               | Ce face                                                       |
| ------------------------------------- | ------------------------------------------------------------- |
| `pnpm dev:web`                        | pornește doar aplicația web (în loc de `pnpm dev`)            |
| `pnpm build:web`                      | build de producție al aplicației web (în loc de `pnpm build`) |
| `pnpm check:local`                    | typecheck + lint + lint:root + format:check + teste unitare   |
| `pnpm -r typecheck` / `pnpm -r lint`  | typecheck / lint pe toate pachetele, fără turbo               |
| `pnpm test` / `pnpm test:integration` | testele rulează cu Vitest direct, nu au nevoie de turbo       |

Dacă `pnpm dev:web` pornește, ai tot ce-ți trebuie pentru lucru local. Comenzile CLI cu parolă
(`admin:create` etc.) nu folosesc turbo.

### Comenzile cu parolă (`admin:create`, `admin:set-password`)

- Se rulează **de către om, într-un terminal interactiv**, de la rădăcina proiectului. Parola se
  tastează de două ori, **fără echo**, și nu poate fi dată prin argumente, variabile de mediu, pipe
  sau fișier. Nu există parolă implicită nicăieri.
- `admin:set-password <email>` schimbă parola unui cont existent, **închide toate sesiunile lui**
  (și din cache-ul Redis), resetează blocarea de login și scrie în jurnalul de audit „schimbare din
  CLI” (fără parolă și fără hash). Este pentru **recuperare când emailul nu e configurat** (nu merge
  „am uitat parola”); când emailul funcționează, folosește fluxul normal de resetare.
- Comenzile rulează direct cu `node --import tsx …`, nu prin `pnpm --filter`: runner-ul recursiv
  pnpm pierdea tastele pe Windows. Dacă adaugi o comandă interactivă nouă, păstrează aceeași formă
  (un test o impune).

**Test manual pe Windows (PowerShell)**, de la rădăcina proiectului:

1. `pnpm cli:tty-test` → tastează 5 caractere (de ex. `abcde`) și Enter. Nu trebuie să apară nimic
   în timp ce tastezi (nici `*`); la final trebuie să vezi „Am primit 5 caractere” și „OK”.
2. `pnpm admin:set-password email-inexistent@example.com` → „Nu există niciun utilizator…”
   (nu cere parola și nu modifică nimic).
3. `echo test | pnpm admin:create` → refuză: „Comanda cere un terminal interactiv”.
4. `pnpm admin:create` (sau `pnpm admin:set-password <email>`) → tastează parola (minim 12
   caractere), apoi o repetare diferită: trebuie să vezi „Parolele nu coincid”; Ctrl+C anulează fără
   să modifice nimic.

### Testele de integrare au baza lor

`pnpm test:integration` **nu atinge datele de dezvoltare** (seed, setări, comenzi de test). Rulează pe:

- o bază Postgres separată în același server, `<nume>_test` (implicit `ecom_test`), **creată și migrată automat**
  la prima rulare și la fiecare rulare ulterioară (`prisma migrate deploy`);
- Redis DB `1` (dezvoltarea folosește DB `0`).

Poți indica alte baze cu `TEST_DATABASE_URL` și `TEST_REDIS_URL` (vezi `.env.example`). **Gardă:** testele
refuză să pornească dacă numele bazei nu conține „test” sau dacă Redis e pe DB `0`, deci nu pot șterge din
neatenție date reale. Fișierele de integrare rulează pe rând (o singură bază partajată). Ca să resetezi
baza de test: `docker exec ecom-dev-postgres-1 psql -U ecom -d postgres -c "DROP DATABASE ecom_test"`
(se recreează la următoarea rulare). Pe CI se folosește aceeași schemă de nume (`ecom_test`, Redis DB `1`).

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
