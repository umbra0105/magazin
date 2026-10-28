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

> **Stare:** FAZA 4 TERMINATĂ ȘI VERIFICATĂ (🏁 confirmată de utilizator la 2026-10-21 după parcurgerea integrală a ghidului, fără observații; CI verde pe `445627b`). Verificare manuală: `docs/FAZA-4-verificare-manuala.md` (tabel bifat OK). Revizuirea de securitate (Blocul C): `docs/FAZA-4-bloc-C-constatari.md`, cu starea finală a fiecărei constatări. Datoriile rămase sunt trecute, cu fază și motiv, în fazele 7, 18, 20 și 21 de mai jos; **C-18 (istoric de preț Omnibus) are eticheta «înainte de lansare»** și e legată de întrebarea către contabil/avocat. Tag: `faza-4-completa`.

> **Plan aprobat de utilizator (Promptul 5).** Numerotarea de mai jos e cea din plan; un commit per punct. Propunere de `git push` (doar la cererea utilizatorului) după punctele 2, 6, 10 și 14.
> **Decizii (utilizator):** `products.content.write` pentru Editor, Manager, Admin, Owner (descriere, SEO, media, documente; serverul respinge câmpurile de preț/stoc/cost, cu test explicit; matricea din `docs/04` §6 se actualizează la punctul 7) · `shippingClass` = `standard` / `oversized` / `pallet` (fără `requiresPalletDelivery`; regulile de preț și curier pe clase la Faza 12) · `ean` și `warrantyMonths` pe VARIANTĂ, cu editare comodă pe produs când are o singură variantă · migrarea e din **WordPress/WooCommerce** (nu OpenCart) · `legacyId`/`legacyUrl` pe produse, categorii, branduri (redirecționări 301 în Faza 17) · `PriceHistory` proiectat pentru „cel mai mic preț din ultimele 30 de zile” (Omnibus), cu test pe calcul.

- [x] (0) Curățarea conturilor `e2e-*` la ÎNCEPUTUL rulării (E2E și integrare, cu garda de bază de test) + măsurarea RSS a serverului de test pe parcursul suitei (script mic, fără modificări în aplicație). Build de producție pentru E2E doar dacă măsurarea arată o problemă reală
- [x] (0b) E2E pe build de producție (`next build` + `next start`, `NEXT_DIST_DIR` separat, port propriu), același mod local și în CI; `workers: 2` local rămâne. Măsurare RSS înainte/după (vârf, durata build-ului)
- [x] (1) Schema `Product`, `ProductVariant`, `ProductMedia` + `Brand`, `Category`, `ProductCategory`, `CostPriceHistory`, `PriceHistory` și migrația `catalog_core` (`shippingClass` cu 3 valori, `legacyId`/`legacyUrl` pe produse/categorii/branduri, `costPrice`/`costPriceDate` pe variantă, constrângeri CHECK, indecși parțiali, FK `Restrict` spre `Media`); `lowestPriceInWindow` (Omnibus) cu teste. **Mutat aici din punctele 3 și 6** (cerere utilizator): `Brand`, `Category`, `ProductCategory`, `PriceHistory`, `legacyId`/`legacyUrl` pe categorii și branduri, câmpurile și tabela de cost
- [x] (2) ⚠️ **Provider de utilizare media pentru produse (cerință explicită, cu test):** `ProductMediaUsageProvider` (`MediaUsageProvider` din `@ecom/core`, înregistrat prin `getMediaUsageRegistry()`) care raportează, pentru fiecare fișier, produsele și variantele care îl referă prin `ProductMedia`. **Înregistrarea se face înaintea oricărei funcții care permite produselor să refere fișiere din bibliotecă** (selector, import CSV cu imagini prin URL). Test obligatoriu: un fișier folosit de un produs nu se poate șterge (refuz cu lista produselor, cu link spre produs), iar după ce e scos din produs se poate șterge; și un test care pică dacă `ProductMedia` există, dar providerul nu e înregistrat
- [x] (3) Schema restului catalogului (migrația `catalog_options_attributes`): `ProductOption`/`OptionValue`/`VariantOptionValue` (chei compuse: varianta, opțiunea și valoarea sunt ale aceluiași produs, o valoare per opțiune), `Collection`/`CollectionProduct`, `Attribute`/`AttributeOption`/`AttributeValue` (numerice exacte cu unitate, filtrabile pe interval; trigger tip valoare = tip atribut), `ProductRelation` (6 tipuri, fără auto-relație), `TaxClass`/`TaxRate` + `Product.taxClassId` (pregătite, neexpuse, nu schimbă calculul; **decizie utilizator: cota produselor = `tax.standardRate`**). (`Brand`, `Category`, `ProductCategory`, `PriceHistory`, `excludeFromGroupDiscount` și `legacyId`/`legacyUrl` sunt în punctul 1)
- [x] (4) Câmpuri de nișă și pregătitoare (migrația `catalog_documents_gpsr`; `weight`/`dimensions`/`shippingClass`/`requiresInstallation`/`brandId` sunt deja din punctul 1): `ProductDocument` (tipuri generice, fișier în storage, `showInTab`), `energyClass` + `eprelUrl`, `PartsDiagram` (imagine din bibliotecă, cu `PartsDiagramMediaUsageProvider` și intrare în `MEDIA_REFERENCING_MODELS`) + `PartsDiagramProduct` + `PartsDiagramHotspot` (poziție opțională), GPSR (producător, persoană responsabilă UE, avertismente), `manufacturerPartNumber`/`manufacturerName` pe variantă, `expectedRestockDate`/`allowBackorder`. **`Order.parentSubscriptionId` se mută la Faza 9** (tabela `Order` nu există încă)
- [x] (5) Tabelele de canal (migrația `sales_channels`): `SalesChannel` (cod, `isSystem`, `requiresEan`/`requiresBrand`, `config` nesecret), `ChannelListing` (ofertă per variantă și canal: preț/promoție/stoc ale canalului, stare, erori de validare, sincronizare; FK compus variantă-produs), `ChannelCategoryMapping`; canalul `web` creat de seed (nu se șterge, trigger); interfața `ChannelProvider` (schelet, în `@ecom/core`, fără implementare); **regula de publicare** `validateForPublication`: EAN-ul și brandul sunt obligatorii DOAR la publicarea pe un canal care le cere (`requiresEan`/`requiresBrand`), nu în catalog. **`Order.channelId`/`externalId`/`externalData` se mută la Faza 9** (tabela `Order` nu există încă)
- [x] (6) **Confidențialitatea costului** (coloanele și `CostPriceHistory` sunt din punctul 1; fără migrație nouă): `CostPriceService` (`setCost` cere `cost.edit` ȘI `cost.view`; istoric; „cel mai recent preț de intrare”; răspuns fără valori), `projectVariantForAdmin` (câmp ABSENT fără `view`), `toPublicVariant` (listă albă), mascare în logger la 6 niveluri + orice nume cu `costPrice`/`costNet`, audit și loguri fără valori. **Test de arhitectură** (`cost-exposure.architecture.test.ts`): pică dacă o suprafață publică (storefront, API public, componente partajate, `packages/ui`, `packages/emails`), o componentă `"use client"` sau un fișier neautorizat atinge costul. Importul NIR (Faza 15) trece prin același serviciu, cu `source: import`
- [x] (7) ⚠️ **Permisiune separată pentru conținutul produsului:** `products.content.write` (Editor, Manager, Admin, Owner; `products.write` o include) pentru titlu, subtitlu, descriere, slug, SEO, media și documente; `ProductUpdateGuard` respinge pe server (deny-by-default, cerere mixtă respinsă întreagă, 403 `AUTH_FORBIDDEN` cu numele câmpurilor, audit `denied` fără valori) preț, preț redus și fereastra, stoc, cost, clasă de livrare, TVA și orice alt câmp; matricea din `docs/04` §6 regenerată (testul o compară cu catalogul); test de arhitectură: orice acțiune/rută care modifică produse trece prin `withPermission("products.*")`. **Seed-ul adaugă permisiunea pe rolurile existente:** `npm.cmd run db:seed`; fără migrație
- [x] (8) Servicii în `packages/core/catalog`: `slugify` (diacritice RO) + adresă unică cu sufix, verificată și cu produsele ȘTERSE (mesaj clar la conflict; indexul din bază devine unic pe toate rândurile, migrația `product_slug_unique_all`), generator de variante (produs cartezian cu limite, SKU-uri unice, plan de sincronizare fără ștergeri), scheme Zod stricte (costul nu e în ele), `ProductService` (creare, modificare prin `ProductUpdateGuard`, variante cu `PriceHistory`, generare de variante), audit cu diferențe, invalidare de cache prin callback. **Costul trece doar prin `CostPriceService`** (punctul 6)
- [x] (9) Admin: categorii (arbore cu glisare nativă + alternativă de tastatură, imagine, SEO) și branduri (CRUD, logo), `/admin/categorii` și `/admin/branduri`. Migrația `category_brand_media` (`imageMediaId`, `logoMediaId`, FK `Restrict`), `CategoryMediaUsageProvider` și `BrandMediaUsageProvider` + intrările din `MEDIA_REFERENCING_MODELS`; `CategoryService`/`BrandService` (mutare validată: cicluri, auto-părinte, adâncime max 4, adresă unică între frați; ștergere refuzată cu numărul de produse/subcategorii); permisiuni: conținut `products.content.write`, structură `products.write`, legacy `catalog.legacy.edit` (nouă: Admin și Owner); editorul de produs arată relațiile din ambele părți (la punctul 11)
- [x] (10) Admin: listă de produse (`/admin/produse`): căutare după titlu/SKU/EAN/cod producător, filtre (categorie cu subcategorii, brand, stare, clasă de livrare, stoc), sortare, paginare pe server (25/50/100), doar `thumb`; editare inline (titlu, stare, stoc, preț la produse cu o variantă) și în masă (stare, clasă de livrare, stoc, brand, adăugare în categorie, preț ±%; max. 50 per cerere, confirmare explicită, tranzacție unică, audit agregat cu id-uri) prin `ProductService`/`ProductUpdateGuard`; **fără cost nicăieri** (listă, URL, props client, editare în masă); script de dezvoltare `npm run dev:seed-products` (~30 de produse fictive cu imagini generate). Fără migrație
- [x] (11a) Admin: crearea și editarea produsului — taburile General, Prețuri, Stoc, Categorii, Media, SEO (aprobat: împărțit 11a/11b/11c; punctul (12) e absorbit aici; documentele cu endpoint propriu, GPSR/energie și fișa explodată în 11c; variante, atribute cu pagina `/admin/atribute` și relații în 11b). Restul textului punctului (11) de mai jos rămâne cerința
- [x] (11b) Admin: variante (opțiuni, generator cu plan de sincronizare fără ștergeri tăcute, tabel cu editare în rând, ștergere explicită), atribute (`AttributeService`, pagina `/admin/atribute`, tabul Atribute cu valori numerice exacte), relații între produse (tabul Asociate, 6 tipuri, ambele părți). Toate cer `products.write`; fără migrație
- [x] (11c) Admin: documente de produs (endpoint propriu de încărcare: Origin, sesiune, `products.content.write`, rate limit, limită pe flux, tip real din octeți, refuz PDF cu conținut activ, cheie generată de server, audit; descărcare cu link semnat; `list(prefix)` pe storage și `docs:sweep-orphans`) și tabul Conformitate (GPSR, clasă energetică, EPREL, sub `products.write`). Fișa explodată trece în 11d (cu flag-ul `partsDiagrams`). Fără migrație
- [x] (11d) Admin: fișa explodată pentru piese de schimb, în spatele flag-ului `partsDiagrams` (meniu, rută 404, serviciu): `PartsDiagramService`, pagina `/admin/fise-explodate` (listă, creare, editare cu hotspot-uri accesibile: procente cu 2 zecimale = basis points, săgeți, click, câmpuri numerice), tabul „Piese de schimb” pe produs, imagine din bibliotecă (ștergere refuzată cu fișa ca loc de folosire); migrație: `PartsDiagramHotspot.productId` nullable cu `ON DELETE SET NULL`. Înainte: test E2E pentru imagine de 10–20 MB în media (commit separat)
- [x] (11) *(făcut în 11a–11d, confirmate separat)* Admin: editor de produs pe taburi (General, Prețuri, Variante, Stoc, Atribute, Categorii, SEO, GPSR, Asociate, Documente); generator de variante din opțiuni cu editare în tabel; `ean`/`warrantyMonths` editabile direct pe produs când are o singură variantă; câmpurile de cost în tab-ul „Prețuri”, doar cu permisiune. **Regulă la activarea produsului (serviciu):** garanția are valoare implicită dintr-o setare a magazinului (fără hardcodare; setare nouă în registrul de setări, editabilă din admin); EAN-ul și brandul NU sunt obligatorii pentru activare (storefront-ul nu afișează nimic dacă lipsește brandul). **Încărcarea documentelor** (PDF/imagini): endpoint propriu cu sesiune, `products.content.write`, Origin, rate limit, audit, tipul real din octeți (nu doar din antet), limită de mărime din setări, nume randomizate; fișierul se șterge din storage odată cu rândul. **Costul în tab-ul „Prețuri”:** câmpul se randează dintr-o componentă de SERVER (input cu `defaultValue`) și se salvează printr-o server action; componentele client nu primesc costul (testul de arhitectură din punctul 6 o impune). Fără `products.cost.view`, câmpul și istoricul lipsesc din pagină. **Probă obligatorie la primele acțiuni de produs:** testul de arhitectură `product-write-guard` trebuie să devină activ pe sursa reală; se verifică explicit cu o acțiune de test NEÎNVELITĂ în `withPermission` (trebuie să pice testul), apoi se scoate, iar rezultatul probei se raportează utilizatorului
- [x] (12) *(absorbit și făcut în 11a, confirmat)* Tab-ul Media cu `MediaPicker` (primul consumator real; abia după punctul 2) 
- [x] (13) Duplicare, arhivare, soft delete
- [x] (14) Import/export generic CSV + XLSX *(împărțit și făcut în (14a) import și (14b) export, confirmate separat)*
- [x] (14a) Import generic CSV + XLSX (împărțit din (14), aprobat): încărcare (endpoint propriu: Origin, sesiune, `products.write`, rate limit, limită pe flux), mapare de coloane, dry-run fără modificări în catalog, raport pe rând (nou / actualizat / neschimbat / ignorat / eroare, în română) descărcabil ca CSV, aplicare legată de hash-ul fișierului (sincron până la un prag, job BullMQ cu progres peste), upsert pe SKU, șablon CSV + XLSX generat din aceeași definiție a câmpurilor. Prețul de achiziție NU se importă (coloană mapată de cost = refuz). Imaginile prin URL rămân la (15). Un singur eveniment de audit `product.import`. O migrație (`ProductImport`)
- [x] (14b) Export CSV + XLSX al produselor: **exportul nu conține prețul de achiziție** (nici coloană goală, nici în mapări): trece prin aceeași proiecție ca lista de produse; test dedicat, ca la lista din punctul 10 (costul intră în export doar ca opțiune explicită, cu `products.cost.view`, într-un punct separat, dacă se cere vreodată). Același format ca șablonul de import (se poate reimporta)
- [x] (15a) Profil de import WooCommerce, FĂRĂ imagini (împărțit din (15), aprobat; imaginile se ignoră cu avertisment ca la 14a), peste importul generic din (14a): vezi detaliile din (15) de mai jos
- [x] (15a+) **Istoric de importuri** (cerut de utilizator după 15a): pagină cu importurile aplicate (data, utilizatorul, fișierul, profilul, starea, contoare), detalii cu raportul pe rânduri (filtru pe rezultat, CSV prin funcția comună), retenția detaliului (setare, implicit 180 de zile; sumarul rămâne), importuri întrerupte vizibile, filă „Exporturi” din auditul `product.export`
- [x] (15b) Import de imagini prin URL, cu protecția SSRF (împărțit din (15), mesaj separat): descărcare sigură (`safeFetchImage`, singura cale în rețea, cu test de arhitectură), listă de domenii permise ca setare de securitate, IP public verificat înainte de conectare și conexiune fixată pe el, redirecturi revalidate, limite, conținut decis din octeți; dry-run fără rețea; descărcare în fundal (BullMQ), idempotentă, cu progres și reluare
- [x] (15) *(descrierea originală, acoperită de 15a, 15a+ și 15b, toate confirmate)* ⚠️ **Profil de import WooCommerce** (peste formatul generic) pentru migrarea celor ~500 de produse: CSV standard de export (Type simple/variable/variation, Parent, SKU, Name, Description, Regular price, Sale price, Categories ierarhice, Tags, Images ca URL-uri, atribute), prețuri cu sau fără TVA (conversie cu cota din setări), creare automată de categorii și branduri, atribute din coloane dinamice, date murdare, import repetabil fără duplicate, reluabil, `legacyId`/`legacyUrl`. **Import de imagini prin URL cu protecție SSRF obligatorie:** doar https, listă de domenii permise configurabilă, refuz pentru adrese private/locale/metadata, limită de redirecționări, limită de mărime și tip, același pipeline de validare ca la upload (tip real din octeți, re-codificare, variante prin queue); test pentru fiecare refuz. Eșantionul real de 20 de produse vine de la utilizator înainte de acest punct
- [ ] (15c) **Descriere bogată** (HTML sanitizat, editor, randare în storefront), **înainte de Faza 6**; apoi reimport al descrierilor din exportul WooCommerce original cu profilul WooCommerce (în 15a descrierile se reduc la text simplu, tabelele devin linii «Etichetă: valoare»)
- [x] (16) E2E, verificare manuală cap-coadă (`docs/FAZA-4-verificare-manuala.md`) și închiderea fazei (TODO, PROGRESS)

## FAZA 5 — Stoc · ~9-11 zile

> **Plan aprobat de utilizator** (`docs/FAZA-5-plan.md`, versiunea a patra; deciziile D1–D6 și D11 și răspunsurile utilizatorului în `docs/PROGRESS.md`, intrarea din 2026-10-21). Numerotarea de mai jos e cea din plan; un commit per punct; teste care pică întâi; concurența intră din punctul 5. Estimarea inițială (~3 zile) era înainte de D1 (SmartBill), D6 (La comandă) și D11 (unități și cantități zecimale).
> **Decizii (rezumat):** SmartBill = sursa cantității fizice, aplicația ține «angajat» și «rezervat» (D1) · inventarul îl face utilizatorul, până atunci produsele sunt negestionate (D2) · o singură locație «Depozit principal» (D3) · card 15 min, ramburs imediat, transfer bancar 3 zile lucrătoare, coșul nu rezervă (D4) · fără stoc negativ, în bază (D5) · patru stări vizibile, termen produs → brand → global, hibrid cu `allowBackorder` oprit, coșuri mixte «toată odată» (D6) · unități și cantități zecimale: `BIGINT` cu 4 zecimale, pas de vânzare pe produs/variantă, rest nevandabil ascuns clientului, R1/R2 **provizoriu** (D11) · «angajat» cu referință generică (tip + id) și unicitate, înlocuită cu FK în Faza 9 · `manageStock` implicit ON pentru produse noi, importurile setează `false`, migrare de date pentru produsele existente fără `InventoryItem`.
> **Întrebări către contabil:** `docs/INTREBARI-CONTABIL.md`; **către avocat:** `docs/INTREBARI-AVOCAT.md`. **Ce aduce utilizatorul:** exportul SmartBill «stoc la zi» (în `local-data/`, nu se comite) și unitățile SmartBill ale celor 6 produse-exemplu, înainte de punctul 12.

- [x] (1) **Schema și migrația** (singura migrație a fazei): `MeasureUnit`; pe produs `measureUnitId`, `priceBasis` (unitate / pas), `saleStep`, `minSteps`; pe variantă aceleași (nul = moștenește) + conversia SmartBill (aceeași unitate / pași / raport + numele unității); `Warehouse` («Depozit principal», redenumibil, creat de seed); `InventoryItem` (fizic + «valabil la», angajat, rezervat, prag în pași); `StockSnapshot`; `StockMovement` (imuabil, ora efectivă, motiv); `StockReservation`; **angajarea cu referință generică (tip + id) și unicitate** (aceeași comandă nu poate angaja de două ori aceeași variantă); `BackInStockAlert`; `Product.leadTimeDays`, `Brand.defaultLeadTimeDays`; toate cantitățile `BIGINT` în zecimi de miime; CHECK-uri (≥ 0, unic per variantă + depozit, `IS NULL` explicit + test «una setată, una nulă»); setările `inventory.*`; **migrare de date:** `manageStock = false` doar pentru produsele existente fără `InventoryItem` (produsele noi păstrează implicitul ON)
- [x] (2) **Cantități exacte:** modulul `Quantity` în `packages/shared` (`bigint`, citire/formatare cu virgulă, multiplu de pas, număr de pași, plafoane, erori tipate), primitiva exactă preț × cantitate fără regulă de rotunjire; teste numerice cu cele 6 produse (3 × 2,03 = 6,09 …), multipli / nemultipli, referință cu fracții exacte, depășiri; test de arhitectură «nicio cantitate ca număr zecimal»
- [x] (3) **Unități, pas și configurare:** pagina «Unități de măsură» (listă, creare, editare, dezactivare, nume SmartBill, zecimale); în editorul de produs unitate, baza prețului, pas, minim; pasul pe fiecare variantă (moștenire din produs); **«buc» (unitatea nulă) nu se dezactivează, nu își schimbă codul și rămâne cu 0 zecimale, validat în serviciu, cu test**; validarea «orice comandă valabilă se convertește exact către SmartBill»; mesaje în română
- [x] (4) **Disponibilitatea și stările** (modul pur): trei ramuri explicite (negestionat / «La comandă» cu termen produs → brand → global / gestionat: Fizică − Angajat − Rezervat, disponibil în pași, rest nevandabil, hibrid); digitalele mereu disponibile; teste pe tabel de stări
- [x] (5) **Rezervare / eliberare / angajare / oglindire** în multipli de pas: o singură comandă condiționată + blocare de rând + CHECK; idempotente; expirare și la citire; linii în ordine fixă; regula D1 (angajat vs oglindit). **Teste de concurență pe Postgres real aici:** 10 cereri / stoc 1, 100 / stoc 10, 10 × 0,3 pe 1,0 → exact 3, liner 5 cereri pe 100 mp → exact 2, webhook dublu, confirmare vs expirare, coș cu linii gestionate + negestionate + «la comandă», cursa poză vs factură, aceeași comandă angajată de două ori
- [x] (6) **Ajustări cu ora efectivă:** precizia unității, motive fixe (D8), «Vânzare în magazin», refuz sub 0, regula «sincronizarea SmartBill înlocuiește ajustările dinainte»
- [x] (7) **Joburi:** eliberarea rezervărilor expirate; transfer bancar cu expirare în zile lucrătoare; verificarea «sincronizarea e prea veche» (în interfață: «Neactualizat»); curățarea vechilor `BackInStockAlert`
- [x] (8) **Admin `/admin/stoc`:** pe variantă Fizică (valabilă la …), Angajat, Rezervat, Disponibil (în unitate și în pași), Rest nevandabil; ajustări cu motiv, istoric, `inventory.*`, audit, dialoguri proprii în română. Ajustările apelează `StockAdjustmentService` (punctul 6): motivele cu etichetele din `ADJUSTMENT_REASON_LABELS`, cantitatea ca text cu semn, ora efectivă editabilă, iar avertismentele `effective_before_snapshot` și `below_commitments` se afișează în română
- [x] (8b) **Regruparea navigației din administrare** (interfață, decisă de utilizator; fără migrație, fără schimbare de funcționalitate): o singură intrare «Produse» în meniu, cu bară de taburi (Toate produsele, Categorii, Branduri, Atribute, Unități de măsură, Fișe explodate, Stoc); adresele sub `/admin/produse/…`, cele vechi redirecționează permanent (308) cu parametrii păstrați; taburile apar după permisiune (și flag); editorul de produs rămâne pagină întreagă; convenția în `CLAUDE.md` și `docs/04`; **punctele 9–13 construiesc ecranele noi direct în această structură**
- [x] (8c, confirmat de utilizator; push cu `6164d72`) **Meniul «Catalog» ca grup care se deschide și se închide** (interfață, cerută de utilizator; fără migrație, fără schimbare de adrese): grupul «Catalog» în meniul din stânga (săgeată), cu sub-elementele Produse (fostul «Toate produsele»), Categorii, Branduri, Atribute, Unități de măsură, Fișe explodate (doar cu flag-ul `partsDiagrams`), Stoc; **bara de taburi din «Produse» dispare**, iar dosarul `(tabs)` se desființează (paginile urcă un nivel, adresele rămân). Fiecare element apare doar cu dreptul lui, grupul dispare dacă nu are niciun element vizibil, se deschide singur pe paginile lui cu elementul curent evidențiat, editorul de produs ține «Produse» evidențiat, merge pe telefon. Logica de grup e generică (`children` pe intrare), reutilizabilă la Comenzi, Clienți etc.; aplicată acum doar la Catalog. «Media» rămâne separat. Adresele și redirecturile 308 rămân neschimbate
- [x] (9a) **Tabul Stoc din produs, brand și listă** (împărțit de utilizator; cere migrație): migrația `Product.saleStepLabel` (1–30 de caractere, CHECK cu `IS NULL`/`IS NOT NULL`), tabul «Stoc» din editor (bifa «Gestionează stocul», «negestionat până la inventar», disponibilitate, hibrid, termen de livrare, tabel pe variante cu suprascrieri, ajustare/istoric/«Deschide în Stoc»), «Denumirea pasului» în tabul «Unitate și pas», termenul implicit «La comandă» pe brand (dialog și coloană), coloana «Stoc» din «Toate produsele»
- [x] (9b, confirmat de utilizator; push cu `6200985` + corecția CSV `41dbc6e`) **Afișarea prețului și import/export:** prețul pe unitate și pe pas (funcție pură, marcată provizoriu; «≈» doar text informativ, suma exactă rotunjită la 2 zecimale, FĂRĂ regulă de rotunjire; dacă apare o decizie de rotunjire, 🛑), coloana «Preț» din listă și previzualizarea din tabul Prețuri, coloane noi în import/export (CSV doar prin funcția comună, virgulă zecimală, pas în Excel): Unitate de măsură, Baza prețului, Pas de vânzare, Minim (pași), Denumire pas, conversia SmartBill, Stare stoc (doar la negestionate), Termen livrare; regula de import: aceeași valoare la toate rândurile unui produs → pe produs, valori diferite → pe variantă
- [x] (9c, confirmat de utilizator; push cu `3411564`) **Corecție: ecranul Stoc nu mai aruncă `TypeError` când un produs dispare între interogări** (mică etapă, aprobată de utilizator; fără migrație): `loadSources` și `getSource` (`stock-overview-store.ts`) omit rândurile al căror produs lipsește (Prisma 7.10 execută `findMany`-ul imbricat ca 8 SELECT-uri separate, deci o relație obligatorie poate ajunge `null` după o ștergere definitivă între ele) și sar peste valorile de opțiune fără `option`/`value`; teste scrise întâi + probă de mutație; auditul aceluiași tipar în admin și core se raportează în ✅ GATA, fără reparații
- [x] (10a, confirmat de utilizator; push cu `cc4105c`) **Alerte, partea 1: prag pe variantă și lista «Stoc mic»** (fără migrație; coloana `lowStockSteps` și CHECK-ul ≥ 0 există din punctul 1): scriere nouă `setLowStockThreshold` (prag în pași, 0–1000 sau gol = setarea globală; doar variante gestionate; `inventory.write`; audit cu înainte/după), dialog «Prag stoc mic»; **«Stoc mic» e o vedere în aceeași pagină Stoc** (decizia utilizatorului: meniul Catalog rămâne cu cele 7 elemente), la `?filtru=stoc-mic` (alias vechi `?mic=1`), care folosește filtrul existent «Doar stoc mic» în loc să-l dubleze: variantele gestionate la sau sub prag, cele mai urgente primele, cu motiv (epuizat / sub prag / doar rest nevandabil), prag și numărători; bannerul «poza e veche» rămâne cel din pagina Stoc
- [x] (10b, confirmat de utilizator; push cu `52634ed` și `ae0a171`) **Alerte, partea 2: contoare în Panou** (fără migrație; cere repornirea dev serverului; NU adaugă elemente în meniu): carduri «Stoc mic» (toate variantele la sau sub prag), «Doar rest nevandabil» și «Neactualizat» (Sincronizare SmartBill) în Panou, doar cu `inventory.read` (fără acces, nici măcar interogarea nu rulează), cu legături spre vederea existentă din pagina Stoc (`?filtru=stoc-mic`; pentru rest, același filtru + `motiv=rest-nevandabil`, filtru nou pe motiv, pornit și din cardurile de numărători ale vederii); serviciu nou `StockOverviewService.alerts`; E2E cu mutarea înapoi a orei ultimei sincronizări (în `stock.spec.ts`, care deține starea pozei); capturi desktop și telefon
- [x] (11) **«Anunță-mă când revine»** (server): cerere, trimitere o singură dată, ștergerea adresei. Împărțit în două sub-etape, fiecare cu commit propriu (fără migrație; formularul și ruta publică sunt în Faza 7):
  - [x] (11a) **Serviciul din core:** `subscribe` (răspuns neutru, idempotent, plafoane pe adresă și pe variantă), selecția cererilor ale căror variante au revenit în stoc (disponibil ≥ 1 pas și ≥ minim; negestionat: «în stoc»), `claim` / `release` / `complete`; teste de concurență pe Postgres real
  - [x] (11b, confirmat de utilizator; push cu `9244914` și `285a504`) **Trimiterea:** tip nou de email în coadă (payload sigilat cu DOAR `alertId`: adresa nu ajunge în Redis), șablon, procesorul face `claim` atomic, trimite și șterge adresa; job `stock-back-in-stock` la 60 de secunde; probă în Mailpit (un singur email) cu `dev:back-in-stock`
- [ ] (12) **Import «stoc la zi» din SmartBill:** șablon, «valabil la», separator zecimal explicit, conversie SmartBill → unitatea noastră (rotunjire în jos + avertisment), verificare fără modificări cu raport, aplicare toată-sau-deloc, istoricul pozelor, audit; `FileInput`; regula D2 în importul WooCommerce (negestionat, «în stoc», «buc»)
  - [x] (12a, confirmat de utilizator; push cu `b6b972e`) **Planul de import (modul pur în core):** setarea gestiunilor citite, tabelul de unități, citirea exactă a cantităților, potrivirea pe SKU, conversia SmartBill → unitatea noastră, raportul (necunoscute, duplicate, lipsă, unitate diferită, negestionate), fără parser și fără bază de date
  - [x] (12b, confirmat de utilizator; push cu `512fbd7`) **Cititorul de fișier .xls / .xlsx** (adaptor în `packages/integrations`; SheetJS 0.20.3 din `vendor/`, aprobat de utilizator)
  - [~] (12s) **Etapă de securitate între 12b și 12c (aprobată de utilizator, după «CI verde» pe 12b):** `next` 15.5.28 (RCE în optimizatorul de imagini cu SVG, DoS în Server Actions), `zod` 4.6.6, `nodemailer` 10.1.4, apoi un nou `pnpm audit` cu raportul avertismentelor dispărute. Un singur commit, fără cod nou; cere instalare cu rețea și repornirea dev serverului. Dacă se schimbă vreodată configurația imaginilor (`images` în `next.config.ts`, `next/image`), se adaugă verificarea răspunsului rutei `/_next/image`
  - [ ] (12c) **Serviciul și ecranul:** previzualizare fără modificări, aplicare toată-sau-deloc (`StockSnapshot` + `applySnapshot`), confirmarea explicită pentru «lipsă din fișier → 0», ora pozei, audit, istoricul pozelor; `FileInput`
  - [ ] (12d) **Regula D2 în importul WooCommerce** (negestionat, «în stoc», «buc») și închiderea punctului
- [ ] (13) **Multi-depozit în spatele comutatorului `multiWarehouse`:** CRUD depozite, selector, transfer; oprit = invizibil
- [ ] (14) **Închiderea fazei:** E2E, testul de concurență final în suită, acoperirea față de cerințe, `docs/FAZA-5-verificare-manuala.md` (cu cele 6 produse ca scenarii), lista «înainte de lansare» (D1.5) în TODO, adăugirile pentru Fazele 8, 9, 12, 13, 15, 22 (vezi `docs/FAZA-5-plan.md` §4), PROGRESS, `docs/04`/`docs/15`

## FAZA 6 — Design system și layout · ~4-5 zile
- [ ] ⚠️ **PRIMUL PAS, înainte de orice lucru pe design: skill-ul `frontend-design` pentru storefront (verificat împreună cu utilizatorul).** Utilizatorul aduce fișierul `SKILL.md`; îl citim INTEGRAL și verificăm că nu conține instrucțiuni care contrazic `CLAUDE.md` (accesibilitate, performanță, conversie, referințele UX alese de utilizator, regulile de securitate, fără culori sau texte hardcodate). Abia apoi îl punem în `.claude/skills/`, într-un commit separat. **Nu se rulează `npx claude-code-templates` sau alt instalator:** doar fișierul text, copiat și citit. Nu se instalează fără confirmarea explicită a utilizatorului
- [ ] ⚠️ **Tot înainte de Faza 6: utilizatorul alege cele 3–5 magazine de referință UX** (punctul din Faza 0, „Alege 3-5 magazine de referință UX”). Ele intră în verificarea skill-ului de mai sus (nu trebuie contrazise) și sunt baza deciziilor de design
- [ ] Design tokens în `Branding`, injectate server-side ca CSS variables
- [ ] 3 presets de temă (Minimal, Bold, Editorial)
- [ ] **Editor de temă Nivel 2**: culori, fonturi, radius, logo, favicon, OG, **variante de header și footer**, **layout de card de produs**, lățime container, dark mode, **CSS custom**, preview live
- [ ] Componente de bază în `packages/ui`, zero culori hardcodate
- [ ] Header (logo, mega menu, search, cont, wishlist, coș)
- [ ] Mobile nav drawer, footer configurabil cu ANPC/SAL și date firmă
- [ ] Announcement bar, 404, 500, mentenanță, skeletons

## FAZA 7 — Storefront catalog · ~7-9 zile
- [ ] ⚠️ **ÎNAINTE DE LANSARE — C-18: istoric de preț pentru Omnibus** (Blocul C, `docs/FAZA-4-bloc-C-constatari.md`). Tranzițiile programate (`saleStartsAt/saleEndsAt`) nu scriu punct de istoric, iar `PriceHistory` se scrie doar la salvarea din admin; `docs/04:650` planifică un snapshot zilnic, absent. Se face un job zilnic care scrie punctul de preț efectiv și calculează «cel mai mic preț din ultimele 30 de zile» pentru afișare. **Legat de o întrebare către contabil/avocat despre Omnibus** (ce se afișează exact, pentru ce reduceri, de la ce dată curge perioada de 30 de zile pentru produsele migrate din WooCommerce, fără istoric). Fără răspuns, afișarea reducerilor în storefront nu se lansează.
- [ ] (C-35) «Mută mai sus/jos» cu index absolut: mutarea poate cădea pe altă poziție dacă alt administrator adaugă/șterge un frate între timp. Propunere: `move` primește `beforeId`/`afterId` (față de un frate), nu un index. Se decide semantica înainte de implementare (Blocul C, `docs/FAZA-4-bloc-C-constatari.md`).
- [ ] (C-37) Worker-ul nu invalidează cache-ul (`revalidateTag` depinde de un tab de admin deschis); regenerarea media șterge imediat variantele vechi. Se tratează odată cu cache-ul vitrinei de mai sus (cheie Redis «versiune catalog» + ștergere întârziată) (Blocul C, `docs/FAZA-4-bloc-C-constatari.md`).
- [ ] (C-43) Slugul produsului e câmp de conținut (Editorul îl poate schimba), fără istoric de slug/redirecționări 301 — de rezolvat înainte de storefront: slug în `products.write` sau istoric de slug (Blocul C, `docs/FAZA-4-bloc-C-constatari.md`).
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
- [ ] ⚠️ **Decizia despre helperul `Money` și regula de rotunjire** (din Faza 5, punctul 2): `CLAUDE.md` nu mai pretinde un `Money` existent; aici se decide dacă se creează un helper de bani în `packages/shared` și se confirmă cu contabilul regula de rotunjire pe linie (R1 pe unitate / R2 pe pas, provizorie în `docs/PROGRESS.md`). Motorul primește cantitatea ca `Quantity` și folosește primitivele exacte din `packages/shared/src/quantity.ts` (`exactLineValue`, `exactStepsValue`, `splitScaledMoney`), cu `MAX_MONEY` ca plafon de linie; rotunjirea e o singură dată pe linie
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
- [ ] `Order.channelId` (implicit canalul `web`), `Order.externalId`, `Order.externalData` (JSON brut, pentru depanare), pregătite pentru eMAG (mutate din Faza 4, punctul 5; `12` §2)
- [ ] ⚠️ **Din Faza 5:** angajarea de stoc ține o referință generică (tip + id, cu unicitate) spre comandă, fiindcă `Order` nu exista. Aici se înlocuiește cu **cheie străină** spre `Order`/`OrderLine`, cu **validarea datelor existente** (referințe orfane) înainte de migrație, și testele de concurență din Faza 5 se rulează din nou pe schema nouă
- [ ] `Order.parentSubscriptionId` (câmp pregătitor pentru abonamente, nefolosit; mutat din Faza 4, punctul 4)
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
- [ ] ⚠️ **`STOCK_RESERVATION_LOST`** (Faza 5, punctul 5): plată confirmată după ce rezervarea a expirat și stocul s-a luat între timp (`StockService.confirmReservation` aruncă eroarea, nu supravinde). Tratare: **rambursare automată** a plății (prin `PaymentProvider`, idempotentă), comanda anulată cu `OrderEvent`, **mesaj către client** (emailul și pagina de comandă explică de ce, în română) și alertă pentru admin. Test: plată târzie fără stoc → rambursare o singură dată, chiar la webhook repetat
- [ ] ⚠️ **Rezervarea la inițierea plății** (Faza 5, punctul 7): termenul vine din `reservationExpiresAt(metodă, acum, setări)` (`packages/core/src/inventory/workdays.ts`): card = `inventory.reservationMinutes` minute, transfer bancar = sfârșitul celei de-a `inventory.transferReservationWorkdays`-a zile lucrătoare (fusul `regional.timezone`); ramburs nu rezervă, ci angajează direct. Expirarea o face jobul `stock-expire-reservations` (la 60 s), deci checkout-ul NU trebuie să elibereze singur rezervările expirate
- [ ] **Calendarul zilelor nelucrătoare** (Faza 5, punctul 7): «zile lucrătoare» înseamnă acum luni–vineri, fără sărbătorile legale. Adaugă o setare editabilă (`regional.nonWorkingDates`, lista de date) pe care `addWorkdaysEndOfDay` o sare, ca o rezervare prin transfer bancar să nu expire cu o zi mai devreme în jurul sărbătorilor

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
- [ ] **Alerta «sincronizarea SmartBill e neactualizată» pe email** (Faza 5, punctul 7): jobul `stock-snapshot-freshness` scrie deja în audit (`stock.snapshot.stale` / `stock.snapshot.recovered`, cu memento la 24 h); aici se adaugă trimiterea pe email către adminii cu `inventory.write`: destinatarii și șablonul se decid (utilizatorul activ, cu emailul verificat, REVERIFICAT la fiecare trimitere), prin coadă, o singură dată pe episod
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
- [ ] **Factura fără descărcare de gestiune** (răspuns contabil 2026-10-28: SmartBill refuză factura la stoc 0 dacă «descărcare gestiune» e activă): facturile pentru produse «La comandă» sau fără stoc se emit FĂRĂ descărcare de gestiune și NU se socotesc «oglindite» la regula poză + angajat (angajatul rămâne până la o poză care conține scăderea reală)
- [ ] **Cantitatea de pe factură are cel mult 2 zecimale** (SmartBill: 2 zecimale, rotunjire la cea mai apropiată cifră): verificare la configurarea pasului și a conversiilor SmartBill (un pas sau un raport care dă mai mult de 2 zecimale pe factură se refuză sau se avertizează); kg se facturează în kg, sacul ca bucată
- [ ] **Momentul facturii pentru «La comandă»** (răspuns contabil): la plată dacă a fost plătit, la expediere dacă se plătește la livrare (ramburs)

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
- [ ] 🟡 **Drepturile Depozitului pe elementele din Catalog** (decizie utilizator, blocul 8b: nu se schimbă modelul de drepturi acum; fostele «taburi din Produse», din 8c elemente ale grupului «Catalog»): Depozit vede acum toate elementele din Catalog; de decis dacă primește o permisiune separată pentru taxonomie (Categorii, Branduri, Atribute, Unități).
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
- [ ] **(C-02) Instalatorul setează `auth.trustedProxyHops`** (1 în spatele Caddy) și **avertisment în Setări** când pagina de setări există și valoarea e 0 în producție. Aplicația avertizează deja la pornire (log) și are limită globală de rezervă, dar în modul fără IP de încredere pragul de blocare e ×3 și blocarea e plafonată la 1 minut, deci rămâne un DoS limitat rezidual (Blocul C, `docs/FAZA-4-bloc-C-constatari.md`).
- [ ] **(C-02/C-40) Setările de autentificare din registru nu au UI de administrare** (`auth.registerMaxAttempts`, `auth.loginRatePerMinutePerIp`, `passwordResetMax*`, `verificationResend*`, `unverifiedAccountRetentionDays`, `import.stepMaxAttempts`…): se editează acum doar prin registru/seed; câmpurile apar în pagina de Setări când se construiește. Valoarea implicită `loginRatePerMinutePerIp = 120` poate limita un NAT mare (birou/CGNAT): de reevaluat la instalare.
- [ ] (C-20) Antete de securitate: CSP (cu nonce pentru scriptul de temă), `frame-ancestors`/`X-Frame-Options`, HSTS, `nosniff` global, Referrer-Policy; `GET /api/auth/error?...` afișează text controlat de atacator pe originea magazinului (Blocul C, `docs/FAZA-4-bloc-C-constatari.md`).
- [ ] (C-41) `settings.write` poate schimba orice cheie (inclusiv `auth.*`, `imageImport.allowedHosts`, `monitoring.sentryDsn`): permisiune separată `settings.security.write` când apare UI-ul de setări (Blocul C, `docs/FAZA-4-bloc-C-constatari.md`).
- [ ] Wizard `/install` complet (`08-instalare-si-distributie.md` §2)
- [ ] Notă: **tu faci instalările**, deci wizard-ul poate presupune un utilizator tehnic. Fără „prost-rezistență" extremă. Economie ~2-3 zile.
- [ ] Verificare cerințe, test conexiune DB, rulare migrații cu progres
- [ ] Generare `APP_KEY` + avertisment de păstrare
- [ ] Setare date firmă → propagate automat în footer, facturi, emailuri, pagini legale
- [ ] Creare cont administrator, alegere temă, upload logo
- [ ] Generare pagini legale + meniuri + date demo opționale
- [ ] ⚠️ **Storage de producție (decizie utilizator, de luat aici):** alege furnizorul (S3 la un furnizor, R2, MinIO propriu) și rulează `storage:init` pe bucketul real. Cerințe: politica de citire anonimă DOAR pe `public/*` (`storage:init` o aplică; dacă furnizorul are alt mecanism, se configurează acolo), `S3_PUBLIC_URL` = domeniul CDN/bucketului, antetul `X-Content-Type-Options: nosniff` setat la CDN (pe obiectele S3 nu se pot stoca antete arbitrare), `private/` fără acces anonim, test cu un fișier `private/` care nu se poate citi fără link semnat
- [ ] Blocare permanentă `/install` după instalare
- [ ] ⚠️ **Restricție de ieșire (egress) la nivel de infrastructură** (de la 15b, import de imagini din adrese): pe lângă verificările SSRF din aplicație (listă de domenii, IP public, conexiune fixată, redirecturi revalidate), serverul de producție trebuie să aibă firewall / grup de securitate / proxy de ieșire care permite doar traficul necesar (DNS, domeniile magazinului, furnizorii de plăți, curieri, SmartBill). Fără el, o eroare viitoare de cod ar putea deschide servicii interne. Documentat în pachetul de instalare
- [ ] ⚠️ **`APP_URL` se setează la URL-ul public REAL** (cu `https://`, fără slash final): Better Auth acceptă doar originea din `APP_URL`, altfel autentificarea dă `INVALID_ORIGIN`. Wizard-ul îl cere și îl validează (și îl pune în `.env`)
- [ ] ⚠️ **Pachetul cu Caddy setează `auth.trustedProxyHops=1` în configurația implicită** (seed/instalator). Fără asta, IP-ul clientului nu e citit și limita de login/înregistrare rămâne doar pe email
- [ ] ⚠️ **Redis din pachetul de producție cu persistență (AOF)** (`appendonly yes`): blocările de cont și limitele stau în Redis și nu trebuie să se piardă la repornire
- [ ] ⚠️ **Verifică CSV-urile din aplicație (UTF-16LE cu BOM, TAB) pe un PC cu separatorul de listă «;»** (Windows în română): nu s-a putut încerca, mașina de dezvoltare are «,». Rulează `scripts/excel-csv-probe.ps1` și deschide cu dublu-click un export și un șablon: coloanele separate ȘI diacriticele corecte (necercetat).
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
- [ ] **Dependențe cu avertismente de audit, doar URMĂRITE (de la 12b, 2026-10-28):** `deepmerge-ts`, `mysql2` și `fast-uri` (aduse de Prisma / `ajv`, nefolosite la rulare cu date de la clienți), `deepmerge` 4.3.1 (fără versiune reparată; vine din `html-to-text` din `@react-email/render`) și `postcss` 8.4.31 (adus de Next, rulează doar la build). Se reverifică cu `pnpm audit` după fiecare actualizare de Prisma sau Next și înainte de lansare; nu se actualizează acum.
- [ ] **Ecranul de stoc: filtrele de tip și de stare în SQL** (Faza 5, punctul 8): acum se aplică în memorie pe variantele găsite de căutare, până la 5000 (peste, mesaj «precizează căutarea»); cu un catalog mare, mută filtrarea și paginarea în interogare și măsoară
- [ ] **`TypeError` în `stock-overview-store.ts` (`toSource`, `row.product.id` null): corectat în 9c (rândul dispărut se omite). Rămân de păzit la Faza 9 (comenzi/coș), cu test care pică întâi, aceleași citiri în `stock-service.ts` (`prepare`, rândurile 358–408, și `adjust`, rândurile 1045–1074: `variant.product.*` după un `select` imbricat, în tranzacție; azi ar da `TypeError` în loc de `STOCK_VARIANT_NOT_FOUND` la un produs șters definitiv între citiri)**; istoricul apariției:, apărut o singură dată într-o rulare E2E completă (corecția CSV, 2026-10-26), în logul serverului, fără să pice vreun test; **a reapărut a doua oară** în E2E-ul complet de la 8c (tot fără test picat). Cauză probabilă: condiție de cursă între o ȘTERGERE DEFINITIVĂ din curățarea unui alt spec (care rulează în paralel) și interogările ecranului Stoc (`loadSources` citește variantele, apoi produsul lor în altă interogare Prisma; produsul dispare între ele). În aplicație produsele se șterg soft (`deletedAt`), deci nu s-a observat în producție. Dacă reapare în E2E sau într-un log real: fie o singură interogare cu `relationLoadStrategy: "join"`, fie ignorarea rândurilor fără produs, cu test care pică întâi.
- [ ] **Curățare din Blocul C (constatări minore, fiecare cu test care pică întâi)** (Blocul C, `docs/FAZA-4-bloc-C-constatari.md`): C-24 (scrieri la variantă pe produse din coș) · C-25 (istoricul exporturilor arată actorii altora) · C-27 (`error.message` brut în raportul de import) · C-28 (`validate`/`cancel` condiționate de stare) · C-29 (testul «rețea doar prin `safeFetchImage`» pe AST, extins la tot repo-ul) · C-30 (index unic `lower(sku)`) · C-31 (`isDefault` în `updateVariant`) · C-32 (`mapDbError` la granița serviciilor; coduri lipsă în `DOMAIN_CODES`) · C-33 (timeout-uri și pool `pg` explicite pentru lacătul categoriilor) · C-36 (schimbarea tipului unui atribut în tranzacție) · C-39 (limite pe `name`/`image`; emailul e deja validat) · C-42 (tokenuri de resetare anterioare; limitare la `change-password`) · C-44 (CHECK pereche `costPrice`/`costPriceDate`, limite pe relații/documente, escape la `ILIKE`, OFFSET) · C-45 (descrierile rolurilor Depozit/Contabil, teste de arhitectură mai strânse).
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
- [ ] (C-26) Filtrul de conținut activ din PDF nu vede obiecte comprimate (`/ObjStm`) și lasă `/OpenAction`, `/URI`, `/SubmitForm`, `/AA`, `/GoToR`, `/ImportData`: adaugă marcajele și respinge `/ObjStm` cu conținut activ. Fișierele se servesc doar ca `attachment` cu `nosniff` și CSP `sandbox` (Blocul C, `docs/FAZA-4-bloc-C-constatari.md`).
- [ ] (C-38) Audit pentru resetarea/schimbarea parolei și conectare; mascarea `auth.*Password*` păstrează diferența (nu «[ascuns]» la ambele valori); `documents.reorder`, încărcarea/anularea importului și scripturile CLI nu lasă urmă — rezolvat odată cu auditul în aceeași tranzacție (outbox) de mai jos (Blocul C, `docs/FAZA-4-bloc-C-constatari.md`).
- [ ] ⚠️ **Licențe ale dependențelor, înainte de vânzare** (Blocul C, `docs/FAZA-4-bloc-C-constatari.md`): produsul se distribuie către clienți, deci `THIRD-PARTY-NOTICES.md` (generat cu `node scripts/generate-third-party-notices.mjs`) se livrează cu pachetul și se arată unui avocat înainte de prima vânzare: LGPL (libvips / `@img/sharp-*`), CC-BY-4.0 (`caniuse-lite`), FSL-1.1-Apache-2.0 (`sentry` = Sentry CLI, doar la build; se exclude din instalarea de producție dacă nu se încarcă source maps). Dependențe cu avize `pnpm audit` (postcss din `next@15.5.28` nereparat, reparat doar în `next@16`): reevaluate la saltul de versiune major.
- [ ] ⚠️ **Audit în aceeași tranzacție cu modificarea**, acolo unde datele sunt în Postgres: acum auditul și scrierea sunt stores separate (la eșecul auditului, modificarea rămâne, iar apelantul primește `AUDIT_WRITE_FAILED`). Servicii cu `tx` comun sau outbox; integrări cu stare externă rămân best-effort, cu alertă
- [ ] Dockerfile multi-stage cu `output: 'standalone'` (app + worker separat)
- [ ] ⚠️ **Codul de test nu intră în pachetul distribuit și nici în imaginea Docker** (Faza 5, punctul 5: fixture-urile din `**/test-utils/**` șterg date, inclusiv registre imuabile): `.dockerignore` și lista de împachetare exclud `**/test-utils/**`, `**/*.test.ts`, `**/*.integration.test.ts`, `packages/*/scripts/dev-*.ts`, `packages/*/test/` (acolo stă `e2e-support.ts`, care oprește temporar triggerul registrului de mișcări), `e2e/` și `test/`; verifică în imaginea finală că niciunul nu există. Garanția de azi: testul de arhitectură `test-utils-isolation` (nicio sursă în afara testelor și a scripturilor `dev-*.ts` nu importă `test-utils`, iar `index.ts`-urile nu îl reexportă; Next `standalone` copiază doar ce se importă)
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
- [ ] ⚠️ **Unitatea în care se trimite stocul către eMAG** (din Faza 5, punctul 2): `ChannelListing.stock` este `Int?`, iar stocul propriu e `Quantity` în zecimi de miime, cu pas de vânzare. De decis: se trimite numărul de pași vandabili (disponibil în pași, fără rest), sau bucăți întregi; conversie cu rotunjire în jos, tampon de siguranță și produsele vândute la ml/mp/kg (probabil nu se listează pe eMAG); ce coloană/tip se schimbă, cu migrație și teste
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
| **MVP vandabil, produse fizice** (Fazele 0-15) | ~76-90 |
| + Produse digitale (Faza 14b) | inclus mai sus |
| + Pachet distribuibil (Fazele 18, 19, 21) | +14-16 |
| + CMS, marketing, SEO, rapoarte (Fazele 16, 17, 20) | +17-20 |
| **Complet, fără eMAG** | **~107-126** |
| + eMAG Marketplace (Faza 22b) | +8-12 |
| **Total** | **~115-138** |

Sugestia mea: lansează magazinul propriu (Fazele 0-17) pentru **un client real**, încasează, apoi adaugă instalatorul și eMAG. eMAG nu are sens înainte ca magazinul tău să funcționeze impecabil — penalizările lor sunt reale.
