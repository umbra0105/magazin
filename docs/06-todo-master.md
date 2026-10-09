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
- [ ] **Exportă produsele din site-ul existent** și verifică ce coloane obții _(necesar în Faza 4, la punctul de import CSV)_
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
- [x] **Sentry** (`@sentry/nextjs`) activat doar dacă există DSN, cu DSN din tabela `Setting` (editabil din admin), nu din `.env`; requestId ca tag. Decizie utilizator: amânat din Faza 1, se face aici o singură dată, după Service de setări
- [x] Schema Prisma: Setting, Branding, FeatureFlag, Integration, User, Role, Permission, Session, AuditLog
- [x] `auditLog()` doar de adăugare (trigger în DB), cu mascarea secretelor, și wrapper pentru server actions de admin
- [x] Design tokens din `Branding`: validare strictă Zod, fonturi locale (`next/font`), verificare contrast WCAG AA, CSS servit fără flash de temă greșită, 3 presets
- [x] **Service de setări** cu cache Redis, typed getters, valori implicite neutre
- [x] Setări implicite fiscale și regionale: `tax.standardRate = 21` (cota unică; nu hardcodată nicăieri în cod) și `regional.allowedCountries = ["RO"]` (aplicată în Faza 9)
- [x] Criptare AES-256-GCM pentru credențialele de integrare (cu `APP_KEY`)
- [ ] Auth complet: register, verificare email, login, logout, forgot, reset (argon2id)
- [ ] Rate limiting Redis pe rutele sensibile
- [ ] RBAC: permisiuni ca string-uri, roluri implicite, `can()` + `withPermission()`
- [x] Feature flags cu helper `isEnabled()`
- [ ] Layout admin: sidebar, topbar, breadcrumbs, guard
- [x] Seed de bază (roluri, setări implicite, un admin)
- [x] (8b) Bază de date separată pentru testele de integrare: `ecom_test` creată și migrată automat, Redis pe alt index, gardă care refuză bazele fără "test" în nume, aceeași bază în CI
- [~] (10) Teste rămase pentru Promptul 2: setări, flag-uri, criptare, audit append-only, branding (ruta /theme.css, golden-uri, fallback-uri)

## FAZA 3 — Media · ~2-3 zile
- [ ] Adaptor de storage comutabil: disk local ↔ S3-compatible (din setări)
- [ ] Upload cu validare MIME reală, limite, nume randomizate
- [ ] Procesare imagini în queue: variante, AVIF/WebP, blurhash
- [ ] Bibliotecă media în admin: grid, foldere, căutare, alt-text, selector reutilizabil

## FAZA 4 — Catalog: model și admin · ~8-10 zile
- [ ] Schema: Product, Variant, Option, OptionValue, Category, Brand, Collection, Attribute, Media, ProductRelation, PriceHistory, TaxClass, TaxRate
- [ ] Câmp `excludeFromGroupDiscount` pe produs și pe categorie
- [ ] **`costPrice` (int, bani, FĂRĂ TVA) și `costPriceDate` pe variantă** + tabela `CostPriceHistory` (`09` §1). **Doar în admin**: nu apar în API public, props către componente client, feed-uri, `OrderLine.productSnapshot` sau loguri (adaugă `costPrice` în lista de câmpuri mascate din logger); permisiuni `products.cost.view` / `products.cost.edit`
- [ ] Câmpurile de cost în tab-ul „Prețuri" al editorului de produs, vizibile doar cu permisiune (importul NIR vine în Faza 15)
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
- [ ] Blocare automată a easybox-ului dacă în coș există un produs `oversized`
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
- [ ] ⚠️ **`packages/core/scripts/seed-store.ts` (seed specific magazinului) și `dev-apply-preset.ts` NU intră în pachetul distribuit**: se mută în instalarea magazinului (sau în `/extensions`) înainte de împachetare
- [ ] ⚠️ **Runbook: utilizator de DB al aplicației FĂRĂ drept de `UPDATE`/`DELETE`/`TRUNCATE` pe `audit_log`** (nu owner al tabelei). Triggerul din migrație nu oprește owner-ul/superuserul; migrațiile rulează cu alt utilizator decât aplicația
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
