# 06 — TODO MASTER (revizuit)

Model: **pachet instalabil, o instalare = un magazin** · Piață: **România, B2C**
Produse: **fizice + digitale (tutoriale video)** · Canale: **site propriu + eMAG (ulterior)**
Nișă: **echipamente pentru piscine** — produse grele, tehnice, sezoniere (vezi `15`)
Prețuri: **cu TVA inclus (21%, o singură cotă), identice pentru toți** + grupuri de clienți cu trei tipuri de preț: `none` (standard), `discount` (Fidel 5%, VIP 7%), `cost_plus` (Partener 1/2/3: preț NIR + adaos 12% / 17% / 21%, plafonat la prețul public). Vânzare doar în România
Integrări confirmate: **Netopia + EuPlătesc** · **wootPRO + Sameday direct** · **SmartBill** (Oblio posibil mai târziu) · **Bunny Stream**

Bifează pe măsură ce termini. Acest fișier e memoria proiectului între sesiunile de Claude Code.

---

## FAZA 0 — Decizii și pregătire · ~2 zile
- [x] Răspunde la cele 7 întrebări rămase din `01-arhitectura-si-decizii.md` §7 (rezolvate; deciziile sunt în `10`, Partea I)
- [x] **Completează `10-decizii-deschise.md`** — cel puțin toate întrebările marcate 🔴 (nu mai există nicio decizie 🔴 deschisă; Partea I e integral ✅)
- [x] ⚠️ **Primul magazin e al tău.** Fazele 18, 19 și 21 (instalator, extensii, împachetare) se fac DUPĂ lansarea magazinului tău, nu înainte. Vezi nota de strategie de la finalul fișierului.
- [x] Confirmă convenția de prețuri: **brut, cu TVA inclus, `int` în bani** (documentat în CLAUDE.md)
- [x] Definește grupurile de clienți și procentele: Client standard (`none`), Client fidel 5% și Client VIP 7% (`discount`), Partener 1/2/3 cu adaos 12% / 17% / 21% (`cost_plus`). Valori inițiale, editabile din admin
- [ ] Deschide conturi de test: Netopia, EuPlătesc, **wootPRO**, Sameday, **SmartBill** _(necesare pe parcurs: Netopia + EuPlătesc în Faza 10; wootPRO + Sameday în Faza 12; SmartBill în Faza 13)_
- [ ] **Verifică cu SmartBill că abonamentul tău include acces API** _(necesar înainte de Faza 13; fără acces API nu putem emite facturi din magazin)_
- [ ] **Furnizează un fișier exemplu de export SmartBill** („lista de mișcări produse", cu preț și dată de intrare) _(necesar înainte de Faza 15, pentru formatul importului de prețuri NIR)_
- [ ] Creează cont Bunny Stream pentru tutoriale video (poți amâna — driverul `local` funcționează pe localhost) _(necesar în Faza 14b; doar pentru producție)_
- [ ] **Cere VPS cu IP fix** — obligatoriu pentru whitelist-ul eMAG _(necesar înainte de Faza 21; whitelist-ul eMAG se folosește în Faza 22b)_
- [x] Întrebările pentru contabil din `10-decizii-deschise.md` Partea III (acum 14): răspunsurile primite sunt în `10`. **Rămân 🟡 deschise** #8 (voucher), #9 (TVA pe puncte) și valabilitatea voucherelor, de rezolvat până la Faza 15b; plus decizia despre digitalul din comanda mixtă cu ramburs, până la Faza 14b
- [ ] Cumpără domeniul pentru instalarea de test _(necesar în Faza 10 pentru webhook-urile de plată în sandbox, dacă nu folosești un tunel; cel târziu Faza 21)_
- [ ] Alege 3-5 magazine de referință pentru UX _(necesar în Faza 6)_
- [ ] **Exportă produsele din WordPress/WooCommerce** (CSV standard de export) și verifică ce coloane obții _(necesar în Faza 4, la punctul de import CSV)_
- [ ] Pregătește 20 de produse reale pentru datele demo _(necesar în Faza 4, la testarea importului; cel târziu Faza 7)_

## FAZA 1 — Fundație · ~3-4 zile
- [x] Monorepo pnpm + Turborepo conform `01` §2
- [x] Next.js 15, TypeScript strict, Tailwind, shadcn/ui
- [x] `docker-compose.dev.yml`: postgres, redis, minio, mailpit
- [x] Schema de env cu Zod — app refuză să pornească fără variabile
- [x] ESLint, Prettier, Husky, lint-staged, commitlint
- [x] Vitest + Playwright configurate, teste de smoke
- [x] GitHub Actions: lint, typecheck, test, build
- [x] Logger Pino cu requestId (Sentry mutat în Faza 2, vezi primul punct de acolo)
- [x] `/api/health` care verifică DB + Redis
- [x] `CLAUDE.md` scris (fișierul 07)
- [x] Fișier de versiune `packages/config/version.ts`

## FAZA 2 — Bază de date, setări, autentificare · ~4-5 zile
> **Stare:** FAZA 2 TERMINATĂ ȘI VERIFICATĂ (🏁 confirmată de utilizator) (Promptul 2 + Promptul 3): setări, criptare, flag-uri, audit, temă, seed, autentificare, rate limiting, RBAC, layout admin, contul de administrator, emailuri și `withAudit` pe scrieri. Verificare manuală: `docs/FAZA-2-verificare-manuala.md`. Atenție: în `07-prompturi-claude-code.md`, Promptul 3 aparține tot acestei faze din TODO; „Faza 3” din TODO este Media (Promptul 4).
- [x] **Sentry** (`@sentry/nextjs`) activat doar dacă există DSN, cu DSN din tabela `Setting` (editabil din admin), nu din `.env`; requestId ca tag. Decizie utilizator: amânat din Faza 1, se face aici o singură dată, după Service de setări
- [x] Schema Prisma: Setting, Branding, FeatureFlag, Integration, User, Role, Permission, Session, AuditLog
- [x] `auditLog()` doar de adăugare (trigger în DB), cu mascarea secretelor, și wrapper pentru server actions de admin
- [x] Design tokens din `Branding`: validare strictă Zod, fonturi locale (`next/font`), verificare contrast WCAG AA, CSS servit fără flash de temă greșită, 3 presets
- [x] **Service de setări** cu cache Redis, typed getters, valori implicite neutre
- [x] Setări implicite fiscale și regionale: `tax.standardRate = 21` (cota unică; nu hardcodată nicăieri în cod) și `regional.allowedCountries = ["RO"]` (aplicată în Faza 9)
- [x] Criptare AES-256-GCM pentru credențialele de integrare (cu `APP_KEY`)
- [x] Auth complet: register, verificare email, login, logout, forgot, reset (argon2id) — Better Auth + argon2id, lockout, middleware `/admin` `/cont`, pagini de autentificare, emailuri BullMQ + React Email
- [x] Rate limiting Redis pe rutele sensibile (autentificare, înregistrare, resetare, confirmare email; lockout 15 min; `trustedProxyHops`)
- [x] RBAC: permisiuni ca string-uri (inclusiv `admin.access`), roluri implicite, `can()` + `withPermission()`, matrice rol × permisiune în `docs/04` §6
- [x] Feature flags cu helper `isEnabled()`
- [x] Layout admin: sidebar, topbar, breadcrumbs, guard (meniul ascunde funcțiile cu flag oprit: `FeatureFlagService.list()` e gata)
- [x] **Contul de administrator** (creat la instalare/prin comandă, fără parolă implicită în cod sau seed) și atribuirea rolului Owner
- [x] Legarea `withAudit` la scrierile din admin (`SettingsService.set`, `FeatureFlagService.setEnabled`, `BrandingService.save`, `IntegrationService.save`): diferențe, valori sensibile excluse, încercări refuzate (`outcome`), matrice rol × acțiune
- [x] Seed de bază: roluri, permisiuni, setări implicite, flag-uri oprite, branding implicit (idempotent). **Contul de administrator NU e aici: se mută în Promptul 3 (autentificare), fără parolă implicită**
- [x] (8b) Bază de date separată pentru testele de integrare: `ecom_test` creată și migrată automat, Redis pe alt index, gardă care refuză bazele fără "test" în nume, aceeași bază în CI
- [x] (10) Teste rămase pentru Promptul 2: setări, flag-uri, criptare, audit append-only, branding (ruta /theme.css, golden-uri, fallback-uri)
- [x] (10b) Testele unitare nu pot atinge baza reală: setupFile cu URL-uri invalide și blocarea conexiunilor, plus test de arhitectură pe importuri
- [x] (11) Verificare manuală cap-coadă Faza 2 (`docs/FAZA-2-verificare-manuala.md`), cu `pnpm dev:age-session` pentru expirarea sesiunii de admin — confirmată de utilizator
- [x] (12) Închiderea Fazei 2: TODO, PROGRESS, `docs/FAZA-2-ce-functioneaza.md` — 🏁 confirmată de utilizator

## FAZA 3 — Media · ~2-3 zile

> **Stare:** FAZA 3 TERMINATĂ ȘI VERIFICATĂ (🏁 confirmată de utilizator; CI verde pe `e8fa51f`). Rezumat: `docs/FAZA-3-ce-functioneaza.md`. Verificare manuală: `docs/FAZA-3-verificare-manuala.md`. Datoriile tehnice sunt într-un singur loc, în `docs/PROGRESS.md`.
> **Decizii (utilizator, Promptul 4):** driverul de storage rămâne în `.env` (`STORAGE_DRIVER`, credențialele S3), nu în Setări · upload prin server, cu stream, pentru ambele drivere (presigned URL doar când apar fișiere mari) · limită implicită 20 MB și ~40 megapixeli, tipuri JPEG/PNG/WebP/AVIF (fără GIF, SVG respins), editabile din setări · se păstrează originalul fără EXIF/GPS pentru regenerarea variantelor · alegerea furnizorului de storage de producție: Faza 18
- [x] (1) Schema `Media` + `MediaFolder`, migrația și permisiunea `media.read` (cu matricea din `docs/04` §6)
- [x] (2) Adaptor de storage în `packages/integrations`: disc local ↔ S3-compatible (driver din `.env`), fișiere publice și private, URL semnat; teste pe MinIO (bucket de test, gardă) și serviciul MinIO în `ci.yml`
- [x] (3) Upload prin server: validare MIME reală, limite de mărime, de pixeli și de tipuri (din setări), nume randomizate, original fără EXIF; ruta API cu sesiune, `media.write`, Origin, rate limit, audit (inclusiv refuzuri) și verificarea mărimii în timpul stream-ului
- [x] (4) Procesare imagini în queue: variante thumb/medium/large × AVIF/WebP/JPEG, dimensiuni, blurhash, regenerare din original; limită globală de 2 decodări simultane (upload: 503 + Retry-After; worker: jobul așteaptă), limita de pixeli și la procesare, retry cu backoff, `failed` vizibil cu doar un cod de motiv
- [x] (5) Servire: `/media/…` (public, cache `immutable`, `nosniff`, doar imagini) și `/storage/signed/…` (privat, doar cu semnătură), helper `buildMediaUrls`, protecție la path traversal, politica de citire anonimă pe `public/*` aplicată de `storage:init` și `S3_PUBLIC_URL` pentru MinIO din dev; teste pe chei periculoase și pe MinIO real
- [x] (6) Bibliotecă media în admin: grid cu thumb + placeholder blurhash și paginare, căutare (nume, alt, tag) și filtre (folder, stare), upload drag & drop multiplu (max. 2 simultan, progres, mesaje pe 413/415/429/503), status care se actualizează singur, regenerare pentru `failed`, alt-text și taguri, foldere (creare, redenumire, mutare), ștergere cu verificare `MediaUsageProvider` și confirmare; `media.read` pentru pagini, `media.write` pentru scriere; mod întunecat, tastatură, telefon
- [x] (7) Selector reutilizabil `MediaPicker` pentru formulare (selecție unică și multiplă): număr maxim configurabil, ordinea alegerii păstrată, doar fișiere `ready` cu `thumb`, returnează doar id-uri; reutilizează grid-ul, filtrele și coada de încărcări din bibliotecă; dialog accesibil (focus capturat, Escape, tastatură, telefon, mod întunecat); `media.read`, încărcare doar cu `media.write`; testat printr-un harness doar pentru E2E, fără rută în producție
- [x] (8) Teste E2E, verificare manuală cap-coadă (`docs/FAZA-3-verificare-manuala.md`) și închiderea fazei (TODO, PROGRESS). **Include un test E2E de upload care rulează pe driverul S3 din CI** (serverul E2E cu `STORAGE_DRIVER=s3` pe MinIO, bucket creat cu `pnpm storage:init` în workflow; bucket cu „test” în nume), ca problemele care apar doar pe configurația reală (bucket lipsă, credențiale, path-style) să nu mai scape

## FAZA 4 — Catalog: model și admin · ~8-10 zile

> **Plan aprobat de utilizator (Promptul 5).** Numerotarea de mai jos e cea din plan; un commit per punct. Propunere de `git push` (doar la cererea utilizatorului) după punctele 2, 6, 10 și 14.
> **Decizii (utilizator):** `products.content.write` pentru Editor, Manager, Admin, Owner (descriere, SEO, media, documente; serverul respinge câmpurile de preț/stoc/cost, cu test explicit; matricea din `docs/04` §6 se actualizează la punctul 7) · `shippingClass` = `standard` / `oversized` / `pallet` (fără `requiresPalletDelivery`; regulile de preț și curier pe clase la Faza 12) · `ean` și `warrantyMonths` pe VARIANTĂ, cu editare comodă pe produs când are o singură variantă · migrarea e din **WordPress/WooCommerce** (nu OpenCart) · `legacyId`/`legacyUrl` pe produse, categorii, branduri (redirecționări 301 în Faza 17) · `PriceHistory` proiectat pentru „cel mai mic preț din ultimele 30 de zile” (Omnibus), cu test pe calcul.

- [x] (0) Curățarea conturilor `e2e-*` la ÎNCEPUTUL rulării (E2E și integrare, cu garda de bază de test) + măsurarea RSS a serverului de test pe parcursul suitei (script mic, fără modificări în aplicație). Build de producție pentru E2E doar dacă măsurarea arată o problemă reală
- [~] (0b) E2E pe build de producție (`next build` + `next start`, `NEXT_DIST_DIR` separat, port propriu), același mod local și în CI; `workers: 2` local rămâne. Măsurare RSS înainte/după (vârf, durata build-ului)
- [ ] (1) Schema `Product`, `ProductVariant`, `ProductMedia` + migrația (`ean`, `warrantyMonths`, `manageStock`/`stockStatus`, `type` physical/digital, `legacyId`/`legacyUrl`)
- [ ] (2) ⚠️ **Provider de utilizare media pentru produse (cerință explicită, cu test):** `ProductMediaUsageProvider` (`MediaUsageProvider` din `@ecom/core`, înregistrat prin `getMediaUsageRegistry()`) care raportează, pentru fiecare fișier, produsele și variantele care îl referă prin `ProductMedia`. **Înregistrarea se face înaintea oricărei funcții care permite produselor să refere fișiere din bibliotecă** (selector, import CSV cu imagini prin URL). Test obligatoriu: un fișier folosit de un produs nu se poate șterge (refuz cu lista produselor, cu link spre produs), iar după ce e scos din produs se poate șterge; și un test care pică dacă `ProductMedia` există, dar providerul nu e înregistrat
- [ ] (3) Schema restului catalogului: `Category`, `Brand`, `Collection`, `Attribute`/`AttributeValue` (numerice cu unitate, filtrabile pe interval, `15` §3), `ProductRelation` (`accessory`, `upsell`, `spare_part`, `compatible_with`), `TaxClass`/`TaxRate` (generice), opțiuni și valori de opțiune, `PriceHistory` (proiectat pentru „cel mai mic preț din ultimele 30 de zile”, cu test), `excludeFromGroupDiscount` pe produs și categorie, `legacyId`/`legacyUrl` pe categorii și branduri
- [ ] (4) Câmpuri de nișă și pregătitoare: `weight`, `dimensions`, `shippingClass` (`standard`/`oversized`/`pallet`), `requiresInstallation` (`15` §4), `ProductDocument` + `energyClass`/`eprelUrl` (`15` §2), `PartsDiagram` + `PartsDiagramHotspot` (`15` §5.2), GPSR, `expectedRestockDate`, `allowBackorder`, `Order.parentSubscriptionId`, `manufacturerPartNumber`/`manufacturerName` pe variantă, `brandId` obligatoriu
- [ ] (5) Tabelele de canal (`SalesChannel`, `ChannelListing`, `ChannelCategoryMapping`), canalul `web` implicit, interfața `ChannelProvider` (schelet, `12` §5), `channelId`/`externalId`/`externalData` pe `Order`
- [ ] (6) **`costPrice` (int, bani, FĂRĂ TVA) și `costPriceDate` pe variantă** + `CostPriceHistory` (`09` §1). **Doar în admin**: nu apar în API public, props către componente client, feed-uri, `OrderLine.productSnapshot` sau loguri (`costPrice` în câmpurile mascate din logger); `products.cost.view` / `products.cost.edit`; test care garantează că nu apar în nicio proiecție publică
- [ ] (7) ⚠️ **Permisiune separată pentru conținutul produsului:** `products.content.write` (Editor, Manager, Admin, Owner). `products.write` rămâne pentru prețuri/stoc/cost/variante. Serverul respinge câmpurile de preț, stoc și cost trimise de cineva cu doar `content.write` (test explicit). Actualizează catalogul RBAC, matricea din `docs/04` §6 și testele
- [ ] (8) Servicii în `packages/core`: slug unic (cu sufix la coliziune), generator de variante, validări Zod, `auditLog`, invalidare cache; teste pe slug și pe variante
- [ ] (9) Admin: categorii (arbore drag & drop, imagine, SEO) și branduri (CRUD)
- [ ] (10) Admin: listă de produse cu filtre, căutare, paginare, editare inline și în masă (preț ±%, status, categorie)
- [ ] (11) Admin: editor de produs pe taburi (General, Prețuri, Variante, Stoc, Atribute, Categorii, SEO, GPSR, Asociate, Documente); generator de variante din opțiuni cu editare în tabel; `ean`/`warrantyMonths` editabile direct pe produs când are o singură variantă; câmpurile de cost în tab-ul „Prețuri”, doar cu permisiune
- [ ] (12) Tab-ul Media cu `MediaPicker` (primul consumator real; abia după punctul 2) 
- [ ] (13) Duplicare, arhivare, soft delete
- [ ] (14) Import/export CSV + XLSX generic, cu mapare de coloane, dry-run, raport de erori pe rând, upsert pe SKU, șablon CSV descărcabil și documentat
- [ ] (15) ⚠️ **Profil de import WooCommerce** (peste formatul generic) pentru migrarea celor ~500 de produse: CSV standard de export (Type simple/variable/variation, Parent, SKU, Name, Description, Regular price, Sale price, Categories ierarhice, Tags, Images ca URL-uri, atribute), prețuri cu sau fără TVA (conversie cu cota din setări), creare automată de categorii și branduri, atribute din coloane dinamice, date murdare, import repetabil fără duplicate, reluabil, `legacyId`/`legacyUrl`. **Import de imagini prin URL cu protecție SSRF obligatorie:** doar https, listă de domenii permise configurabilă, refuz pentru adrese private/locale/metadata, limită de redirecționări, limită de mărime și tip, același pipeline de validare ca la upload (tip real din octeți, re-codificare, variante prin queue); test pentru fiecare refuz. Eșantionul real de 20 de produse vine de la utilizator înainte de acest punct
- [ ] (16) E2E, verificare manuală cap-coadă (`docs/FAZA-4-verificare-manuala.md`) și închiderea fazei (TODO, PROGRESS)

## FAZA 5 — Stoc · ~3 zile
- [ ] Schema: Warehouse, InventoryItem, StockMovement, StockReservation, BackInStockAlert
- [ ] Service cu `reserve/release/commit/adjust/transfer`, tranzacții + `SELECT FOR UPDATE`
- [ ] **Ocolire completă a logicii de stoc când `manageStock = false`**: fără rezervare, fără decrement, fără alerte. Disponibilitatea = bifa `stockStatus`.
- [ ] **Test de concurență**: 10 cereri simultane pe stoc 1 → una singură reușește
- [ ] Cron de eliberare a rezervărilor expirate
- [ ] Admin: stoc per depozit, ajustări cu motiv, istoric, alerte stoc mic
- [ ] Multi-depozit în DB, dar UI simplu în spatele feature flag-ului

## FAZA 6 — Design system și layout · ~4-5 zile
- [ ] Design tokens în `Branding`, injectate server-side ca CSS variables
- [ ] 3 presets de temă (Minimal, Bold, Editorial)
- [ ] **Editor de temă Nivel 2**: culori, fonturi, radius, logo, favicon, OG, **variante de header și footer**, **layout de card de produs**, lățime container, dark mode, **CSS custom**, preview live
- [ ] Componente de bază în `packages/ui`, zero culori hardcodate
- [ ] Header (logo, mega menu, search, cont, wishlist, coș)
- [ ] Mobile nav drawer, footer configurabil cu ANPC/SAL și date firmă
- [ ] Announcement bar, 404, 500, mentenanță, skeletons

## FAZA 7 — Storefront catalog · ~7-9 zile
- [ ] ⚠️ **Cache și regenerare pentru vitrină**: acum `/` (și zonele `(auth)`, `(admin)`, `/cont`) sunt `force-dynamic` pe segment. Vitrina trebuie să citească setările/brandingul cu cache (tag-uri, `revalidate`) ca să poată fi servită din cache și regenerată (viteză, SEO). Restrânge `force-dynamic` doar la rutele care chiar au nevoie de el
- [ ] PLP cu grid, sortare, paginare, descriere SEO
- [ ] Filtre faceted cu contorizări, sincronizate în URL, funcționale fără JS
- [ ] **Filtre pe interval numeric** (debit, putere, volum piscină) cu slider
- [ ] **Componenta `EnergyLabel`** afișată pe card, pe PDP și în coș, înainte de finalizarea comenzii
- [ ] Tab „Descărcări" pe PDP cu documentele produsului
- [ ] **Tab „Piese de schimb"** cu fișa explodată și tabel numerotat, cu adăugare directă în coș
- [ ] Tabel de specificații tehnice structurat pe PDP
- [ ] Secțiuni „Piese de schimb” și „Se montează cu” pe PDP
- [ ] PDP: galerie, variante, preț, Omnibus (cel mai mic preț din 30 zile), stoc, taburi, GPSR, produse asociate, sticky add-to-cart mobil
- [ ] Căutare Postgres FTS + pg_trgm + autocomplete (~500 produse — **fără Meilisearch în Val 1**)
- [ ] Pagini brand și colecție
- [ ] Breadcrumbs + structured data
- [ ] ISR + `revalidateTag` la salvarea produsului
- [ ] ⚠️ **Rutele funcționalităților opționale** (`requireFeature`, `apps/web/src/lib/features.ts`) citesc flag-ul la fiecare cerere, deci ruta devine **dinamică**. Alege conștient: pagina rămâne dinamică sau flag-ul se citește la build/ISR. În ambele cazuri, **paginile din cache trebuie invalidate (`revalidateTag`/`revalidatePath`) când se schimbă un flag**, altfel o pagină oprită rămâne servită din cache

## FAZA 8 — Motor de prețuri și coș · ~5-6 zile ⚠️
- [ ] **Motor de prețuri** (`09-preturi-si-parteneri.md` §3): preț brut → salePrice → preț de grup (`none` / `discount` / `cost_plus`; extinderea vine în Faza 15) → cupon → puncte → total linie → extragere TVA
- [ ] Extragere TVA din brut, rotunjire pe linie, o singură dată
- [ ] **Testele scrise ÎNAINTE de implementare**: cumulare promoție + grup, produse excluse, cupon peste discount, rotunjiri, cota standard din setări plus o a doua cotă de test (dovadă că nu e hardcodat)
- [ ] Coș în DB + coș de guest cu token în cookie, merge la login
- [ ] Cart drawer + pagină `/cos`
- [ ] Validare la fiecare afișare (produs activ, preț actual, stoc)
- [ ] Cantitate minimă și multipli aplicați
- [ ] Prag de transport gratuit cu indicator
- [ ] **Cross-sell în coș**: sugestii de accesorii și racorduri la produsele mari
- [ ] Aplicare cupon cu toate condițiile

## FAZA 9 — Checkout și plasare comandă · ~8-10 zile ⚠️ partea critică
- [ ] Schema: Order, OrderLine, OrderEvent, Payment, Address, ShippingZone, ShippingMethod
- [ ] Motor de livrare: zone pe județ/localitate, tarife, praguri, taxă ramburs, **ridicare personală de la sediu**
- [ ] **Greutate volumetrică** ((L×l×h)/5000) și tarifare pe cea mai mare dintre greutăți
- [ ] **Tarife cerute în timp real de la API-ul agregatorului**, cu cache scurt și fallback pe taxă fixă dacă API-ul e picat
- [ ] Pragul de transport gratuit **dezactivabil per clasă de transport și per produs**
- [ ] **Cerere de ofertă instalare** în checkout: bifă nebifată implicit + câmp de observații, fără impact pe total (`15` §4)
- [ ] Blocare automată a easybox-ului dacă în coș există un produs `oversized` (sau `pallet`)
- [ ] Mesaj explicit despre livrarea la nivelul solului, fără descărcare
- [ ] Seed cu județele și localitățile din România (SIRUTA)
- [ ] UI checkout pe pași accordion (`03-frontend.md` §2)
- [ ] Facturare pe firmă cu **validare CUI la ANAF**
- [ ] `PlaceOrderUseCase`: tranzacție atomică, snapshot, rezervare stoc, numerotare, idempotency key
- [ ] State machine cu 3 statusuri și tranziții validate, scrie `OrderEvent`
- [ ] Confirmare + `/comanda/urmarire` pentru guest
- [ ] **Vânzare doar în România, pentru orice produs**: țările permise vin din `regional.allowedCountries` (implicit `["RO"]`), verificate pe server la adresa de livrare și de facturare, cu mesaj clar
- [ ] **Limite de ramburs, configurabile în setări**: `payment.cod.maxAmountIndividual` (implicit 10.000 lei) și `payment.cod.maxAmountCompany` (implicit 5.000 lei). „Persoană juridică" = CUI la facturare **sau** grup `cost_plus`. Peste limită, metoda se ascunde și se explică de ce
- [ ] Ramburs + transfer bancar funcționale cap-coadă
- [ ] E2E Playwright: cumpărare completă ca guest

## FAZA 10 — Plăți online (Netopia + EuPlătesc) · ~7-9 zile
- [ ] Interfață `PaymentProvider`
- [ ] Implementare **Netopia mobilPay** ȘI **EuPlătesc**, ambele active, mod test/live din setări
- [ ] Chei criptate în `Integration`, cu buton „testează conexiunea"
- [ ] Flux redirect + 3DS + retur + pagină de așteptare cu polling
- [ ] **Webhook/IPN**: verificare semnătură + idempotență pe eventId + procesare async
- [ ] Toate cazurile: succes, eșec, anulare, timeout, plată dublă, sumă diferită, webhook duplicat/întârziat
- [ ] Link „reîncearcă plata" valabil 24h
- [ ] Rambursare parțială și totală din admin
- [ ] Job de reconciliere zilnică
- [ ] Test: webhook trimis de 3 ori → un singur efect

## FAZA 11 — Admin comenzi + emailuri · ~6-7 zile
- [ ] Listă comenzi cu filtre, căutare, vizualizări salvate, acțiuni în masă
- [ ] Badge și filtru pentru **cereri de instalare**, cu status de urmărire și notificare pe email
- [ ] Detaliu comandă: linii, adrese, timeline, plăți, note, client
- [ ] Acțiuni: confirmă, anulează, rambursează, editează, duplică, retrimite email
- [ ] Draft order cu link de plată
- [ ] React Email + provider **SMTP configurabil din admin** + queue cu retry
- [ ] Toate template-urile din `02-complet-si-functional.md` §B8
- [ ] Preview și trimitere de test din admin, suprascriere de template
- [ ] Notificări interne
- [ ] Emailul de confirmare conține informațiile precontractuale cerute de lege

## FAZA 12 — Livrare și AWB (agregator + Sameday) · ~5-6 zile
- [ ] ⚠️ **Reguli de preț și de curier pe clase de transport** (`standard` / `oversized` / `pallet`, `shippingClass` din Faza 4): ce curier/serviciu primește `pallet`, dacă prețul vine tot din API, prag de transport gratuit per clasă, blocarea easybox-ului. De decis cu utilizatorul înainte de implementare
- [ ] Interfață `ShippingProvider`
- [ ] **Adaptor wootPRO**: AWB, etichetă, tracking, anulare, puncte de ridicare, tarife în timp real
- [ ] **Adaptor Sameday direct**: pentru clienții cu contract propriu + **easybox cu hartă în checkout**
- [ ] ⚠️ NU construi integrare Cargus separată — Sameday a achiziționat Cargus în august 2026, sistemele se unifică
- [ ] Mapare județe/localități către nomenclatoarele curierilor
- [ ] Admin: generare AWB individual și în masă, etichete PDF + ZPL, AWB de retur
- [ ] Ramburs transmis către curier + reconciliere (plata se consideră încasată când curierul virează banii; ecran de reconciliere în admin, `10` Partea I)
- [ ] Cron la 10 min de sincronizare status → email automat la expediere și livrare
- [ ] Circuit breaker: curier picat ≠ comandă pierdută

## FAZA 13 — Facturare și e-Factura (SmartBill) · ~4-5 zile
- [ ] **Înainte de a începe:** citește documentația API curentă a SmartBill; utilizatorul a confirmat cu SmartBill că abonamentul include acces API (`10` Partea II #9)
- [ ] Interfață `InvoiceProvider` (SmartBill primul; Oblio posibil mai târziu prin aceeași interfață)
- [ ] **SmartBill**: emitere, storno (total și parțial), proformă, PDF, status e-Factura. Seria și numărul le definește SmartBill (fără numerotare locală); e-Factura o transmite SmartBill automat
- [ ] **Momentul emiterii, după metoda de plată** (`10` Partea I):
  - card: factura la plata confirmată
  - transfer bancar: proformă la plasare, apoi factură după ce adminul confirmă plata
  - ramburs: factura la plasarea comenzii, cu storno dacă se întoarce; „încasat" la virarea banilor de către curier (reconciliere în admin, Faza 12)
- [ ] Emitere prin queue, cu retry; o factură care eșuează NU blochează comanda
- [ ] Storno automat la anulare, refuz ramburs și rambursare; **storno parțial la retur parțial**
- [ ] Facturi în admin și în contul clientului; `efacturaStatus` vizibil, cu buton de retrimitere
- [ ] Setări: date firmă, TVA (cota standard din setări, implicit 21%), cont bancar
- [ ] ~~Taxare inversă intracomunitară cu validare VIES~~ **nu în Val 1** (vânzare doar în România)
- [ ] Alertă în admin după 3 eșecuri de emitere

## FAZA 14 — Cont client și retururi · ~4-5 zile
- [ ] Dashboard, istoric comenzi, detaliu cu timeline și tracking AWB
- [ ] Agendă de adrese, descărcare facturi, wishlist, recenziile mele
- [ ] Preferințe de comunicare, export date GDPR, ștergere cont cu anonimizare
- [ ] Schema ReturnRequest + state machine
- [ ] Client: inițiere retur în fereastra de 14 zile, selectare produse și motiv
- [ ] Admin: aprobare, AWB retur, recepție, inspecție, rambursare, repunere pe stoc
- [ ] Emailuri la fiecare tranziție + raport de motive

## FAZA 14b — Produse digitale · ~5-6 zile
- [ ] 🟡 **Decizie deschisă a utilizatorului, înainte de a începe:** în comanda mixtă plătită cu ramburs, produsul digital se eliberează la **livrare confirmată** (recomandare) sau la virarea banilor? (`10` Partea I)
- [ ] Schema: DigitalProduct, DigitalAsset, DigitalEntitlement, DigitalAccessLog (`11` §2)
- [ ] Interfața `MediaDeliveryProvider` cu 3 drivere: `local` (dezvoltare), `bunny` (video în producție), `s3` (fișiere)
- [ ] Upload video în background cu progres și transcodare
- [ ] Admin: tab „Conținut digital" pe produs, module ordonabile, lecție de preview
- [ ] Generare entitlements la confirmarea plății, revocare la rambursare
- [ ] `/cont/produsele-mele`: bibliotecă, player, descărcare cu contor
- [ ] Linkuri semnate cu expirare scurtă + watermark cu emailul cumpărătorului
- [ ] **Checkout mixt** (`11` §7): fără livrare pe coș 100% digital, transport doar pe liniile fizice, ramburs ascuns la comenzi doar digitale, prag de transport gratuit calculat doar pe fizic
- [ ] **Bifă legală separată și neprebifată** pentru pierderea dreptului de retragere, salvată pe comandă (`11` §5)
- [ ] Restricționarea vânzării digitale la România în Val 1 (fără OSS)
- [ ] Admin: resetare contor descărcări, prelungire acces, revocare, log de accesări
- [ ] Test: comandă mixtă → digitalul livrat instant, fizicul rămâne `partially_fulfilled`

## FAZA 15 — Grupuri de clienți, prețuri de partener și prețuri NIR · ~4-5 zile
- [ ] **Înainte de a începe:** primești de la utilizator un fișier exemplu de export SmartBill (`10` Partea II #10)
- [ ] Schema: `CustomerGroup` cu `pricingType` (`none` | `discount` | `cost_plus`), `discountBps`, `markupBps` (întregi în puncte de bază) + `Customer.groupId` + `excludeFromGroupDiscount` pe produs și categorie (se aplică ambelor tipuri)
- [ ] Snapshot pe comandă: `customerGroupId`, `groupPricingType`, `groupDiscountBps` / `groupMarkupBps`, `groupAdvantageAmount`
- [ ] Extinderea motorului de prețuri cu cele trei tipuri (teste scrise întâi, `09` §7): `discount` = prețul public minus procentul; `cost_plus` = `costNet × (1 + adaos) × (1 + TVA)`, **plafonat la prețul public curent**; fără preț NIR → preț public
- [ ] Regula de cumulare cu promoțiile pentru `discount`, controlată de `stacksWithSalePrice` (implicit nu se cumulează)
- [ ] Afișare în storefront: prețul de grup + „Preț standard" tăiat + badge, identic pe PLP și PDP; prețul de partener se calculează dinamic, în afara cache-ului ISR
- [ ] Coș și checkout: linie de reducere (Fidel/VIP) sau linie informativă „Avantaj partener"; pe factură doar prețul unitar încasat
- [ ] Admin: CRUD grupuri (selector de tip + procent), grupul „Client standard" neștergibil, badge și filtru în lista de clienți
- [ ] **Seed specific magazinului** (nu default de pachet): Client fidel 5%, Client VIP 7%, Partener 1/2/3 la 12% / 17% / 21%; Partenerii cu `earnsLoyaltyPoints = false`
- [ ] Atribuire de grup în masă + audit log
- [ ] **Import prețuri NIR din SmartBill** (`09` §4): upload, dry-run, potrivire pe SKU, cea mai recentă dată per produs, actualizare doar dacă data e mai nouă, istoric în `CostPriceHistory`, raport cu coduri necunoscute, repetabil fără dubluri, `auditLog()`
- [ ] Indicator și filtru „produse fără preț NIR" în admin
- [ ] Raport: vânzări per grup, total avantaj acordat
- [ ] (opțional) Promovare automată în „Client fidel" după X lei sau N comenzi

## FAZA 15b — Puncte de loialitate și vouchere · ~6 zile
Vezi `14-loializare-si-vouchere.md`. **Se face după ce comenzile, plățile și retururile funcționează complet.**
- [ ] Setări de loialitate: rată de acumulare, valoare punct, moment de acordare, expirare, plafon procentual de utilizare (implicit **fără plafon**, configurabil), minim în bani când nu există transport (`minCashAmount`, implicit 1 leu)
- [ ] Schema: LoyaltyAccount, LoyaltyTransaction (registru imutabil — soldul se recalculează, nu se editează)
- [ ] Acumulare: 1 punct la 100 lei, pe subtotalul după reduceri, fără transport, cu `floor`
- [ ] `CustomerGroup.earnsLoyaltyPoints` — **fals pentru Partener 1/2/3**; Standard, Fidel și VIP acumulează, iar discountul Fidel/VIP se cumulează cu punctele
- [ ] Acordare la expirarea ferestrei de retur, cu status „în așteptare” vizibil în cont
- [ ] Răscumpărare ca ultimă reducere, **fără plafon procentual**, dar **punctele nu acoperă transportul**
- [ ] ⚠️ **Regula dură a sumei în bani**: suma de plătit în bani ≥ `max(cost transport, minCashAmount)`; punctele aplicabile ≤ total − acel minim (`14` §2.A). **Comanda de 0 lei nu poate apărea; nu există ramura `loyalty_points`.** Sliderul din checkout se oprește la maximul permis
- [ ] 🟡 Înainte de reducerea din puncte pe factură: răspunsul contabilului la „TVA pe 100 sau pe 90?" (`10`, Partea I)
- [ ] Acumulare doar pe suma plătită efectiv cu bani (fără buclă de puncte pe puncte)
- [ ] Client promovat la Partener: păstrează soldul, nu mai acumulează
- [ ] Expirare la 12 luni, cu email de avertizare cu 30 de zile înainte
- [ ] **Toate cazurile din `14` §5**: anulare, retur parțial, sold negativ, rambursare, guest
- [ ] Afișare: sold în cont, „primești X puncte” pe PDP, utilizare în checkout
- [ ] Admin: sold per client, ajustare cu motiv obligatoriu, raport de datorie în puncte
- [ ] Schema: Voucher, VoucherTransaction, **cu sold rămas** (nu cod cu o singură utilizare)
- [ ] ⚠️ Voucherul intră la **PLATĂ**, nu în lanțul de reduceri. Nu reduce baza de TVA
- [ ] 🟡 Rămâne deschis cu contabilul: voucher cumpărat (plată anticipată) vs cod de reducere gratuit; termenul legal minim de valabilitate; tratamentul voucherului care acoperă integral o comandă (`10`, Partea I)
- [ ] Emitere din admin + vânzare ca produs pe site, cu mesaj personalizat pe email
- [ ] Admin: listă, anulare, ajustare cu audit, **raport de datorie în vouchere**

## FAZA 16 — CMS și conținut · ~6-7 zile
- [ ] ⚠️ **Provideri de utilizare media pentru pagini și bannere (cerință explicită, cu test):** câte un `MediaUsageProvider` pentru blocurile de pagină (inclusiv homepage), bannere (și blog, dacă are imagini), înregistrate înainte ca editorul de pagini să poată referi fișiere din bibliotecă. Teste: un fișier folosit într-un bloc sau banner nu se poate șterge (refuz cu lista locurilor), iar după ce e scos se poate
- [ ] ⚠️ **Utilizatori și roluri în admin (`users.manage`) — reguli anti-escaladare de privilegii** (decizie utilizator): un utilizator nu poate acorda un rol sau o permisiune pe care nu o are; doar Owner atribuie sau retrage rolul Owner; un Admin nu își poate modifica propriul rol și nici pe cel al Owner-ului; **test explicit pentru escaladare de privilegii**. Verificarea stă în `packages/core`, nu în UI
- [ ] 🟡 **Upload media pentru Manager:** acum Managerul are `media.read` dar NU `media.write` (decizie utilizator, Faza 3). De reluat aici dacă vrem ca Managerul să poată încărca imagini (ex. la produse); schimbarea e în `packages/core/src/rbac/catalog.ts` + matricea din `docs/04` §6
- [ ] ⚠️ **Rambursare pentru Suport: limita de rambursare** — până atunci `orders.refund` nu e la Suport (Faza 11, ecranul de comenzi/rambursări)
- [ ] Schema: Page, Menu, Banner, BlogPost, Faq, Redirect, SeoMeta, BlockPreset
- [ ] Sistem de blocuri cu registry, schema Zod per bloc, formular de editare
- [ ] Editor de pagini drag & drop cu preview live
- [ ] **Homepage construit exclusiv din blocuri**
- [ ] Editor de meniuri (arbore)
- [ ] Blog, FAQ, bannere programabile
- [ ] Pagini legale cu versionare (trebuie să știi ce versiune a acceptat clientul)
- [ ] **Generator de pagini legale precompletate cu datele firmei** (pentru instalator)
- [ ] Formular de contact cu anti-spam
- [ ] Banner de cookie-uri care **blochează efectiv scripturile** + Consent Mode v2
- [ ] ⚠️ **Blog, FAQ și paginile din CMS în spatele flag-urilor** (`requireFeature`): gardarea face ruta dinamică; la schimbarea unui flag din admin invalidează cache-ul paginilor afectate (și meniul/sitemap-ul care îl listează), altfel o funcție oprită rămâne vizibilă din cache

## FAZA 17 — Promoții, recenzii, marketing, SEO · ~6-8 zile
- [ ] Schema Discount + motor de reguli (teste scrise întâi)
- [ ] Admin reduceri, generator de coduri, statistici
- [ ] Recenzii: submit, moderare, răspuns, achiziție verificată, solicitare automată post-livrare
- [ ] Newsletter cu dublu opt-in, coș abandonat (3 emailuri)
- [ ] Feed Google Merchant + Facebook
- [ ] GA4 + Meta Pixel + CAPI server-side, cu consimțământ
- [ ] Sitemap dinamic, robots, structured data complet, redirect-uri 301
- [ ] ⚠️ **Redirecționări 301 din adresele vechi WooCommerce la lansare** (din `legacyUrl` păstrat pe produse, categorii și branduri din Faza 4): tabel de redirecționări, test pe fiecare tip, raport de adrese vechi fără corespondent
- [ ] Audit SEO intern în admin

## FAZA 18 — Instalator și neutralitate white-label · ~5-6 zile 🔑
- [ ] Wizard `/install` complet (`08-instalare-si-distributie.md` §2)
- [ ] Notă: **tu faci instalările**, deci wizard-ul poate presupune un utilizator tehnic. Fără „prost-rezistență" extremă. Economie ~2-3 zile.
- [ ] Verificare cerințe, test conexiune DB, rulare migrații cu progres
- [ ] Generare `APP_KEY` + avertisment de păstrare
- [ ] Setare date firmă → propagate automat în footer, facturi, emailuri, pagini legale
- [ ] Creare cont administrator, alegere temă, upload logo
- [ ] Generare pagini legale + meniuri + date demo opționale
- [ ] ⚠️ **Storage de producție (decizie utilizator, de luat aici):** alege furnizorul (S3 la un furnizor, R2, MinIO propriu) și rulează `storage:init` pe bucketul real. Cerințe: politica de citire anonimă DOAR pe `public/*` (`storage:init` o aplică; dacă furnizorul are alt mecanism, se configurează acolo), `S3_PUBLIC_URL` = domeniul CDN/bucketului, antetul `X-Content-Type-Options: nosniff` setat la CDN (pe obiectele S3 nu se pot stoca antete arbitrare), `private/` fără acces anonim, test cu un fișier `private/` care nu se poate citi fără link semnat
- [ ] Blocare permanentă `/install` după instalare
- [ ] ⚠️ **`APP_URL` se setează la URL-ul public REAL** (cu `https://`, fără slash final): Better Auth acceptă doar originea din `APP_URL`, altfel autentificarea dă `INVALID_ORIGIN`. Wizard-ul îl cere și îl validează (și îl pune în `.env`)
- [ ] ⚠️ **Pachetul cu Caddy setează `auth.trustedProxyHops=1` în configurația implicită** (seed/instalator). Fără asta, IP-ul clientului nu e citit și limita de login/înregistrare rămâne doar pe email
- [ ] ⚠️ **Redis din pachetul de producție cu persistență (AOF)** (`appendonly yes`): blocările de cont și limitele stau în Redis și nu trebuie să se piardă la repornire
- [ ] Checklist de onboarding în dashboard
- [ ] Editor de temă în admin cu preview live
- [ ] CSS custom + scripturi custom din setări
- [ ] **Audit de neutralitate**: parcurge checklist-ul din `08` §6, linie cu linie

## FAZA 19 — Extensii și actualizări · ~4-5 zile 🔑
- [ ] Registry de hooks (`on`, `filter`) în `packages/extensions`
- [ ] Folder `/extensions` încărcat la boot, exclus din update
- [ ] Override de componente prin registry
- [ ] Blocuri CMS custom din extensii
- [ ] Versionare semantică + versiune în DB
- [ ] `update.sh`: backup → pull → migrații → health check → rollback automat la eșec
- [ ] Pagina „Sistem → Actualizări" cu versiune, changelog, istoric
- [ ] Verificare checksum pe core (detectează modificări neautorizate)
- [ ] CI care testează update-ul de la fiecare versiune minoră anterioară

## FAZA 20 — Rapoarte, performanță, hardening · ~5 zile
- [ ] Dashboard cu KPI reali + grafice
- [ ] Rapoarte: vânzări, stoc, retururi, cupoane, TVA, clienți, **vânzări per grup**
- [ ] Export XLSX/CSV + rapoarte programate pe email
- [ ] Jurnal de audit + panou de cozi cu retry manual
- [ ] Audit Lighthouse mobil (țintă ≥90) + analiză de bundle
- [ ] Headers de securitate (verifică pe securityheaders.com)
- [ ] 2FA pentru admini
- [ ] Test de încărcare k6 pe PDP și checkout
- [ ] Audit de accesibilitate cu axe

## FAZA 21 — Împachetare și distribuție · ~4-5 zile 🔑
- [ ] ⚠️ **Audit în aceeași tranzacție cu modificarea**, acolo unde datele sunt în Postgres: acum auditul și scrierea sunt stores separate (la eșecul auditului, modificarea rămâne, iar apelantul primește `AUDIT_WRITE_FAILED`). Servicii cu `tx` comun sau outbox; integrări cu stare externă rămân best-effort, cu alertă
- [ ] Dockerfile multi-stage cu `output: 'standalone'` (app + worker separat)
- [ ] `docker-compose.prod.yml`: app, worker, postgres, redis, caddy
- [ ] Caddyfile cu SSL automat, HTTP/2, compresie, headers
- [ ] `install.sh`, `update.sh`, `backup.sh` testate pe un VPS curat
- [ ] ⚠️ **`packages/core/scripts/seed-store.ts` (seed specific magazinului) și `dev-apply-preset.ts` NU intră în pachetul distribuit**: se mută în instalarea magazinului (sau în `/extensions`) înainte de împachetare
- [ ] ⚠️ **Runbook: utilizator de DB al aplicației FĂRĂ drept de `UPDATE`/`DELETE`/`TRUNCATE` pe `audit_log`** (nu owner al tabelei). Triggerul din migrație nu oprește owner-ul/superuserul; migrațiile rulează cu alt utilizator decât aplicația
- [ ] ⚠️ **Autentificare în doi pași (TOTP) pentru conturile admin** (nu e în Promptul 3; decizie utilizator)
- [ ] ⚠️ **Runbook: `auth.trustedProxyHops=1` când aplicația stă în spatele Caddy** (verifică în Setări; `0` = limita de IP e oprită) și **Redis cu AOF activ** (`appendonly yes`, volum persistent), pentru blocările de cont și limite
- [ ] Backup zilnic off-site + **restore testat**
- [ ] Uptime monitoring + alerte
- [ ] Documentația de livrat: README, MANUAL-ADMIN, CHANGELOG, RUNBOOK, EXTENSIONS, LEGAL
- [ ] **Instalare de la zero pe un VPS gol, cronometrată** — țintă sub 15 minute
- [ ] Mediu de staging identic cu producția

## FAZA 22 — Testare finală și lansare · ~4-5 zile
- [ ] E2E complet: guest cu ramburs · logat cu card sandbox · client partener cu discount · cu cupon · retur · admin creează produs → apare în storefront · AWB + factură
 unitare: pricing, TVA, promoții, discount de grup, transport, state machines, stoc
 de concurență și de idempotență
- [ ] **Comandă reală** cu card real → livrare → retur → rambursare
- [ ] Verificare emailuri (SPF/DKIM/DMARC, nu ajung în spam)
- [ ] Checklist legal complet din `05-integrari-romania.md` §9
- [ ] ⚠️ **Pentru avocat:** `audit_log.actorLabel` conține emailul unei persoane, iar jurnalul nu se poate șterge (trigger în DB). Verifică compatibilitatea cu dreptul la ștergere din GDPR (temei legal, termen de păstrare, anonimizare, ce se răspunde la o cerere de ștergere) și documentează decizia în politica de confidențialitate
- [ ] Verificare cu contabilul: TVA, facturi, e-Factura, proforme
 pe iOS Safari, Android Chrome, desktop
- [ ] Search Console + sitemap + Merchant Center
- [ ] Instruirea clientului + video de onboarding
- [ ] Plan de rollback

## FAZA 22b — eMAG Marketplace · ~8-12 zile (după lansarea magazinului propriu)
- [ ] Client API eMAG cu rate limiting, retry și IP fix confirmat
- [ ] Mapare categorii + caracteristici obligatorii, cu UI în admin
- [ ] Publicare oferte: atașare pe `part_number_key` sau documentație de produs nouă
- [ ] Sincronizare stoc și preț (la eveniment + cron de siguranță), cu tampon configurabil
- [ ] Validare de siguranță: refuză sincronizarea dacă prețul scade cu peste X%
- [ ] Import comenzi la 5 minute + confirmare automată
- [ ] Mapare de statusuri în ambele sensuri
- [ ] Generare AWB și comunicare către eMAG
- [ ] Încărcare automată a facturii după emitere
- [ ] Import și procesare retururi
- [ ] Ecran „Canale" în admin: status oferte, erori de validare, log de sincronizare
- [ ] Raport: vânzări pe canal, comisioane
- [ ] ⚠️ Citește documentația oficială eMAG la momentul implementării — se schimbă

## FAZA 23 — Post-lansare (continuu)
- [ ] Monitorizare zilnică: Sentry, plăți eșuate, joburi blocate, AWB-uri neconfirmate
- [ ] Analiză funnel de checkout
- [ ] Actualizări de securitate lunare
- [ ] Verificare backup lunară
- [ ] Feedback clienți → backlog
- [ ] Primul client real → învățăminte → v1.1

---

## ⚠️ Strategie de ordonare — citește asta

**Primul magazin lansat e al tău.** Asta schimbă ordinea optimă:

```
ETAPA 1 — Magazinul tău, funcțional și lansat
  Fazele 0-17 (fără 18, 19, 21)
  ~85-100 zile → ai un magazin real, care vinde, cu clienți reali

ETAPA 2 — Transformarea în produs
  Fazele 18, 19, 21: instalator, extensii, împachetare
  ~12-14 zile → abia acum devine un pachet vandabil

ETAPA 3 — Extindere
  Faza 22b: eMAG Marketplace
  ~8-12 zile
```

**De ce în ordinea asta:** un magazin care vinde e o bază infinit mai bună de produs decât unul teoretic. Vei descoperi în primele 2 luni de operare zeci de lucruri pe care nici tu, nici eu nu le anticipăm acum — și e mult mai ieftin să le repari într-o instalare decât în douăzeci.

**Ce faci totuși din prima**, chiar dacă instalatorul vine mai târziu:
- ✅ Zero hardcodare — toate setările în DB, din Faza 2. Fără asta, Etapa 2 devine rescriere.
- ✅ Tabelele de canal pentru eMAG, din Faza 4 (`12` §5)
- ✅ Feature flags, din Faza 2
- ✅ Migrații curate și versionate, din Faza 1

Astea patru sunt „taxa" pe care o plătești acum ca să nu rescrii nimic mai târziu. Restul poate aștepta.

## Estimare

| | Zile de lucru |
|---|---|
| **MVP vandabil, produse fizice** (Fazele 0-15) | ~70-82 |
| + Produse digitale (Faza 14b) | inclus mai sus |
| + Pachet distribuibil (Fazele 18, 19, 21) | +14-16 |
| + CMS, marketing, SEO, rapoarte (Fazele 16, 17, 20) | +17-20 |
| **Complet, fără eMAG** | **~101-118** |
| + eMAG Marketplace (Faza 22b) | +8-12 |
| **Total** | **~109-130** |

Sugestia mea: lansează magazinul propriu (Fazele 0-17) pentru **un client real**, încasează, apoi adaugă instalatorul și eMAG. eMAG nu are sens înainte ca magazinul tău să funcționeze impecabil — penalizările lor sunt reale.
