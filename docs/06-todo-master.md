# 06 — TODO MASTER (revizuit)

Model: **pachet instalabil, o instalare = un magazin** · Piață: **România, B2C**
Produse: **fizice + digitale (tutoriale video)** · Canale: **site propriu + eMAG (ulterior)**
Nișă: **echipamente pentru piscine** — produse grele, tehnice, sezoniere (vezi `15`)
Prețuri: **cu TVA inclus, identice pentru toți** + grupuri cu discount procentual (Partener, Client fidel)
Integrări confirmate: **Netopia + EuPlătesc** · **wootPRO + Sameday direct** · **Oblio** (SmartBill ulterior) · **Bunny Stream**

Bifează pe măsură ce termini. Acest fișier e memoria proiectului între sesiunile de Claude Code.

---

## FAZA 0 — Decizii și pregătire · ~2 zile
- [ ] Răspunde la cele 7 întrebări rămase din `01-arhitectura-si-decizii.md` §7
- [ ] **Completează `10-decizii-deschise.md`** — cel puțin toate întrebările marcate 🔴
- [ ] ⚠️ **Primul magazin e al tău.** Fazele 18, 19 și 21 (instalator, extensii, împachetare) se fac DUPĂ lansarea magazinului tău, nu înainte. Vezi nota de strategie de la finalul fișierului.
- [ ] Confirmă convenția de prețuri: **brut, cu TVA inclus, `int` în bani** (documentat în CLAUDE.md)
- [ ] Definește grupurile de clienți și procentele (ex. Standard 0%, Partener 15%, Client fidel 5%)
- [ ] Deschide conturi de test: Netopia, EuPlătesc, **wootPRO**, Sameday, Oblio
- [ ] Creează cont Bunny Stream pentru tutoriale video (poți amâna — driverul `local` funcționează pe localhost)
- [ ] **Cere VPS cu IP fix** — obligatoriu pentru whitelist-ul eMAG
- [ ] Întrebările pentru contabil din `10-decizii-deschise.md` §I
- [ ] Cumpără domeniul pentru instalarea de test
- [ ] Alege 3-5 magazine de referință pentru UX
- [ ] **Exportă produsele din site-ul existent** și verifică ce coloane obții
- [ ] Pregătește 20 de produse reale pentru datele demo

## FAZA 1 — Fundație · ~3-4 zile
- [x] Monorepo pnpm + Turborepo conform `01` §2
- [x] Next.js 15, TypeScript strict, Tailwind, shadcn/ui
- [x] `docker-compose.dev.yml`: postgres, redis, minio, mailpit
- [x] Schema de env cu Zod — app refuză să pornească fără variabile
- [x] ESLint, Prettier, Husky, lint-staged, commitlint
- [x] Vitest + Playwright configurate, teste de smoke
- [~] GitHub Actions: lint, typecheck, test, build
- [x] Logger Pino cu requestId (Sentry mutat în Faza 2, vezi primul punct de acolo)
- [x] `/api/health` care verifică DB + Redis
- [ ] `CLAUDE.md` scris (fișierul 07)
- [x] Fișier de versiune `packages/config/version.ts`

## FAZA 2 — Bază de date, setări, autentificare · ~4-5 zile
- [ ] **Sentry** (`@sentry/nextjs`) activat doar dacă există DSN, cu DSN din tabela `Setting` (editabil din admin), nu din `.env`; requestId ca tag. Decizie utilizator: amânat din Faza 1, se face aici o singură dată, după Service de setări
- [ ] Schema Prisma: Setting, Branding, FeatureFlag, Integration, User, Role, Permission, Session, AuditLog
- [ ] **Service de setări** cu cache Redis, typed getters, valori implicite neutre
- [ ] Criptare AES-256-GCM pentru credențialele de integrare (cu `APP_KEY`)
- [ ] Auth complet: register, verificare email, login, logout, forgot, reset (argon2id)
- [ ] Rate limiting Redis pe rutele sensibile
- [ ] RBAC: permisiuni ca string-uri, roluri implicite, `can()` + `withPermission()`
- [ ] Feature flags cu helper `isEnabled()`
- [ ] Layout admin: sidebar, topbar, breadcrumbs, guard
- [ ] Seed de bază (roluri, setări implicite, un admin)

## FAZA 3 — Media · ~2-3 zile
- [ ] Adaptor de storage comutabil: disk local ↔ S3-compatible (din setări)
- [ ] Upload cu validare MIME reală, limite, nume randomizate
- [ ] Procesare imagini în queue: variante, AVIF/WebP, blurhash
- [ ] Bibliotecă media în admin: grid, foldere, căutare, alt-text, selector reutilizabil

## FAZA 4 — Catalog: model și admin · ~8-10 zile
- [ ] Schema: Product, Variant, Option, OptionValue, Category, Brand, Collection, Attribute, Media, ProductRelation, PriceHistory, TaxClass, TaxRate
- [ ] Câmp `excludeFromGroupDiscount` pe produs și pe categorie
- [ ] **Clase de transport**: `weight`, `dimensions`, `shippingClass` (**doar `standard` / `oversized`**) — prețul vine din API-ul curierului (`15` §1)
- [ ] Bifa `requiresInstallation` pe produs (`15` §4)
- [ ] **Tab „Documente" pe produs** (`ProductDocument`: etichetă energetică, fișă tehnică, manual, CE) + `energyClass` și `eprelUrl` (`15` §2)
- [ ] **Fișă explodată, varianta A**: `PartsDiagram` + tabel numerotat. Tabela `PartsDiagramHotspot` se creează acum, se folosește în Val 2 (`15` §5.2)
- [ ] **Atribute numerice cu unitate de măsură**, filtrabile pe interval (`15` §3)
- [ ] Relații `spare_part` și `compatible_with`, pe lângă `accessory` și `upsell`
- [ ] Câmpuri pregătitoare: `expectedRestockDate`, `allowBackorder`, `Order.parentSubscriptionId`
- [ ] **`manageStock` + `stockStatus`** pe produs: urmărire cantitativă SAU doar „în stoc / nu"
- [ ] Tip de produs `physical` / `digital`
- [ ] `manufacturerPartNumber` și `manufacturerName` pe variantă (piese de schimb)
- [ ] Câmpuri pregătitoare pentru eMAG: `ean` și `warrantyMonths` pe variantă, `brandId` obligatoriu
- [ ] **Tabelele de canal** (`SalesChannel`, `ChannelListing`, `ChannelCategoryMapping`) + interfața `ChannelProvider` — vezi `12` §5. ~1 zi acum, salvează săptămâni mai târziu.
- [ ] Câmpuri GPSR (producător, persoană responsabilă UE, avertismente)
- [ ] Categorii: arbore drag & drop, imagine, SEO
- [ ] Branduri: CRUD
- [ ] Editor produs pe taburi (General, Media, Prețuri, Variante, Stoc, Atribute, Categorii, SEO, GPSR, Asociate)
- [ ] Generator de variante din opțiuni, editare în tabel
- [ ] Listă produse cu filtre, căutare, editare inline, editare în masă
- [ ] Duplicare, arhivare, soft delete
- [ ] Import/export CSV + XLSX cu mapare, dry-run, raport de erori pe rând
- [ ] ⚠️ **Import robust pentru migrarea celor ~500 de produse din site-ul vechi**: imagini prin URL, creare automată de categorii și branduri, atribute din coloane dinamice, toleranță la date murdare, import repetabil fără duplicate, reluabil după întrerupere
- [ ] Șablon CSV descărcabil, documentat

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

## FAZA 8 — Motor de prețuri și coș · ~5-6 zile ⚠️
- [ ] **Motor de prețuri** (`09-preturi-si-parteneri.md` §3): preț brut → salePrice → discount de grup → cupon → total linie → extragere TVA
- [ ] Extragere TVA din brut, rotunjire pe linie, o singură dată
- [ ] **Testele scrise ÎNAINTE de implementare**: cumulare promoție + grup, produse excluse, cupon peste discount, rotunjiri, cote 21% și 11%
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
- [ ] Blocare automată a easybox-ului dacă în coș există un produs `oversized`
- [ ] Mesaj explicit despre livrarea la nivelul solului, fără descărcare
- [ ] Seed cu județele și localitățile din România (SIRUTA)
- [ ] UI checkout pe pași accordion (`03-frontend.md` §2)
- [ ] Facturare pe firmă cu **validare CUI la ANAF**
- [ ] `PlaceOrderUseCase`: tranzacție atomică, snapshot, rezervare stoc, numerotare, idempotency key
- [ ] State machine cu 3 statusuri și tranziții validate, scrie `OrderEvent`
- [ ] Confirmare + `/comanda/urmarire` pentru guest
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
- [ ] Interfață `ShippingProvider`
- [ ] **Adaptor wootPRO**: AWB, etichetă, tracking, anulare, puncte de ridicare, tarife în timp real
- [ ] **Adaptor Sameday direct**: pentru clienții cu contract propriu + **easybox cu hartă în checkout**
- [ ] ⚠️ NU construi integrare Cargus separată — Sameday a achiziționat Cargus în august 2026, sistemele se unifică
- [ ] Mapare județe/localități către nomenclatoarele curierilor
- [ ] Admin: generare AWB individual și în masă, etichete PDF + ZPL, AWB de retur
- [ ] Ramburs transmis către curier + reconciliere
- [ ] Cron la 10 min de sincronizare status → email automat la expediere și livrare
- [ ] Circuit breaker: curier picat ≠ comandă pierdută

## FAZA 13 — Facturare și e-Factura (Oblio / SmartBill) · ~4-5 zile
- [ ] Interfață `InvoiceProvider`
- [ ] **Oblio**: emitere, storno, PDF, status e-Factura (SmartBill ulterior, prin aceeași interfață)
- [ ] Emitere automată la `paymentStatus = paid`, prin queue, cu retry
- [ ] **Proformă** pentru plăți prin transfer bancar
- [ ] Storno automat la rambursare
- [ ] Facturi în admin și în contul clientului
- [ ] Setări: date firmă, serie facturi, TVA implicit, cont bancar
- [ ] Taxare inversă intracomunitară cu validare VIES
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

## FAZA 15 — Grupuri de clienți și prețuri de partener · ~2-3 zile
- [ ] Schema: CustomerGroup + `Customer.groupId` + `excludeFromGroupDiscount` pe produs și categorie
- [ ] Snapshot pe comandă: `customerGroupId`, `groupDiscountPercent`, `groupDiscountAmount`
- [ ] Extinderea motorului de prețuri cu discountul de grup (teste scrise întâi)
- [ ] Regula de cumulare cu promoțiile, controlată de `stacksWithSalePrice`
- [ ] Afișare în storefront: preț de partener + preț standard tăiat + badge, identic pe PLP și PDP
- [ ] Linie separată de reducere în coș, checkout și factură
- [ ] Admin: CRUD grupuri, grup „Standard" neștergibil, badge și filtru în lista de clienți
- [ ] Atribuire de grup în masă + audit log
- [ ] Raport: vânzări per grup, total discount acordat
- [ ] (opțional) Promovare automată în „Client fidel" după X lei sau N comenzi

## FAZA 15b — Puncte de loialitate și vouchere · ~6 zile
Vezi `14-loializare-si-vouchere.md`. **Se face după ce comenzile, plățile și retururile funcționează complet.**
- [ ] Setări de loialitate: rată de acumulare, valoare punct, moment de acordare, expirare, limită de utilizare
- [ ] Schema: LoyaltyAccount, LoyaltyTransaction (registru imutabil — soldul se recalculează, nu se editează)
- [ ] Acumulare: 1 punct la 100 lei, pe subtotalul după reduceri, fără transport, cu `floor`
- [ ] `CustomerGroup.earnsLoyaltyPoints` — **fals pentru grupul Partener**
- [ ] Acordare la expirarea ferestrei de retur, cu status „în așteptare” vizibil în cont
- [ ] Răscumpărare ca ultimă reducere, **fără limită pe produse**, dar **punctele nu acoperă transportul**
- [ ] ⚠️ **Ramură de comandă 0 lei**: fără gateway de plată, status `paid` direct, `paymentMethod = 'loyalty_points'`
- [ ] Acumulare doar pe suma plătită efectiv cu bani (fără buclă de puncte pe puncte)
- [ ] Client promovat la Partener: păstrează soldul, nu mai acumulează
- [ ] Expirare la 12 luni, cu email de avertizare cu 30 de zile înainte
- [ ] **Toate cazurile din `14` §5**: anulare, retur parțial, sold negativ, rambursare, guest
- [ ] Afișare: sold în cont, „primești X puncte” pe PDP, utilizare în checkout
- [ ] Admin: sold per client, ajustare cu motiv obligatoriu, raport de datorie în puncte
- [ ] Schema: Voucher, VoucherTransaction, **cu sold rămas** (nu cod cu o singură utilizare)
- [ ] ⚠️ Voucherul intră la **PLATĂ**, nu în lanțul de reduceri. Nu reduce baza de TVA
- [ ] Emitere din admin + vânzare ca produs pe site, cu mesaj personalizat pe email
- [ ] Admin: listă, anulare, ajustare cu audit, **raport de datorie în vouchere**

## FAZA 16 — CMS și conținut · ~6-7 zile
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

## FAZA 17 — Promoții, recenzii, marketing, SEO · ~6-8 zile
- [ ] Schema Discount + motor de reguli (teste scrise întâi)
- [ ] Admin reduceri, generator de coduri, statistici
- [ ] Recenzii: submit, moderare, răspuns, achiziție verificată, solicitare automată post-livrare
- [ ] Newsletter cu dublu opt-in, coș abandonat (3 emailuri)
- [ ] Feed Google Merchant + Facebook
- [ ] GA4 + Meta Pixel + CAPI server-side, cu consimțământ
- [ ] Sitemap dinamic, robots, structured data complet, redirect-uri 301
- [ ] Audit SEO intern în admin

## FAZA 18 — Instalator și neutralitate white-label · ~5-6 zile 🔑
- [ ] Wizard `/install` complet (`08-instalare-si-distributie.md` §2)
- [ ] Notă: **tu faci instalările**, deci wizard-ul poate presupune un utilizator tehnic. Fără „prost-rezistență" extremă. Economie ~2-3 zile.
- [ ] Verificare cerințe, test conexiune DB, rulare migrații cu progres
- [ ] Generare `APP_KEY` + avertisment de păstrare
- [ ] Setare date firmă → propagate automat în footer, facturi, emailuri, pagini legale
- [ ] Creare cont administrator, alegere temă, upload logo
- [ ] Generare pagini legale + meniuri + date demo opționale
- [ ] Blocare permanentă `/install` după instalare
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
- [ ] Dockerfile multi-stage cu `output: 'standalone'` (app + worker separat)
- [ ] `docker-compose.prod.yml`: app, worker, postgres, redis, caddy
- [ ] Caddyfile cu SSL automat, HTTP/2, compresie, headers
- [ ] `install.sh`, `update.sh`, `backup.sh` testate pe un VPS curat
- [ ] Backup zilnic off-site + **restore testat**
- [ ] Uptime monitoring + alerte
- [ ] Documentația de livrat: README, MANUAL-ADMIN, CHANGELOG, RUNBOOK, EXTENSIONS, LEGAL
- [ ] **Instalare de la zero pe un VPS gol, cronometrată** — țintă sub 15 minute
- [ ] Mediu de staging identic cu producția

## FAZA 22 — Testare finală și lansare · ~4-5 zile
- [ ] E2E complet: guest cu ramburs · logat cu card sandbox · client partener cu discount · cu cupon · retur · admin creează produs → apare în storefront · AWB + factură
- [ ] Teste unitare: pricing, TVA, promoții, discount de grup, transport, state machines, stoc
- [ ] Teste de concurență și de idempotență
- [ ] **Comandă reală** cu card real → livrare → retur → rambursare
- [ ] Verificare emailuri (SPF/DKIM/DMARC, nu ajung în spam)
- [ ] Checklist legal complet din `05-integrari-romania.md` §9
- [ ] Verificare cu contabilul: TVA, facturi, e-Factura, proforme
- [ ] Teste pe iOS Safari, Android Chrome, desktop
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
