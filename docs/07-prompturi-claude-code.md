# 07 — Prompturi pentru Claude Code

> **Revizuit** după deciziile confirmate: pachet instalabil (nu multi-tenant),
> B2C cu grupuri de clienți (fără modul B2B clasic), Netopia/EuPlătesc + wootPRO/Sameday + SmartBill.
> Ordinea prompturilor corespunde fazelor din `06-todo-master.md`.

## Cum lucrezi (citește o dată, contează mai mult decât prompturile)

1. **O fază pe sesiune.** Contextul lung strică rezultatul. Sesiune nouă la fiecare fază.
2. **Plan înainte de cod.** Pe orice task mai mare de 30 de minute: „Fă întâi planul, nu scrie cod până nu îl aprob."
3. **Cere teste odată cu codul**, nu după. „Scrie testele înainte de implementare" funcționează foarte bine pe motoarele de prețuri/promoții/stoc.
4. **Commit des**, la fiecare sub-task funcțional. Cere-i mesaje de commit descriptive.
5. **Actualizează `docs/06-todo-master.md`** la finalul fiecărei sesiuni. Asta e memoria între sesiuni.
6. **Nu accepta cod pe care nu-l înțelegi.** Cere-i să explice deciziile. Tu ești responsabil de proiect.
7. **Verifică manual fluxul** după fiecare fază, în browser. Testele trec ≠ funcționează.
8. Când ceva nu merge: dă-i eroarea completă + ce ai încercat, nu „nu merge".

---

## `CLAUDE.md` — sursa de adevăr e fișierul din rădăcina proiectului

> Fișierul `CLAUDE.md` din rădăcina repo-ului este **singura sursă de adevăr** pentru regulile
> proiectului (prețuri, stoc, fiscal, loialitate, cod, protocol de raportare). Această secțiune
> conținea o copie care s-a desincronizat de el (zicea „multi-tenant" și nu avea regulile noi
> de prețuri). Nu mai ținem o a doua copie aici: citește și editează doar `CLAUDE.md` din rădăcină.

---

# Prompturile, în ordine

> Fiecare prompt = o sesiune nouă de Claude Code. Începe fiecare sesiune cu:
> *„Citește `CLAUDE.md` și `docs/01-arhitectura-si-decizii.md`. Apoi execută promptul de mai jos. Fă întâi planul și așteaptă aprobarea mea."*

---

### Prompt 1 — Schelet și infrastructură locală
```
Inițializează monorepo-ul conform structurii din docs/01-arhitectura-si-decizii.md §3.

Cerințe:
- pnpm workspaces + Turborepo
- Node.js 24 LTS: fișier `.nvmrc` cu `24`, câmpul `engines.node` (`>=24`) și
  `packageManager` (pnpm) în package.json, `node-version: 24` în GitHub Actions,
  imagini Docker `node:24-*` (Node 20 e end-of-life)
- apps/web: Next.js 15, App Router, TypeScript strict, Tailwind, shadcn/ui inițializat
- packages: db, core, ui, integrations, jobs, config, shared (cu package.json și tsconfig corecte)
- docker/docker-compose.dev.yml cu: postgres:16, redis:7, minio, mailpit
  (porturi neconflictuale, volume persistente, healthchecks)
- packages/config: schema de env cu Zod care validează la boot și aruncă eroare clară
  dacă lipsește ceva. Include .env.example complet și comentat.
- ESLint + Prettier + Husky + lint-staged + commitlint (conventional commits)
- Vitest configurat în root cu un test de smoke
- Playwright configurat cu un test care deschide homepage-ul
- GitHub Actions: install, lint, typecheck, test, build
- Sentry + logger Pino cu requestId în packages/shared
- Route /api/health care verifică DB și Redis
- README cu pașii de pornire locală

Nu scrie încă nicio logică de business. Verifică la final că `pnpm dev` pornește
și că `docker compose up` ridică toate serviciile.
```

### Prompt 2 — Setări, branding, feature flags, criptare
```
Implementează stratul de configurare — inima white-label-ului.
Citește docs/01-arhitectura-si-decizii.md §3 și §4.

1. Schema Prisma: Setting (key, value JSON, group), Branding, FeatureFlag,
   Integration (type, provider, credentials criptate, config, isActive),
   AuditLog, plus User, Role, Permission, RolePermission, UserRole, Session.

2. SettingsService în packages/core:
   - getters tipați cu Zod pe grupuri (general, company, regional, tax, checkout,
     email, legal, appearance, features)
   - cache Redis cu invalidare la scriere
   - valori implicite NEUTRE (nume „Magazin online", logo placeholder, culori gri)
   - `getCompanyInfo()` folosit în footer, facturi, emailuri, pagini legale

3. Criptare AES-256-GCM pentru credențialele din Integration, cu cheia din
   APP_KEY (env). Helper `encrypt`/`decrypt`. Cheile nu apar niciodată în loguri,
   în răspunsuri API sau în UI (afișare mascată: ****abcd).

4. FeatureFlagService cu `isEnabled(key)`. Flag-urile din docs/01 §4.
   Un flag stins trebuie să ascundă meniul din admin ȘI să facă ruta 404.

5. Design tokens: tabela Branding cu culori, fonturi, radius, preset, logo,
   favicon, ogImage. Funcție care generează blocul <style> cu CSS custom
   properties, injectat în layout-ul server. Zero flash de temă greșită.
   3 presets: Minimal, Bold, Editorial.

6. auditLog(actor, action, entity, before, after) + wrapper folosit automat
   de toate server actions de admin.

7. Seed minimal: roluri implicite, setări implicite neutre, flag-uri implicite.

Scrie teste: setările se citesc din cache, se invalidează la scriere; credențialele
se criptează și decriptează corect; un flag stins blochează ruta.
```

### Prompt 3 — Autentificare și RBAC
```
Implementează autentificarea și sistemul de permisiuni.

- Better Auth (sau Auth.js v5) cu adapter Prisma, sesiuni în DB + cache Redis
- Flux complet: înregistrare, verificare email, login, logout, forgot password,
  reset password. Parole cu argon2id.
- Rate limiting cu Redis pe: login (5/15min/IP+email), register, forgot-password
- Blocare temporară de cont după 10 încercări eșuate
- RBAC: permisiuni ca string-uri (docs/04-backend-admin.md §6), rolurile implicite
  seed-uite, helper `can(user, permission)` + wrapper `withPermission()` pentru
  server actions care aruncă ForbiddenError
- Middleware care protejează /admin/* și /cont/*
- Pagini: /autentificare, /inregistrare, /recuperare-parola, /resetare-parola/[token]
- Layout de admin: sidebar cu navigație, topbar cu user menu, breadcrumbs, dark mode
- Helper auditLog(actor, action, entity, before, after) folosit automat

Teste: fiecare rol are acces exact la ce trebuie; un Suport nu poate șterge produse.
```

### Prompt 4 — Media și bibliotecă de fișiere
```
Implementează sistemul de media.

- Adaptor S3-compatible în packages/integrations (MinIO local, R2 în prod)
- Upload cu presigned URLs, validare MIME reală (nu doar extensia), limită de mărime
- Procesare imagini la upload: generare variante (thumb/medium/large), conversie
  AVIF + WebP + fallback JPEG, extragere dimensiuni, blurhash pentru placeholder
- Model Media cu alt-text, foldere, tag-uri
- Bibliotecă media în admin: grid, upload drag&drop, căutare, foldere, editare alt,
  ștergere cu verificare de utilizare, selector reutilizabil pentru formulare
- Toate fișierele prefixate cu tenantId în cheia S3
- Job de procesare în queue (nu bloca upload-ul)
```

### Prompt 5 — Catalog: model de date și admin
```
Implementează catalogul conform docs/04-backend-admin.md §1 (secțiunea Catalog).

Schema: Product, ProductVariant, ProductOption, OptionValue, VariantOptionValue,
Category, ProductCategory, Brand, Collection, Attribute, AttributeValue,
ProductMedia, ProductRelation, PriceHistory, TaxClass, TaxRate.

Admin:
- Categorii: arbore cu drag & drop, imagine, SEO, reordonare
- Branduri: CRUD simplu
- Produse: listă cu filtre/căutare/paginare + editor complet pe taburi
  (General, Media, Prețuri, Variante, Stoc, Atribute, Categorii, SEO, GPSR, Asociate)
- Generator de variante din opțiuni, cu editare în tabel (preț, SKU, stoc, imagine)
- Editare în masă (preț ±%, status, categorie)
- Duplicare, arhivare, soft delete
- Slug generat automat din titlu, editabil, unic per tenant

Adaugă și:
- `Product.type` = physical | digital
- `Product.manageStock` (bool) + `Product.stockStatus` (enum: instock | outofstock |
  onbackorder) + setare globală `inventory.manageStock` ca implicit — model WooCommerce
- `Product.excludeFromGroupDiscount`, `Category.excludeFromGroupDiscount`
- `ProductVariant.costPrice` (int, în bani, FĂRĂ TVA, prețul de achiziție NIR) și `costPriceDate`, plus tabela `CostPriceHistory`. ⚠️ DOAR admin: niciodată în API public, props către componente client, feed-uri, `OrderLine.productSnapshot` sau loguri (adaugă `costPrice` la câmpurile mascate din logger). Permisiuni `products.cost.view` / `products.cost.edit`; câmpurile apar în tab-ul „Prețuri" doar cu permisiune. Importul NIR vine în Faza 15 (Promptul 21)
- `ProductVariant.ean`, `Product.warrantyMonths` (obligatorii pentru eMAG mai târziu)
- Specificul nișei (docs/15-specific-nisa-piscine.md): `weight`, `dimensions`,
  `shippingClass` (standard|oversized|pallet|freight), `requiresPalletDelivery`,
  `energyClass`, `energyLabelUrl`, `productSheetUrl`, `eprelId`
- Atribute NUMERICE cu unitate de măsură (m³/h, kW, m³), filtrabile pe interval
- Relații de produs: `spare_part` și `compatible_with`, pe lângă `accessory`/`upsell`
- Câmpuri pregătitoare, nefolosite deocamdată: `expectedRestockDate`,
  `allowBackorder`, `Order.parentSubscriptionId`
- Tabelele de canal din docs/12-emag-marketplace.md §2: SalesChannel, ChannelListing,
  ChannelCategoryMapping + interfața ChannelProvider (doar scheletul, fără eMAG).
  Canalul `web` creat implicit. Aceasta e ~1 zi acum și salvează săptămâni mai târziu.

La fiecare salvare: auditLog + revalidateTag pentru paginile afectate.
Scrie teste pentru generarea de variante și pentru unicitatea slug-urilor.
```

### Prompt 6 — Import/export produse (migrarea din site-ul vechi)
```
Implementează import și export de produse.

⚠️ CONTEXT: acest import va fi folosit pentru migrarea a ~500 de produse dintr-un
magazin existent. Se importă DOAR produsele — fără clienți, fără comenzi, fără
redirect-uri de URL. Fă-l robust: va rula pe date reale, murdare, de la început.

- Export CSV și XLSX cu toate câmpurile, filtrabil (categorie, status, brand)
- Import: upload fișier → detectare coloane → ecran de mapare → dry-run cu preview
  și raport de erori pe fiecare rând → confirmare → procesare în queue cu progres
- Actualizare pe bază de SKU (upsert), nu doar creare
- Suport pentru variante în import (rânduri grupate pe SKU părinte)
- Import de imagini prin URL, descărcate în queue, cu retry și raport de eșecuri
- Creare automată a categoriilor lipsă din calea din CSV („Pompe > Pompe filtrare")
- Creare automată a brandurilor lipsă
- Import de atribute din coloane dinamice (orice coloană `attr:debit` devine atribut)
- Toleranță la date murdare: prețuri cu virgulă sau spații, coloane goale,
  duplicate de SKU, caractere invizibile, encoding greșit (detectează UTF-8 vs CP1250)
- Import repetabil: rularea aceluiași fișier de două ori NU creează duplicate
- Raport final descărcabil cu rândurile eșuate și motivul
- Limită de rânduri și procesare în batch-uri de 100
- Import reluabil: dacă se întrerupe la rândul 300, se reia de acolo
- Șablon CSV descărcabil, cu toate coloanele documentate și un exemplu completat
```

### Prompt 7 — Stoc
```
Implementează gestiunea stocului conform docs/04-backend-admin.md.

Schema: Warehouse, InventoryItem, StockMovement, StockReservation, BackInStockAlert.

Service în packages/core/inventory cu: getAvailable(), reserve(), release(),
commit(), adjust(), transfer(). Toate operațiile în tranzacție, cu blocare
pesimistă (SELECT ... FOR UPDATE) pe InventoryItem.

- Rezervările au expirare (15 min implicit, configurabil)
- Cron care eliberează rezervările expirate
- Fiecare schimbare scrie un StockMovement cu motiv și referință
- Admin: ecran de stoc per depozit, ajustări cu motiv, istoric mișcări,
  transfer între depozite, alerte de stoc mic
- Alerte „anunță-mă când revine în stoc"

GESTIUNEA STOCULUI — model identic cu WooCommerce:
- setare globală `inventory.manageStock` (implicit ON) = implicitul pentru produse noi
- bifă per produs `manageStock` care suprascrie setarea globală
- la produsele cu variante, bifa poate coborî la nivel de variantă (moștenește implicit)

Dacă `manageStock = false`, TOATĂ logica de inventar se ocolește: disponibilitatea
vine din dropdown-ul `stockStatus` (în stoc / stoc epuizat / la comandă). Fără
InventoryItem, fără rezervare, fără decrement, fără alerte. Scrie o RAMURĂ EXPLICITĂ
în service — NU simula cu o cantitate mare, e o sursă sigură de bug-uri.

În UI-ul de admin: bifa „Gestionează stocul" ascunde/afișează câmpurile de cantitate,
exact ca în WooCommerce.

Teste obligatorii:
- 10 cereri concurente de rezervare pe un produs cu stoc 1 → exact una reușește,
  nouă primesc InsufficientStockError. Fără stoc negativ.
- Produs cu manageStock=false → se poate comanda de 100 de ori fără efect pe stoc,
  și devine indisponibil doar când adminul pune stockStatus = outofstock.
- Produs cu variante: unele variante cu gestiune, altele fără, în același coș.
```

### Prompt 8 — Design system și layout storefront
```
Construiește design system-ul și layout-ul public.

- Design tokens per tenant (docs/03-frontend.md §4): definite în Branding,
  injectate server-side ca CSS custom properties în layout. Zero flash.
- 3 presets de temă (Minimal, Bold, Editorial)
- Componente UI de bază în packages/ui, toate consumând doar tokens
- Header: logo, mega menu, search, cont, wishlist, cart cu badge, sticky
- Mobile nav: drawer, accordion pe categorii
- Footer: coloane configurabile, newsletter, plăți acceptate, ANPC/SAL, date firmă
- Announcement bar programabilă
- Pagini 404, 500, mentenanță
- Skeletons pentru toate zonele care încarcă asincron

Toate componentele responsive, mobile-first, cu focus states și contrast AA.
Fără nicio culoare hardcodată.
```

### Prompt 9 — Storefront: PLP, PDP, căutare
```
Implementează paginile de catalog conform docs/03-frontend.md §2.

- /categorie/[...path]: grid, sortare, paginare, descriere SEO
- Filtre faceted: preț (slider), brand, atribute dinamice, disponibilitate, reducere.
  Cu contorizări reale, sincronizate în URL prin searchParams, funcționale fără JS.
  Query optimizat — o singură interogare pentru rezultate + facets.
- /produs/[slug]: galerie cu zoom și lightbox, selector de variante care dezactivează
  combinațiile inexistente, preț cu compareAt și procent, afișarea celui mai mic preț
  din ultimele 30 de zile (Omnibus, din PriceHistory), badge de stoc, taburi,
  date GPSR, produse asociate, sticky add-to-cart pe mobil
- /cautare: Postgres full-text + pg_trgm pentru typo, autocomplete cu debounce
- /brand/[slug] și /colectie/[slug]
- Breadcrumbs + structured data (Product, Offer, BreadcrumbList)
- ISR cu revalidateTag invalidat la salvarea produsului în admin

Țintă: LCP sub 2.5s pe mobil pentru PDP. Verifică cu Lighthouse.
```

### Prompt 10 — Coș și motor de prețuri
```
Implementează coșul și motorul de prețuri.

Motor de prețuri în packages/core/pricing, ordine deterministă:
preț de bază → promoție → preț de grup (extins în Promptul 21) → cupon → puncte → TVA
Funcție pură, ușor de testat. Scrie testele ÎNAINTE de implementare, acoperind:
reduceri procentuale și fixe, praguri, cumulare, prioritate, rotunjiri, TVA
inclus vs exclus, transport gratuit peste prag.

Coș:
- Cart + CartItem în DB, coș de guest cu token în cookie httpOnly
- Merge automat la login (fără să pierzi produse)
- Adăugare, modificare cantitate, ștergere cu undo
- Cart drawer + pagină /cos
- Validare la fiecare afișare: produs activ, preț actual, stoc disponibil,
  cu mesaje clare dacă ceva s-a schimbat
- Indicator de prag pentru transport gratuit
- Aplicare cupon cu validarea tuturor condițiilor
- Estimare cost transport
```

### Prompt 11 — Checkout și plasare comandă
```
Implementează checkout-ul și plasarea comenzii. Aceasta este partea critică —
lucrează încet și testează mult.

Schema: Order, OrderLine, OrderEvent, Payment, ShippingZone, ShippingMethod.

Motor de livrare: zone pe județ/localitate, metode (flat, pe greutate, pe valoare,
gratuit peste prag, ridicare personală), taxă de ramburs, estimare zile.

SPECIFIC NIȘEI (docs/15 §1) — produsele sunt grele și voluminoase:
- calculează GREUTATEA VOLUMETRICĂ ((L×l×h)/5000) și tarifează pe cea mai mare
  dintre greutatea reală și cea volumetrică
- clase de transport per produs: standard / oversized / pallet / freight
- „Livrare pe palet" ca metodă separată, cu preț și termen proprii
- ascunde automat easybox-ul dacă în coș există un produs `oversized`
- afișează explicit: livrarea se face la adresă, la nivelul solului, descărcarea
  și manipularea sunt în sarcina clientului

UI checkout: o pagină cu pași accordion, conform docs/03-frontend.md §2.
- Seed cu județele și localitățile din România
- Facturare pe persoană juridică cu validare CUI
- Salvare progresivă (localStorage + server), fără pierderi la refresh
- Recalculare dinamică a metodelor disponibile
- Vânzare DOAR în România, pentru orice produs: validează pe server țara adresei de livrare și de facturare față de setarea regional.allowedCountries (implicit ["RO"])
- Ramburs: limită de valoare configurabilă din setări, 10.000 lei pentru persoane fizice și 5.000 lei pentru persoane juridice (persoană juridică = CUI la facturare SAU grup cost_plus). Peste limită, metoda se ascunde, cu explicație

PlaceOrderUseCase în packages/core/checkout:
- Revalidează TOT pe server (nu te încrede în client)
- Tranzacție atomică: Order + OrderLines cu snapshot complet + rezervare stoc
  + alocare număr de comandă (secvență per tenant, fără goluri) + Payment pending
- Idempotency key pentru protecție la dublu-submit
- Side-effects DOAR după commit, prin queue
- Rollback complet la orice eroare

State machine explicit pentru status / paymentStatus / fulfillmentStatus cu
tranziții validate. Funcția transition() scrie automat OrderEvent.

Pagina de confirmare + /comanda/urmarire pentru guest (nr. comandă + email).
Deocamdată doar plată ramburs. E2E Playwright: cumpărare completă ca guest.
```

### Prompt 12 — Plăți online
```
Implementează plățile online.

- Interfață PaymentProvider în packages/integrations/payments
  (createPayment, verifyWebhook, capture, refund, getStatus)
- Implementează NETOPIA mobilPay ȘI EuPlătesc, ambele active simultan,
  cu mod test/live comutabil din setări și selecție a metodelor active per instalare
- Chei stocate criptat per tenant în Integration (AES-256-GCM)
- Flux: inițiere → redirect/3DS → retur pe site → pagină de așteptare care
  face polling până la confirmarea prin webhook
- Webhook: verificare semnătură OBLIGATORIE, idempotență pe eventId,
  răspuns 200 rapid + procesare async în queue
- Tratează toate cazurile: succes, eșec, anulare de utilizator, timeout,
  plată dublă, sumă diferită, webhook întârziat, webhook duplicat
- La succes: confirmă comanda, transformă rezervarea în decrement real,
  enqueue email + factură. La eșec: eliberează rezervarea, email cu link de reîncercare.
- Rambursare parțială și totală din admin, cu reflectare în paymentStatus
- Job de reconciliere zilnică: compară plățile din procesator cu cele din DB

Teste: webhook trimis de 3 ori → un singur efect. E2E în sandbox.
```

### Prompt 13 — Admin comenzi
```
Implementează modulul de comenzi din admin conform docs/04-backend-admin.md §5.2.

- Listă: filtre (status, plată, fulfillment, dată, sumă, canal, etichete),
  căutare globală, vizualizări salvate, selecție multiplă, acțiuni în masă
- Detaliu comandă: linii, adrese editabile, timeline din OrderEvent, plăți,
  expedieri, facturi, note interne și pentru client, date client cu istoric
- Acțiuni: confirmă, marchează procesată, anulează cu motiv, rambursează
  (parțial/total), editează comanda (adaugă/scoate linii, recalculează diferența),
  duplică, retrimite email, printează
- Draft order: operatorul creează comandă manual și trimite link de plată
- Fiecare acțiune respectă state machine-ul și scrie OrderEvent + auditLog
- Verificare de permisiuni pe server pentru fiecare acțiune (orders.refund etc.)
```

### Prompt 14 — Emailuri tranzacționale
```
Implementează sistemul de email.

- React Email în packages/emails, cu layout branded per tenant (logo, culori din tokens)
- Provider abstractizat (Resend/Postmark/SMTP), configurabil per tenant
- Toate emailurile prin BullMQ cu retry exponențial și dead-letter queue
- Template-uri (lista completă în docs/02-complet-si-functional.md §B8):
  confirmare comandă, plată primită, plată eșuată, expediere cu AWB, livrare,
  anulare, rambursare, retur (cerut/aprobat/respins), bun venit, verificare email,
  resetare parolă, coș abandonat ×3, cerere de recenzie, revenire în stoc,
  notificări interne
- Fiecare email: HTML + text, preheader, link de dezabonare unde e cazul
- Admin: listă template-uri, preview cu date demo, trimitere de test,
  suprascriere per tenant, editare subiect și conținut
- Emailul de confirmare conține toate informațiile precontractuale cerute de lege
- Mailpit pentru dezvoltare locală
```

### Prompt 15 — Curieri și AWB
```
Implementează livrarea și AWB-urile.

- Interfață ShippingProvider: createAwb, getLabel, track, cancel,
  getPickupPoints, calculateRate
- DECIS: mergem pe AGREGATOR, nu pe integrări directe multiple.
  Implementează adaptorul pentru [wootPRO / Innoship — vezi docs/05 §4]
  și, ca al doilea adaptor, SAMEDAY direct (pentru clienții cu contract propriu
  și pentru easybox nativ).
- ⚠️ NU construi integrare separată pentru Cargus: Sameday a achiziționat Cargus
  în august 2026 și sistemele se unifică. Verifică statusul înainte de a începe.
- Citește documentația curentă a agregatorului înainte de implementare.
- Schema: Shipment, ShipmentItem
- Selectare easybox / punct de ridicare în checkout, cu hartă și căutare
- Admin: generare AWB dintr-un click, generare în masă, descărcare etichete PDF
  (și ZPL pentru imprimante termice), anulare AWB, AWB de retur
- Ramburs: transmiterea sumei către curier
- Cron la 10 min: sincronizare status pentru expedierile active →
  actualizare fulfillmentStatus → email automat la expediere și la livrare
- Circuit breaker: dacă API-ul curierului e picat, comanda rămâne validă,
  jobul se reia, adminul vede eroarea
- Mapare între județele/localitățile noastre și nomenclatorul curierului
```

### Prompt 16 — Facturare și e-Factura (SmartBill)
```
Implementează facturarea, conform docs/05-integrari-romania.md §2 și docs/10 Partea I
(„Fiscal, facturare și plăți").

⚠️ ÎNAINTE DE A SCRIE COD: citește documentația curentă a API-ului SmartBill. Nu te baza
pe ce știi din training. Utilizatorul trebuie să fi verificat cu SmartBill că abonamentul
include acces API (docs/10 Partea II #9). Dacă nu a confirmat, 🛑 STOP.

- Interfață InvoiceProvider: issue, issueProforma, storno (total și parțial), getPdf, getStatus
- Implementează SMARTBILL, cu e-Factura inclusă. Oblio poate veni mai târziu prin aceeași
  interfață — nu îl implementa acum.
- Seria și numărul le definește SmartBill: NU construi numerotare locală. Stochează
  providerRef, seria și numărul returnate.
- Schema Invoice: tip (proforma | invoice | storno), serie, număr, providerRef, pdfUrl,
  xmlUrl, efacturaStatus
- Momentul emiterii depinde de metoda de plată:
  · card: factura la plata confirmată
  · transfer bancar: proformă la plasarea comenzii, apoi factură după ce adminul confirmă plata
  · ramburs: factura la plasarea comenzii; storno dacă coletul se întoarce. Plata se
    consideră încasată când curierul virează banii (reconciliere în admin)
- Emitere prin queue (nu bloca comanda dacă eșuează)
- Storno automat la anulare, refuz ramburs și rambursare; STORNO PARȚIAL la retur parțial
- Pe factură: la Partener (cost_plus) apare doar prețul unitar încasat, fără linie
  specială; la Fidel/VIP reducerea apare explicit
- Facturi descărcabile în admin și în contul clientului
- Status e-Factura vizibil în admin, cu buton de re-trimitere
- Setări: date firmă, TVA (cota standard din setări, implicit 21%), cont bancar. Fără serie locală
- Fără taxare inversă intracomunitară și fără OSS (vânzare doar în România)
- Retry cu backoff dacă furnizorul e indisponibil; alertă în admin după 3 eșecuri
```

### Prompt 17 — Cont client și retururi
```
Implementează contul de client și fluxul de retur.

Cont: dashboard, istoric comenzi, detaliu comandă cu timeline și tracking AWB,
agendă de adrese, descărcare facturi, wishlist, recenziile mele,
preferințe de comunicare, export date personale (JSON+PDF), ștergere cont
cu anonimizare (păstrezi comenzile pentru obligații fiscale, dar anonimizate).

Retururi:
- Schema ReturnRequest cu state machine (docs/04-backend-admin.md §2)
- Client: inițiere retur din detaliul comenzii, selectare produse și motiv,
  în fereastra legală de 14 zile
- Admin: aprobare/respingere cu motiv, generare AWB de retur, recepție,
  inspecție, rambursare parțială/totală, repunere pe stoc opțională
- Emailuri la fiecare tranziție
- Raport cu motivele de retur
```

### Prompt 18 — CMS și pagini
```
Implementează sistemul de conținut.

- Schema: Page, Menu, Banner, BlogPost, Faq, Redirect, SeoMeta, BlockPreset
- Sistem de blocuri: fiecare tip de bloc are schema Zod + componentă de randare
  + formular de editare. Registry central. Tipuri: Hero, ProductGrid, CategoryGrid,
  RichText, ImageText, Banner, Testimoniale, FAQ, Newsletter, VideoEmbed, Spacer, HTML
- Editor de pagini: listă de blocuri cu drag & drop, adăugare, duplicare, ștergere,
  editare în panou lateral, preview live într-un iframe
- Homepage construit exclusiv din blocuri
- Editor de meniuri: arbore drag & drop, linkuri către categorii/pagini/URL-uri
- Blog complet cu categorii, autori, programare, imagine de copertă
- FAQ cu categorii
- Pagini legale cu versionare (trebuie să știi ce versiune a acceptat fiecare client)
- Formular de contact cu honeypot, rate limit și email către admin
- Redirect-uri 301 cu import CSV
- Banner de cookie-uri care BLOCHEAZĂ efectiv scripturile până la consimțământ,
  cu categorii granulare și Google Consent Mode v2
```

### Prompt 19 — Promoții, recenzii, marketing
```
Implementează marketingul.

Promoții:
- Schema Discount, DiscountUsage, GiftCard
- Motor de reguli: tipuri (procent, sumă fixă, transport gratuit, X+Y gratis),
  condiții (subtotal minim, cantitate, produse/categorii, grup de client,
  prima comandă, interval), limite de utilizare, prioritate, cumulare
- Scrie testele întâi. Acoperă cazurile de cumulare și conflict.
- Admin: creare, generator de coduri în masă, statistici de utilizare
- Promoții automate (fără cod), aplicate în coș

Recenzii: submit cu rating și media, moderare în admin, răspuns public,
badge „achiziție verificată", solicitare automată la 5 zile după livrare,
rating agregat + structured data.

Newsletter cu dublu opt-in și dezabonare într-un click.
Coș abandonat: cron + 3 emailuri (1h, 24h, 72h) cu link de recuperare.
Feed-uri Google Merchant și Facebook, generate zilnic.
Analytics: GA4 + Meta Pixel + Conversions API server-side, cu toate evenimentele
din docs/05-integrari-romania.md §7, respectând consimțământul.
```

### Prompt 20 — SEO și performanță
```
Optimizează SEO și performanța.

SEO:
- Sitemap dinamic segmentat (produse, categorii, pagini, blog), sub 50k URL-uri/fișier
- robots.txt per tenant
- Metadata API: title, description, canonical, OG, Twitter, per entitate cu fallback
- Structured data complet: Organization, WebSite+SearchAction, Product+Offer+
  AggregateRating, BreadcrumbList, FAQPage, Article
- Imagini OG generate dinamic
- Gestionarea filtrelor: noindex pe combinații, canonical către categoria de bază
- Audit SEO în admin: produse fără meta, imagini fără alt, pagini orfane

Performanță:
- Audit Lighthouse mobil pe home, PLP, PDP, checkout. Țintă ≥90.
- Analiză de bundle, eliminarea dependențelor grele din bundle-ul inițial
- next/image cu sizes corect, priority doar pe LCP
- next/font self-hosted cu display swap
- Cache headers, ISR, revalidateTag granular
- Elimină orice CLS
- Scripturi terțe încărcate doar după consimțământ, cu strategy afterInteractive

Headers de securitate: CSP strict, HSTS, X-Frame-Options, Referrer-Policy,
Permissions-Policy. Verifică pe securityheaders.com.
```

### Prompt 21 — Grupuri de clienți, prețuri de partener și prețuri NIR
```
Implementează grupurile de clienți cu trei tipuri de preț și importul prețurilor de
achiziție, conform docs/09-preturi-si-parteneri.md (citește-l integral) și docs/10
Partea I. NU construi modul B2B, liste de prețuri per client, tranșe de cantitate,
conturi de firmă multi-utilizator sau prețuri pe categorie/produs per grup.

ÎNAINTE DE A ÎNCEPE: utilizatorul trebuie să-ți fi dat un fișier exemplu de export
SmartBill („lista de mișcări produse"). Fără el nu poți fixa formatul importului NIR.
Dacă nu l-ai primit, 🛑 STOP.

Schema:
- CustomerGroup: name, slug, pricingType ('none' | 'discount' | 'cost_plus'),
  discountBps? (pentru discount), markupBps? (pentru cost_plus), isDefault,
  stacksWithSalePrice (doar la discount), earnsLoyaltyPoints, freeShippingThreshold?,
  minOrderValue?, color, isActive. Procentele sunt int în puncte de bază (500 = 5,00%),
  NICIODATĂ float.
- Customer.groupId
- Product.excludeFromGroupDiscount, Category.excludeFromGroupDiscount (se aplică AMBELOR
  tipuri: produsul exclus costă prețul public pentru toți)
- ProductVariant.costPrice și costPriceDate + CostPriceHistory (existente din Faza 4,
  Promptul 5)
- Order (snapshot): customerGroupId, groupPricingType, groupDiscountBps?, groupMarkupBps?,
  groupAdvantageAmount

Motorul de prețuri din packages/core/pricing, ordinea din docs/09 §3:
  price → salePrice → preț de grup → cupon → puncte → total linie → extragere TVA
- none: prețul public curent.
- discount: min(price × (1 − discountBps/10000), prețul public curent). Dacă
  group.stacksWithSalePrice și există salePrice: salePrice × (1 − discountBps/10000).
  DECIS: stacksWithSalePrice e IMPLICIT FALSE (se ia prețul cel mai mic).
- cost_plus: pret_brut = costNet × (10000 + markupBps) × (10000 + vatBps) / 10000²,
  cu costNet = costPrice (NET, fără TVA) și vatBps din cota produsului (cota standard
  din setări, implicit 21%). Rezultat = MIN(pret_brut, prețul public curent, inclusiv
  promoția). PLAFON: partenerul nu plătește niciodată mai mult decât oricine altcineva.
  Produs fără costPrice → prețul public (și apare în raportul „fără preț NIR").
- Rotunjirea: o SINGURĂ dată, pe linia de comandă, din valoarea exactă × cantitate.
  unitPrice (rotunjit) e informativ; lineTotal e cel care contează.
- Produs sau categorie cu excludeFromGroupDiscount → prețul public curent.
- DECIS: cuponul SE cumulează cu prețul de grup, cu excepția cupoanelor cu flag-ul
  notForDiscountedGroups, care blochează orice grup cu pricingType ≠ none.
- DECIS: atribuirea în grup se face MANUAL de admin. Fără regulă automată de promovare.
- Punctele de loialitate: Standard, Fidel și VIP acumulează, Partenerii NU
  (earnsLoyaltyPoints = false). Discountul Fidel/VIP se cumulează cu punctele.

⚠️ costPrice și costPriceDate sunt DOAR pentru admin: niciodată în API public, în props
către componente client, în JSON-ul storefront-ului, în feed-uri, în emailuri, în
OrderLine.productSnapshot sau în loguri. Vizibile doar cu products.cost.view; editabile
cu products.cost.edit. Scrie un test care verifică absența lor din răspunsurile publice.

SCRIE TESTELE ÎNTÂI, conform docs/09 §7:
- preț corect pentru vizitator, client standard, Fidel, VIP, Partener, produs exclus
- discount: promoție + grup, ambele variante de cumulare
- cost_plus: costNet 100,00 · adaos 12% · TVA 21% → 135,52 lei; plafon față de prețul
  public și față de prețul promoțional; produs fără costPrice → preț public; schimbarea
  costPrice în sus și în jos; cantitate 7 cu fracțiune de ban rotunjită o singură dată
- cupon peste prețul de grup; cupon notForDiscountedGroups blocat pentru toate grupurile
  speciale
- rotunjire: coș cu 3 produse × cantitate 3 → total coș = total comandă = total factură
- extragere TVA din brut la cota din setări și la o a doua cotă de test (dovadă că
  nu e hardcodat)
- schimbarea grupului sau a procentului după comandă nu modifică comanda veche
- client fără grup → primește grupul implicit

Storefront:
- Fidel/VIP: preț redus + „Preț standard" tăiat + badge „Preț client fidel −X%"
- Partener: preț de partener + „Preț standard" tăiat + badge „Preț partener" (doar dacă
  e mai mic decât cel public; altfel preț simplu). Identic pe PLP și PDP
- Coș/checkout: linie „Reducere client fidel (−X%): −Y lei" la Fidel/VIP; linie
  informativă „Avantaj partener: −Y lei" la Partener
- Pe factură: Fidel/VIP — reducere explicită; Partener — doar prețul unitar încasat
- Prețul unui partener este per client: NU poate sta în paginile cu cache ISR. Calculează-l
  separat, dinamic, pentru clientul logat. Coșurile se revalidează la fiecare afișare
- NU adăuga comutator cu/fără TVA. Prețurile sunt mereu cu TVA inclus

Admin:
- Setări → Grupuri de clienți: CRUD cu selector de tip + procentul relevant
- Grupul „Client standard" (none) creat la instalare, neștergibil. Celelalte cinci grupuri
  (Fidel 5%, VIP 7%, Partener 1/2/3 cu 12% / 17% / 21%) sunt un SEED SPECIFIC
  MAGAZINULUI, nu default de pachet
- Coloană „Grup" cu badge colorat în lista de clienți + filtru; dropdown de grup în fișa
  clientului + atribuire în masă din listă
- Bifă „Exclude din prețul de grup" pe produs și pe categorie
- Orice schimbare de grup scrie în auditLog
- Raport: vânzări per grup + total avantaj acordat pe perioadă

IMPORT PREȚURI NIR (docs/09 §4):
- Upload fișier exportat din SmartBill → dry-run cu previzualizare → confirmare →
  procesare în queue
- Potrivire pe SKU de variantă; per produs se ia intrarea cu cea mai recentă dată;
  se actualizează costPrice + costPriceDate DOAR dacă data e mai nouă; prețul poate
  scădea sau crește (câștigă cel mai recent)
- Fiecare actualizare scrie în CostPriceHistory; importul e repetabil fără dubluri
- Raport descărcabil: actualizate · neschimbate · coduri necunoscute · rânduri invalide
- Permisiune dedicată + auditLog pe fiecare import
- Indicator și filtru „produse fără preț NIR" în dashboard și în lista de produse
- Testele importului: cea mai recentă dată câștigă, același fișier de două ori nu schimbă
  nimic, coduri necunoscute raportate, preț care scade se actualizează
```

### Prompt 21b — Instalator și neutralitate white-label 🔑
```
Implementează wizard-ul de instalare conform docs/08-instalare-si-distributie.md §2.

Rută /install, accesibilă DOAR dacă nu există instalare (flag în DB + install.lock).
După finalizare se blochează permanent (404), verificat și în middleware.

Pași:
1. Verificare cerințe: versiune Node (minim 24), conexiune Postgres, conexiune Redis,
   extensii pg (pg_trgm, uuid-ossp), permisiuni de scriere pe storage, APP_KEY.
   Afișare verde/roșu; nu se trece mai departe cu roșu.
2. Configurare DB: host, port, user, parolă, nume + buton „Testează conexiunea"
   → rulare migrații cu bară de progres.
3. Magazin: nume, URL, monedă, limbă, fus orar, cotă TVA standard (implicit 21%),
   țări permise la vânzare (implicit RO). Fără comutator cu/fără TVA.
4. Firmă: denumire, formă juridică, CUI, Reg. Com., sediu, capital social,
   email, telefon, IBAN, bancă.
5. Cont administrator cu cerințe de complexitate a parolei.
6. Aspect: preset de temă, culoare principală, upload logo și favicon, preview live.
7. Conținut: generează paginile legale precompletate cu datele firmei
   (TC, confidențialitate, cookie-uri, retur, GDPR, ANPC) — fiecare marcată în
   admin cu „text template, consultă un avocat"; meniuri implicite; date demo opționale.
8. Finalizare: scrie flag, blochează /install, pornește worker-ul,
   redirect la /admin cu checklist de primii pași.

Detalii obligatorii:
- APP_KEY se generează dacă lipsește, cu avertisment clar: dacă se pierde,
  credențialele criptate devin ilizibile. Oferă-l la descărcare.
- Dacă nu poate scrie în .env, afișează conținutul de copiat manual.
- Mesajele de eroare sunt în română, umane, cu sugestie de rezolvare.
  Niciun stack trace vizibil.

Apoi: editor de temă în admin (color pickers, fonturi, radius, presets, logo,
favicon, OG, preview live) + câmpuri de CSS custom și scripturi custom în setări.

La final, fă un AUDIT DE NEUTRALITATE conform docs/08 §6: caută în tot codul
orice nume de brand, culoare hardcodată, text în engleză vizibil clientului,
link extern, ID de analytics. Raportează tot ce găsești.
```

### Prompt 21c — Extensii și mecanism de actualizare 🔑
```
Implementează sistemul de extensibilitate conform docs/08 §4 și §3.

1. Registry de hooks în packages/extensions:
   - hooks.on(event, handler) pentru evenimente: order.before_place, order.placed,
     order.status_changed, product.saved, customer.registered, payment.completed
   - hooks.filter(name, fn) pentru: checkout.fields, price.calculate,
     email.template, product.query, menu.items
   - încărcare automată a modulelor din /extensions la boot
   - tratare de erori: o extensie care crapă NU trebuie să oprească magazinul

2. Override de componente: registry care rezolvă
   'storefront/ProductCard' → extensions/overrides.ts dacă există, altfel implicit.

3. Blocuri CMS custom: un fișier în /extensions/blocks se înregistrează automat
   în editorul de pagini.

4. Versionare: packages/config/version.ts + Setting `app_version` în DB.

5. Scripturi în /scripts:
   - install.sh — pornește serviciile, generează .env, deschide wizard-ul
   - update.sh — backup DB+storage → pull → up → prisma migrate deploy →
     golire cache → reindexare → health check → ROLLBACK AUTOMAT la eșec
   - backup.sh — dump + arhivare storage + retenție configurabilă

6. Admin „Sistem → Actualizări": versiune instalată, versiune disponibilă,
   changelog, istoric de update-uri, verificare checksum pe core care semnalează
   fișiere modificate manual.

7. CI: test care aplică update-ul de la fiecare versiune minoră anterioară
   către HEAD și verifică că migrațiile trec și aplicația pornește.

Documentează în docs/EXTENSIONS.md toate hook-urile disponibile, cu exemple.
```

### Prompt 21d — Produse digitale
```
Implementează produsele digitale conform docs/11-produse-digitale.md.

Schema: DigitalProduct, DigitalAsset, DigitalEntitlement, DigitalAccessLog (§2).

Livrare:
- Interfața MediaDeliveryProvider: getSignedUrl, upload, delete, getPlayerEmbed
- Implementare Bunny Stream pentru video (token semnat, watermark cu emailul
  cumpărătorului) și S3 pentru fișiere (presigned URL, 15 min)
- Upload de video în background, cu progres, prin queue

Flux (§4):
- La confirmarea plății → creează DigitalEntitlement pentru fiecare linie digitală
- Email „Produsul tău e gata" cu link către /cont/produsele-mele (NU link direct
  de descărcare pe email)
- La accesare: verifică entitlement, generează link semnat, incrementează contorul,
  scrie în DigitalAccessLog
- La rambursare: revocă entitlement-ul

Checkout mixt (§7) — tratează TOATE cazurile:
- coș 100% digital: fără pas de livrare, fără adresă de livrare, ramburs ascuns
- coș mixt: transport calculat DOAR pe liniile fizice; pragul de transport gratuit
  se calculează tot doar din valoarea fizică
- comandă mixtă plătită ramburs: 🟡 DECIZIE DESCHISĂ a utilizatorului (docs/10 Partea I):
  eliberare la livrare confirmată (recomandare) sau la virarea banilor de către curier.
  NU implementa această ramură până nu primești decizia
- fulfillmentStatus suportă partially_fulfilled (digital livrat, fizic încă nu)

LEGAL (§5) — obligatoriu, nu opțional:
- bifă SEPARATĂ de acceptarea Termenilor, NEPREBIFATĂ, obligatorie dacă în coș
  există produse digitale, cu textul de renunțare la dreptul de retragere
- salvează `digitalConsentAt` și `digitalConsentText` pe comandă
- reia acordul în emailul de confirmare
- blochează plasarea comenzii dacă bifa lipsește

TVA: cota unică 21% din setări, ca la toate produsele. Vânzarea e restricționată la România
pentru ORICE produs (setarea regional.allowedCountries, aplicată în checkout, Faza 9); nu
implementa aici o restricție separată pentru digital, doar verifică că funcționează și pentru
coș 100% digital. Fără OSS.

Admin: tab „Conținut digital" pe produs, module ordonabile, marcare preview gratuit,
listă entitlements per comandă și per client, acțiuni de resetare contor /
prelungire acces / revocare, alertă la accesări suspecte.

Storefront: /cont/produsele-mele cu bibliotecă, player, contor de descărcări.
```

### Prompt 21e — eMAG Marketplace (DUPĂ lansarea magazinului propriu)
```
Implementează integrarea eMAG conform docs/12-emag-marketplace.md.
Prerequisit: tabelele de canal există deja din Faza 4 și magazinul propriu
funcționează complet în producție.

⚠️ ÎNAINTE DE A SCRIE COD: citește documentația oficială curentă a eMAG
Marketplace API. Detaliile (versiuni, câmpuri, termene, penalizări) se schimbă
și nu te baza pe ce știi din training.

- Client API cu autentificare, rate limiting, retry cu backoff.
  Serverul are nevoie de IP fix pentru whitelist — verifică asta întâi.
- Mapare categorii + caracteristici obligatorii, cu UI de mapare în admin
- Publicare oferte: atașare pe part_number_key dacă produsul există în catalogul
  eMAG, altfel documentație de produs nouă + urmărirea validării
- Sincronizare stoc și preț: la eveniment (modificare de stoc) + cron de siguranță.
  Strategie A din §4: stoc comun cu tampon de siguranță configurabil.
- VALIDARE DE SIGURANȚĂ: refuză sincronizarea și alertează dacă prețul trimis
  scade cu peste X% față de ultimul sincronizat. Asta previne dezastre.
- Import comenzi la 5 minute → Order cu channelId=emag, source=emag
- Confirmare automată a comenzilor + alertă dacă una rămâne neconfirmată
- Mapare de statusuri în ambele sensuri, explicită și testată
- Generare AWB și comunicare către eMAG
- Încărcare automată a facturii după emiterea în SmartBill, cu retry
- Import și procesare retururi
- Admin „Canale": status oferte, erori de validare per produs, log de sincronizare,
  buton de sincronizare manuală
- Raport: vânzări pe canal, comisioane, comparație de profitabilitate

Totul în spatele feature flag-ului `emagMarketplace`.
```

### Prompt 21f — Puncte de loialitate și vouchere cadou
```
Implementează sistemul de loializare conform docs/14-loializare-si-vouchere.md.
Prerequisit: comenzile, plățile și retururile funcționează complet.

PARTEA A — PUNCTE
Schema: LoyaltyAccount, LoyaltyTransaction. Setări în grupul „loyalty".
Registrul de tranzacții e IMUTABIL. Soldul se recalculează din tranzacții —
nu scrie niciodată direct în `balance`. Altfel nu vei putea depana niciodată
„de ce am 47 de puncte".

Acumulare: 1 punct la fiecare 100 lei, calculat pe subtotalul DUPĂ toate reducerile,
FĂRĂ transport, cu `floor` (199 lei = 1 punct, nu 2).
Acumulează Standard, Fidel și VIP; Partenerii NU (CustomerGroup.earnsLoyaltyPoints = false).
Discountul Fidel/VIP se cumulează cu punctele.
Acordare: la expirarea ferestrei de retur (14 zile de la livrare), cu status
„în așteptare" vizibil în contul clientului până atunci. Cron zilnic.
Expirare: 12 luni, cu email de avertizare cu 30 de zile înainte.
Răscumpărare: intră ULTIMA în lanțul de reduceri, după cupon. FĂRĂ plafon procentual
implicit (adminul poate seta unul din setări, dacă vrea mai târziu). Minim 10 puncte.
Transportul se plătește mereu în bani.
⚠️ REGULA DURĂ (decizia utilizatorului): suma de plătit în bani trebuie să fie cel puțin
  max(costul transportului, loyalty.minCashAmount), unde minCashAmount e configurabil,
  implicit 100 bani = 1 leu (se aplică la comenzi fără transport: ridicare personală, doar
  digital). Punctele aplicabile ≤ total comandă − acest minim. Comanda de 0 lei NU poate
  apărea, deci NU există ramura paymentMethod = 'loyalty_points' și nici factură de 0 lei.
  Regula nu se poate dezactiva; sliderul din checkout se oprește la maximul permis.
🟡 Înainte de a trece reducerea din puncte pe factură: răspunsul contabilului la „TVA pe 100
  sau pe 90?" (docs/10 Partea I). Dacă nu l-ai primit, 🛑 STOP.

Tratează EXPLICIT toate cazurile din §5 — scrie testele întâi:
- regula dură: cu transport de 300 lei și comandă de 1.000 lei, punctele aplicabile ≤ 700
  lei; fără transport, minimul în bani = minCashAmount; comanda de 0 lei nu poate fi
  produsă niciodată (nici cu plafonul procentual dezactivat); nu există plată 'loyalty_points'
- comandă anulată: punctele acordate se revocă, cele folosite se întorc în cont
- retur parțial: revocare proporțională pe liniile returnate
- retur după ce punctele au fost deja cheltuite: permite sold negativ, blochează
  răscumpărarea până se acoperă
- rambursare pe comandă plătită parțial cu puncte: rambursezi DOAR banii, punctele
  se întorc ca puncte. Nu converti niciodată puncte în bani
- guest checkout: fără puncte, dar afișează „creează cont și primești X puncte"
- puncte expirate în timp ce sunt rezervate într-o comandă activă: blochează expirarea

UI: sold și istoric în cont, „primești X puncte" pe pagina de produs, utilizare
în checkout cu slider. Admin: sold per client, ajustare manuală cu motiv OBLIGATORIU,
raport de datorie totală în puncte.

PARTEA B — VOUCHERE
Schema: Voucher (cu `balance`, nu doar valoare fixă), VoucherTransaction.

⚠️ CRITIC: voucherul NU e o reducere, e o METODĂ DE PLATĂ. Nu îl pune în
motorul de prețuri. Intră la plată, alături de card și ramburs:
    Total de plată: 1.850 lei
      - Voucher CADOU-4F2A:  -500 lei
      - De plătit cu cardul: 1.350 lei
Nu reduce baza de TVA. Se aplică și pe transport. Se cumulează cu orice reducere.

Soldul rămâne pe cod: voucher de 500 folosit la o comandă de 300 → rămân 200 lei
utilizabili ulterior.
🟡 Rămâne deschis cu contabilul (docs/10 Partea I): voucher cumpărat (plată anticipată) vs cod
de reducere gratuit, termenul legal minim de valabilitate și tratamentul voucherului care
acoperă integral o comandă. Până atunci voucherul rămâne METODĂ DE PLATĂ.

Emitere: din admin (valoare, destinatar, mesaj, expirare, email cu design) și ca
produs vândut pe site (valori fixe sau la alegere; codul se generează și se trimite
destinatarului la confirmarea plății). Generare în masă pentru campanii.

Admin: listă cu status și sold, anulare cu motiv, ajustare cu audit,
RAPORT DE DATORIE — valoarea totală a voucherelor neutilizate.
```

### Prompt 22 — Rapoarte și dashboard
```
Implementează rapoartele.

- Dashboard cu KPI: vânzări azi/7z/30z cu comparație perioadă anterioară,
  comenzi de procesat, AOV, rata de conversie, produse fără stoc,
  plăți eșuate, retururi în așteptare, recenzii de moderat
- Grafice: vânzări în timp, top produse, top categorii, vânzări pe județ
- Rapoarte: vânzări (multiple dimensiuni), stoc și valoare de inventar,
  retururi cu motive, cupoane, TVA de raportat, clienți (LTV, cohorte)
- Export XLSX și CSV pentru fiecare raport
- Rapoarte programate trimise pe email
- Query-uri optimizate cu agregări materializate pentru perioade lungi
  (nu scana toată tabela de comenzi la fiecare încărcare de dashboard)
```

### Prompt 23 — Împachetare, distribuție și deploy 🔑
```
Pregătește producția.

- Dockerfile multi-stage pentru apps/web cu output: 'standalone', imagine minimă
- Dockerfile separat pentru worker-ul de joburi
- docker-compose.prod.yml: app, worker, postgres, redis, caddy
- Caddyfile cu SSL automat, HTTP/2, compresie, headers de securitate
- Script de deploy: pull, build, migrate, restart cu zero downtime
- GitHub Actions de deploy pe push în main (cu approval manual)
- Backup: cron zilnic pg_dump + upload S3 off-site, retenție 30 zile,
  plus script de restore testat
- Hardening VPS documentat: user non-root, SSH keys only, UFW, fail2ban,
  unattended-upgrades, swap
- Monitoring: healthcheck extern, alerte pe email/Telegram
- Rotire loguri, limite de memorie pe containere, restart policy
- Mediu de staging identic cu producția
- Pachetul de livrare conform docs/08 §1 varianta A: folder cu docker-compose.yml,
  .env.example, install.sh, update.sh, backup.sh, Caddyfile, /extensions, README
- TEST FINAL: instalare de la zero pe un VPS gol, cronometrată. Țintă: sub 15 minute
  de la SSH până la magazin funcțional cu un produs adăugat.
- Documentația de livrat: README.md (cerințe + instalare), MANUAL-ADMIN.md,
  CHANGELOG.md, RUNBOOK.md (ce faci când pică plata/curierul/DB-ul, cum faci
  rollback, cum restaurezi un backup), EXTENSIONS.md, LEGAL.md
```

### Prompt 24 — Testare finală și hardening
```
Consolidează calitatea înainte de lansare.

- Suite E2E Playwright completă:
  cumpărare ca guest cu ramburs · cumpărare logat cu card (sandbox) ·
  cumpărare cu cupon · retur complet · admin creează produs și îl vede în storefront ·
  admin generează AWB și emite factură · izolare între doi tenanți
- Teste unitare complete pe: pricing, TVA, promoții, transport, state machines, stoc
- Test de concurență pe stoc și pe plasarea comenzii
- Test de idempotență pe toate webhook-urile
- Test de încărcare cu k6: 100 utilizatori simultani pe PDP și checkout
- Audit de accesibilitate cu axe pe paginile principale
- Audit de securitate: headers, rate limits, permisiuni, injectare, XSS pe câmpurile
  rich text, upload de fișiere malițioase
- 2FA pentru conturile de admin
- Verifică checklist-ul legal din docs/05-integrari-romania.md §9
- Verifică checklist-ul din docs/06-todo-master.md Faza 17
```

---

## Prompturi utile pe parcurs

**Când vrei să înțelegi ce s-a scris:**
```
Explică-mi arhitectura fluxului de plasare a comenzii, așa cum e implementat acum.
Unde sunt punctele de risc? Ce se întâmplă dacă procesul cade după crearea comenzii
dar înainte de rezervarea stocului?
```

**Înainte de fiecare fază nouă:**
```
Citește docs/06-todo-master.md. Rezumă ce e implementat până acum și ce urmează.
Identifică orice datorie tehnică pe care ar trebui să o rezolvăm înainte de a merge mai departe.
```

**Review de cod:**
```
Fă un review critic al codului din packages/core/checkout. Caută: race conditions,
tranzacții incomplete, scoping de tenant lipsă, erori netratate, validări lipsă,
și locuri unde logica de business a scăpat în componente React.
```

**Când ceva e lent:**
```
Pagina X se încarcă în Ys. Analizează query-urile Prisma generate, identifică
N+1-urile și indexurile lipsă, și propune un plan de optimizare cu măsurători.
```

**La final de sesiune:**
```
Actualizează docs/06-todo-master.md cu ce am terminat azi. Scrie un rezumat scurt
în docs/PROGRESS.md cu: ce s-a implementat, ce decizii am luat, ce a rămas nerezolvat,
și de unde se reia data viitoare.
```
