# Platformă eCommerce white-label

## Ce construim

Platformă de eCommerce în Next.js, cu storefront public și panou de administrare
complet, livrată ca PACHET INSTALABIL: o instalare = un magazin. Același cod rulează
pe mai multe instalări; branding, conținut și integrări diferă prin setări. Piața
țintă: România.

## Stack

- Node.js 24 LTS, pnpm
- Next.js 15 App Router, TypeScript strict, React Server Components
- PostgreSQL + Prisma, Redis (cache/sesiuni/cozi), BullMQ
- Tailwind CSS + shadcn/ui, React Hook Form + Zod
- S3-compatible storage (MinIO local), React Email
- Vitest (unit/integrare) + Playwright (E2E)
- Docker Compose pentru dezvoltare locală

## Structura

- `apps/web` — aplicația Next.js: `(storefront)`, `(admin)`, `api`
- `packages/db` — Prisma schema, migrații, seed
- `packages/core` — logica de business (services, use-cases). **Fără React aici.**
- `packages/ui` — design system
- `packages/integrations` — adaptoare externe (plăți, curieri, facturare)
- `packages/jobs` — workers BullMQ
- `packages/shared` — tipuri, utils, erori
- `docs/` — specificațiile proiectului. Citește-le înainte de a lucra la o zonă nouă.

## Reguli obligatorii

### Configurabilitate (white-label) — regula #1 a proiectului

Acesta e un PACHET INSTALABIL: o instalare = un magazin. NU e multi-tenant, deci nu
există `tenantId`. În schimb:

- **Nimic hardcodat.** Numele magazinului, logo-ul, culorile, datele firmei, cotele
  de TVA, textele legale, expeditorul de email — toate vin din tabelele `Setting`
  și `Branding`, editabile din admin.
- Dacă scrii o culoare, un text de brand sau o valoare de business direct în cod,
  e un bug. Culorile vin din CSS variables generate din `Branding`.
- `.env` conține DOAR secrete și conexiuni (DB, Redis, APP_KEY, APP_URL, storage).
  Restul e în baza de date.
- Funcționalitățile opționale (blog, recenzii, wishlist, multi-depozit, loialitate,
  vouchere) sunt în spatele unui feature flag. `isEnabled('blog')` ascunde meniul,
  ruta ȘI codul.
- Accesul la date stă în servicii în `packages/core`, nu împrăștiat în componente.
- Personalizările pentru un client se fac prin setări, temă, blocuri CMS sau
  `/extensions`. **Niciodată prin modificarea core-ului.**

### Prețuri (citește docs/09-preturi-si-parteneri.md)

- Prețurile se stochează BRUT, cu TVA inclus, ca `int` în bani. `19900` = 199,00 lei.
  Ce tastează adminul e ce vede clientul. TVA-ul se EXTRAGE din brut pentru factură.
- Un singur preț public pentru toți. Clienții dintr-un grup cu discount (Partener,
  Client fidel) văd același preț minus procentul grupului.
- Nu există comutator „cu/fără TVA" și nu există prețuri ascunse.
- Rotunjirea se face pe LINIE de comandă, o singură dată. Totalul e suma liniilor.
- Un singur motor de prețuri în packages/core/pricing, apelat din PLP, PDP, coș,
  checkout și factură. Niciun calcul de preț duplicat altundeva.
- Discountul de grup NU se cumulează implicit cu prețul promoțional (se ia cel mai
  mic), decât dacă grupul are `stacksWithSalePrice = true`. Cuponul SE cumulează,
  cu excepția cupoanelor marcate `notForDiscountedGroups`.

### Stoc — model WooCommerce

- Setare globală `inventory.manageStock` (implicit ON) = valoarea implicită pentru
  produsele noi. Bifă per produs `manageStock` care o suprascrie. La produse cu
  variante, bifa poate coborî și la nivel de variantă.
- `manageStock = true`: cantități reale, rezervare la inițierea plății cu expirare
  15 minute, decrement la confirmare, alerte de stoc mic, istoric de mișcări.
- `manageStock = false`: disponibilitatea e un simplu dropdown `stockStatus`
  (în stoc / stoc epuizat / la comandă). ZERO InventoryItem, zero rezervări,
  zero decrement. Ramură explicită în cod — NU simula cu o cantitate mare.

### Produse digitale (docs/11-produse-digitale.md)

- Coșul poate fi fizic, digital sau MIXT. Transportul se calculează doar pe liniile
  fizice. Coș 100% digital = fără pas de livrare, fără ramburs.
- Accesul se acordă prin `DigitalEntitlement` la confirmarea plății și se revocă
  la rambursare. Linkurile sunt semnate, cu expirare scurtă — niciodată permanente.
- Bifa legală de renunțare la dreptul de retragere e SEPARATĂ de acceptarea
  Termenilor, neprebifată, obligatorie, și se salvează pe comandă.

### Loialitate și vouchere (docs/14-loializare-si-vouchere.md)

- Punctele se țin într-un registru imutabil (LoyaltyTransaction). Soldul se
  RECALCULEAZĂ din tranzacții, nu se editează direct niciodată.
- Reducerea din puncte intră ULTIMA în lanțul de reduceri, după cupon.
- ⚠️ Voucherul cadou NU e o reducere. E o METODĂ DE PLATĂ, alături de card și
  ramburs. Nu intră în motorul de prețuri și nu reduce baza de TVA.

### Nișa: echipamente pentru piscine (docs/15-specific-nisa-piscine.md)

- Produsele sunt grele și voluminoase. Costul de transport se calculează pe
  greutatea volumetrică ((L×l×h)/5000) sau pe cea reală, care e mai mare.
- Produsele `oversized` nu pot merge la easybox — ascunde opțiunea automat.
- Pompele de căldură și dezumidificatoarele au nevoie de etichetă energetică
  afișată înainte de finalizarea comenzii, nu doar în specificații.
- Atributele tehnice sunt numerice, cu unitate de măsură, și trebuie filtrabile
  pe interval (slider), nu doar pe valoare exactă.

### Canale de vânzare (docs/12-emag-marketplace.md)

- `Order.channelId` și `ChannelListing` există din Faza 4, chiar dacă eMAG vine
  mai târziu. `ean` și `warrantyMonths` sunt obligatorii pe variantă.

### Bani și taxe

- Sumele sunt `int` în bani (minor units). `1999` = 19,99 RON. Niciodată `float`.
- Folosește helperul `Money` din `packages/shared`. Rotunjirea se face pe linia de
  comandă, o singură dată (vezi „Prețuri"), nu pe total.
- TVA-ul se stochează pe linia de comandă (rată + valoare) și nu se recalculează
  retroactiv. Cotele vin din setări, nu sunt hardcodate.

### Comenzi

- Trei câmpuri de status separate: `status`, `paymentStatus`, `fulfillmentStatus`.
- Tranzițiile sunt validate de un state machine explicit. Fără `order.status = x` direct.
- Comanda păstrează un snapshot imutabil (produs, preț, TVA, adrese).
- Orice acțiune pe comandă scrie un `OrderEvent`.

### Cod

- TypeScript strict. Fără `any`, fără `@ts-ignore` fără explicație în comentariu.
- Validare Zod la marginea sistemului: formulare, API, webhook-uri, variabile de mediu.
- Logica de business în `packages/core`, apelabilă din server action, API, worker și test.
- Erori tipate (`DomainError`, `ValidationError`, `IntegrationError`) cu cod stabil.
- Server Components implicit; `"use client"` doar unde e strict necesar.
- Fără culori hardcodate în componente — doar CSS variables din tokens de temă.
- Toate scrierile din admin trec prin `auditLog()`.
- Webhook-urile: verificare semnătură + idempotență, întotdeauna.
- Side-effects (email, AWB, factură) prin queue, niciodată sincron în tranzacție.

### Comenzi utile

- `pnpm dev` — pornește aplicația
- `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:studio`
- `pnpm test` / `pnpm test:e2e`
- `pnpm lint` / `pnpm typecheck`
- `docker compose -f docker/docker-compose.dev.yml up -d`

### Definiția de „gata"

Un task e gata când: typecheck trece, lint trece, testele trec, funcționează manual
în browser (verificat de utilizator), are audit log dacă e acțiune de admin,
commit-ul e făcut, și `docs/06-todo-master.md` e bifat.

### Protocol de raportare — OBLIGATORIU

Citește `docs/13-protocol-de-lucru.md` și respectă-l la literă. Pe scurt:

- Nu începe niciun punct din TODO fără anunțul **🟢 ÎNCEP** (ce faci, ce fișiere
  atingi, cât durează). Marchează punctul cu `[~]`.
- Nu termina niciun punct fără anunțul **✅ GATA**, care include OBLIGATORIU
  secțiunea „👉 VERIFICĂ TU" cu pași concreți de testat în browser.
  Marchează `[x]` doar după ce utilizatorul confirmă.
- La finalul unei faze: **🏁 FAZĂ TERMINATĂ**, cu rezumat în limbaj de om și
  verificare cap-coadă.
- Când ai nevoie de o decizie: **🛑 STOP**, marchează `[!]` și OPREȘTE-TE. Nu ghici.
- Un singur `[~]` poate exista în tot fișierul TODO la un moment dat.
- La finalul fiecărei sesiuni, actualizează `docs/PROGRESS.md` în formatul din §4
  al protocolului.
- Un commit per punct terminat. Fără commit-uri uriașe la final de zi.

## Ce să NU faci

- Nu instala librării grele fără să întrebi.
- Nu schimba schema Prisma fără migrație.
- Nu scrie logică de business în componente React.
- Nu adăuga microservicii, GraphQL sau abstractizări „pentru viitor".
- Nu genera sute de fișiere deodată. Lucrează incremental, cu commit-uri.
