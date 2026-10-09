# Jurnal de progres

## 2026-10-09 · Sesiunea 2 · Faza 2, partea din Promptul 2 (configurare, setări, criptare, flag-uri, audit, temă, seed)
**Terminat (confirmat de utilizator):** punctele 1-9 și 8b din planul Promptului 2 (schema, SettingsService, setări fiscale/regionale, criptare, flag-uri, audit, tokens de temă, seed, baza de test separată, Sentry) + schimbarea mapării Manager
**În lucru:** punctul 10 (teste rămase) și fix-ul A (tokenii vizibili în pagina principală): făcute, așteaptă verificarea utilizatorului
**Blocat:** —
**Stare:** partea din **Promptul 2** a Fazei 2 e terminată. **Faza 2 din TODO NU e completă**: rămân auth, rate limiting, RBAC `can()`, layout admin și contul de administrator (**Promptul 3**). Atenție la numerotare: „Faza 3” din TODO este Media (Promptul 4), nu autentificarea.

**Ce funcționează acum:**
- Schema Prisma 7 (13 tabele, tabelele Better Auth generate cu `auth generate`), 2 migrații, `getDb()` din `@ecom/db`
- `SettingsService` (registru Zod, 31 de chei, cache Redis 5 min, fallback pe DB), `FeatureFlagService` (6 flag-uri, toate oprite implicit, `requireFeature`/`loadFeature` în `apps/web/src/lib/features.ts`), `BrandingService` (3 presets, validare strictă, contrast WCAG AA, `/theme.css` cu ETag)
- Criptare AES-256-GCM `v1:` cu cheie derivată HKDF din `APP_KEY`; `IntegrationService` (credențiale mascate în afișare)
- `auditLog` doar de adăugare (trigger Postgres) cu mascarea secretelor și `withAudit` pentru server actions (încă nelegat la scrieri)
- Sentry activ doar cu DSN din `Setting` (`monitoring.sentryDsn`), complet inactiv altfel
- Seed idempotent (`pnpm db:seed`), seed specific magazinului (`pnpm db:seed:store`), utilitar de dezvoltare `pnpm dev:preset`
- Testele de integrare rulează pe `ecom_test` și Redis DB 1, create/migrate automat, cu gardă

**Decizii luate în sesiune:**
- **Utilizator:** Manager primește și `products.cost.view` (văd prețul de achiziție: Owner, Admin, Manager, Contabil; `products.cost.edit`: doar Owner și Admin). Restul mapării rol → permisiuni din `packages/core/src/rbac/catalog.ts` este **interpretarea lui Claude** a tabelului din `docs/04` §6 (de ex. Contabil primește `products.cost.view`; Suportul nu are încă limită de rambursare)
- **Utilizator:** bază de test separată `ecom_test` + Redis DB 1, creată/migrată automat, cu gardă („test” în numele bazei, Redis DB ≠ 0), aceeași schemă de nume în CI. Fișierele de integrare rulează **pe rând** (`fileParallelism: false`): cu o singură bază partajată, testele care golesc sau numără aceleași tabele (setting, feature_flag, branding) se călcau între ele; testul seed-ului a picat intermitent (1 din 3 rulări) înainte de această setare
- **Utilizator:** Sentry cu DSN din `Setting` (nu din `.env`), executat după SettingsService; DSN-ul ajunge în browser printr-o rută API (`/api/monitoring/config`), ca layout-ul să nu citească DB-ul
- Prisma **7.10.0** (stabil); tag-ul `latest` al CLI-ului era 8.0.0-rc.21 (release candidate), deci versiunea e fixată explicit. Config-ul se numește `prisma.config.ts` (nume standard; `prisma init` din 7.10 generează `prisma7.config.ts`, redenumit la cererea utilizatorului)
- Better Auth 1.7.7: tabelele `user`, `session`, `account`, `verification` sunt generate cu `auth generate` (nu rescrise în Promptul 3). `User` nu are câmpuri extra deocamdată
- `audit_log`: fără FK către `User` (ar fi un `ON DELETE SET NULL` = UPDATE) și cu `actorLabel` (emailul la momentul acțiunii). Triggere Postgres resping UPDATE/DELETE/TRUNCATE
- Tema se servește de la `/theme.css` (link render-blocking în `<head>`, ETag, `no-cache`), nu din layout, ca paginile să rămână statice. `customCss` din `Branding` NU se injectează încă (CSS liber; propriul sanitizer în Faza 6). Fonturile (6 familii) sunt `next/font/google`: descărcate la build, servite local, zero cereri externe în browser
- Fără `ioredis-mock`: cere `ioredis ^5`, proiectul are `ioredis 6`; testele folosesc un cache fals simplu și Redis real
- Seed-ul de pachet stă în `@ecom/core` (are registrul), apelat de `prisma db seed`. Nu creează utilizatori și nu conține parole; testul de arhitectură o garantează. Seed-ul **adaugă** permisiuni lipsă pe rolurile existente și nu scoate niciodată pe cele acordate
- Pagina principală (placeholder) citește `general.storeName` din setări și arată tokenii temei; devine dinamică până la vitrină (Fazele 6-7)
- Maparea rolurilor pe baza de dezvoltare: noua legătură Manager → `products.cost.view` **nu a fost aplicată** în baza locală; se aplică cu `pnpm db:seed` (adaugă doar legătura lipsă)

**Incidente în sesiune (raportate, corectate):**
- Două fișiere de test nou create au fost numite greșit (`*.integration.more.test.ts`) și au rulat, o dată, în proiectul unitar pe baza de dezvoltare; unul a șters cele 6 flag-uri din `feature_flag`. Redenumite corect, flag-urile reinserate (toate `false`)
- `git push` făcut o dată fără să fi fost cerut (toate commit-urile până la `339139c`); de atunci doar commit-uri locale. **Commit-urile de după `339139c` NU sunt pe GitHub**

**Rezultatul exact al testelor (la finalul sesiunii):**
- Unitare: **172 trec** (25 fișiere) · Integrare: **30 trec** (12 fișiere, rulate de 4 ori la rând, stabile) · E2E: **1 trece** (homepage)
- `pnpm typecheck` ✅ (10/10) · `pnpm lint` ✅ (10/10) · `pnpm lint:root` ✅ · `pnpm format:check` ✅ · `pnpm build` ✅

**Datorie tehnică:**
- **CI-ul de pe GitHub nu a rulat încă cu schema nouă (4 migrații cu triggere) și cu baza de test `ecom_test`**; se verifică după primul push. Posibile probleme: utilizatorul `ecom` din serviciul Postgres trebuie să poată crea baze (e superuser acolo), `pnpm exec prisma migrate deploy` din `globalSetup`, descărcarea fonturilor la `next build`
- `packages/core/scripts/dev-apply-preset.ts` și `seed-store.ts` **se mută înainte de împachetare (Faza 21)**: nu fac parte din pachetul distribuit
- Runbook Faza 21: aplicația rulează cu un utilizator de DB **fără** drept de UPDATE/DELETE/TRUNCATE pe `audit_log` (triggerul nu oprește owner-ul/superuserul)
- `withAudit` nu e încă legat la `SettingsService.set`, `FeatureFlagService.setEnabled`, `BrandingService.save`, `IntegrationService.save` (nu există server actions de admin și nici sesiune până în Promptul 3)
- Meniul de admin care ascunde funcțiile cu flag oprit nu există încă (Promptul 3); `FeatureFlagService.list()` e gata pentru el
- `requireFeature` face ruta dinamică; paginile din cache trebuie invalidate la schimbarea unui flag (notat la Fazele 7 și 16)
- Grupurile de clienți (inclusiv „Client standard”) nu pot fi create: tabela vine în Faza 15; cele 5 grupuri ale magazinului se adaugă atunci în `seed-store.ts`
- Middleware-ul (edge) nu e monitorizat de Sentry (nu are acces la DB/DSN)
- `Setări > Aspect`: lista de 6 fonturi e fixă (declarate la build); un font nou cere modificare de cod
- Rândul manual `x` din `audit_log` creat la verificare nu mai există în baza locală (baza a fost probabil recreată între sesiuni)

**Întrebări deschise (contabil/avocat), rămân în `docs/10-decizii-deschise.md`:**
- Voucher cadou: plată anticipată (metodă de plată) vs. cod de reducere gratuit; termenul legal minim de valabilitate (Faza 15b)
- Puncte de loialitate: TVA pe 100 sau pe 90? (Faza 15b)
- Produs digital în comandă mixtă cu ramburs: eliberare la livrare confirmată sau la virament (Faza 14b)
- GDPR vs. `audit_log` doar de adăugare: `actorLabel` conține emailul unei persoane și jurnalul nu se poate șterge (avocat, înainte de lansare; `docs/10` Partea II #11)

**De unde reiau:** Faza 2, **Promptul 3** (autentificare, rate limiting, RBAC `can()`/`withPermission()`, layout admin, contul de administrator fără parolă implicită), într-o SESIUNE NOUĂ. Nu începe Promptul 4 (Media) înainte de Promptul 3.
**Comandă de pornire:** `docker compose -f docker/docker-compose.dev.yml up -d && pnpm db:seed && pnpm dev`

## 2026-10-08 · Sesiunea 1 (continuare) · Documentație: model de prețuri, SmartBill, răspunsuri contabil
**Tip:** doar documentație (`docs/` și `CLAUDE.md`), fără cod. Faza 2 NU a început.
**Commit:** `docs: model de prețuri cost+adaos, SmartBill, răspunsuri contabil`

**Decizii EXPLICITE ale utilizatorului:**
- **Trei tipuri de grup** (`pricingType`): `none` (Client standard), `discount` (Client fidel 5%, Client VIP 7%), `cost_plus` (Partener 1/2/3 cu adaos 12% / 17% / 21% peste prețul de achiziție NIR). Toate procentele sunt editabile din admin; atribuirea în grup rămâne manuală; fără prețuri pe categorie/produs per grup acum
- Formula `cost_plus`: `pret_brut = costNet × (1 + adaos) × (1 + TVA)`, `costNet` = NIR fără TVA, TVA din setări (21%); rotunjire pe linie, o singură dată
- **Plafon:** Partenerul plătește MINIMUL dintre prețul lui și prețul public curent (inclusiv promoția). Produs fără preț NIR → preț public + avertisment în admin
- `costPrice` (int, bani, fără TVA) și `costPriceDate` pe variantă, cu istoric (`CostPriceHistory`). **Doar admin**: niciodată în API public, storefront, feed-uri, snapshot de comandă sau loguri. Câmpurile intră în schema din Faza 4
- Prețul de achiziție = **cel mai recent preț de intrare**. Import săptămânal dintr-un export SmartBill, în **Faza 15** (potrivire pe SKU, data cea mai recentă, actualizare doar dacă data e mai nouă, raport cu coduri necunoscute). **Format exact: se așteaptă un fișier exemplu de la utilizator înainte de Faza 15**
- Rămân neschimbate: discountul de grup nu se cumulează cu promoția (se ia prețul cel mai mic); cuponul se cumulează, exceptând `notForDiscountedGroups`; punctele le acumulează Standard, Fidel și VIP, NU Partenerii; discountul Fidel/VIP se cumulează cu punctele
- **TVA: o singură cotă, 21%**, pentru toate produsele (și digitale), din setări (implicit 21). Setarea intră în Faza 2
- **Vânzare DOAR în România**, pentru orice produs (nu doar digitale)
- **Ramburs:** limită 10.000 lei persoane fizice, 5.000 lei persoane juridice, configurabile în setări; peste limită metoda se ascunde
- **Reguli de facturare de la contabil:** card = la plasare/plata confirmată · transfer bancar = proformă, apoi factură după confirmarea plății de către admin · ramburs = la plasare, cu storno dacă se întoarce · retur parțial = storno parțial · seria/numărul le definește SmartBill · e-Factura o transmite SmartBill automat · la ramburs, plata e încasată când curierul virează banii (reconciliere în admin)
- **Puncte și comanda de 0 lei (corecție a utilizatorului):** FĂRĂ plafon procentual la puncte (configurabil din admin, dacă vrea mai târziu). **Valoarea de 30% din Promptul 21f NU era o decizie a utilizatorului** și a fost scoasă. Regula dură: suma de plătit în bani trebuie să acopere cel puțin costul transportului; la comenzi fără transport (ridicare personală, doar digital) se aplică un minim configurabil, implicit 1 leu. Comanda de 0 lei dispare; ramura `loyalty_points` se scoate. Aliniate: `10`, `14`, Promptul 21f, `CLAUDE.md`, `06`
- Răspunsurile 1-4 și 6-10 la lista de întrebări: `excludeFromGroupDiscount` se aplică ambelor tipuri · afișare Partener cu badge + „Preț standard" tăiat, „Avantaj partener" informativ în coș, doar prețul încasat pe factură · doar „Client standard" la instalare, celelalte 5 grupuri într-un seed specific magazinului · „persoană juridică" = CUI la facturare SAU grup `cost_plus` · intracomunitar (VIES) și OSS nu în Val 1 · `TaxClass`/`TaxRate` rămân generice (activă: o singură cotă) · blocul CLAUDE.md din `07` înlocuit cu pointer · Faza 15 la ~4-5 zile, totalurile din README +2 zile · permisiuni `products.cost.view` / `products.cost.edit`

**Propusă de Claude, confirmată de utilizator prin trimiterea acestui mesaj:**
- **SmartBill ca furnizor principal de facturare** (în loc de Oblio). Oblio rămâne posibil mai târziu prin aceeași interfață `InvoiceProvider`. Înainte de Faza 13: se citește documentația API curentă; utilizatorul verifică cu SmartBill că abonamentul include acces API

**Deschise (🟡), de decis, nu decizii:**
- Voucher cadou: contabilul a spus „reducere din comandă", proiectul îl tratează ca **metodă de plată**; rămâne metodă de plată până lămurește contabilul diferența dintre voucher cumpărat (plată anticipată) și cod de reducere gratuit (Faza 15b)
- Termenul legal minim de valabilitate al voucherelor: contabilul se interesează (Faza 15b)
- Puncte de loialitate: „TVA pe 100 sau pe 90?" la 100 lei cu 10 lei în puncte; întrebare trimisă contabilului (Faza 15b)
- Produs digital în comandă mixtă cu ramburs: recomandarea e eliberarea la livrare confirmată, nu la virament; în așteptarea deciziei utilizatorului (Faza 14b)

**Interpretări ale lui Claude, scrise în documente fără răspuns explicit (de corectat dacă nu sunt bune):**
- Regula dură: `minim în bani = max(cost transport, minCashAmount)`. La transport gratuit se aplică minimul de 1 leu, ca comanda de 0 lei să nu poată apărea nici atunci
- Regula „în bani ≥ transport" se aplică **punctelor**, nu voucherelor. Un voucher care acoperă integral o comandă ar produce plată fără gateway; l-am trecut la 🟡 (voucher)
- `notForDiscountedGroups` blochează orice grup cu `pricingType ≠ none`, deci și Partenerii
- Procentele se stochează ca `int` în puncte de bază (`discountBps`, `markupBps`); `lineTotal` se calculează o singură dată din valoarea exactă, iar `unitPrice` rotunjit e informativ
- Numele setărilor: `tax.standardRate`, `regional.allowedCountries`, `payment.cod.maxAmountIndividual` / `maxAmountCompany`, `loyalty.minCashAmount`. În TODO: `tax.standardRate` și `allowedCountries` în Faza 2 (aplicat în Faza 9), limitele de ramburs în Faza 9
- Bifat în Faza 0 „Întrebările pentru contabil" deși #8 și #9 rămân 🟡 (cum ai cerut); nota din TODO le menționează
- Taxare inversă VIES (Faza 13) tăiată în TODO, ca „nu în Val 1"
- Tratamentul transportului la retur, seriile separate online/offline/eMAG și procedura la eșecul e-Facturii nu au fost precizate de contabil; sunt notate ca atare în `10`

**Fișiere modificate:** `CLAUDE.md`, `docs/01`, `02`, `03`, `04`, `05`, `06`, `07`, `08` (cota TVA în instalator), `09` (rescris), `10`, `11`, `12`, `14`, `15`, `16`, `README.md`

**De unde reiau:** Faza 2 — Bază de date, setări, autentificare, într-o SESIUNE NOUĂ (Promptul 2). Primul punct: Sentry cu DSN din `Setting`. În Faza 2 intră și `tax.standardRate = 21` și `regional.allowedCountries = ["RO"]`

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
