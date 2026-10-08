# 01 — Arhitectură, stack și decizii (revizuit)

## 0. Modelul confirmat: **pachet instalabil, o instalare = un magazin**

Nu construim SaaS multi-tenant. Construim un **produs** — ca WordPress sau PrestaShop, dar în Next.js: un pachet neutru, fără brand, pe care îl instalezi pe un server și îl personalizezi complet din panoul de administrare.

### Ce înseamnă asta concret

| | |
|---|---|
| **O instalare** | O bază de date, un magazin, un domeniu |
| **Branding** | 100% din panoul de admin: nume, logo, favicon, culori, fonturi, texte, date firmă |
| **Cod** | Identic pe toate instalările. **Niciodată nu modifici core-ul per client.** |
| **Personalizări** | Prin setări, temă, blocuri CMS, CSS custom și extensii — nu prin fork |
| **Actualizări** | O versiune nouă a pachetului se aplică pe toate instalările |

### ✅ Ce câștigăm față de multi-tenant
- **Fără `tenantId` pe 60 de tabele.** Scade complexitatea cu ~25% și dispare cea mai periculoasă clasă de bug-uri (scurgeri de date între clienți).
- Query-uri mai simple, indexuri mai simple, testare mai simplă.
- Izolare totală: un client picat nu afectează pe nimeni.
- Fiecare client își are propriul VPS, propriile chei de plăți/curier, propriul backup.

### ⚠️ Ce apare în schimb (și lipsea din planul inițial)
1. **Instalator** — un wizard de instalare în browser. Fără el, fiecare instalare e o operațiune manuală de 2 ore.
2. **Mecanism de actualizare** — cum duci un fix la 20 de instalări existente.
3. **Sistem de extensii** — ca să poți personaliza pentru un client fără să faci fork.
4. **Zero hardcodare** — nici măcar numele tău în footer. Totul din DB.
5. **Distribuție** — Next.js nu e PHP, „urci arhiva pe server" înseamnă altceva. Vezi fișierul 08.

> 📄 Toate cele 5 sunt detaliate în **`08-instalare-si-distributie.md`**.

### Singura decizie de hedge pe care ți-o recomand
Nu adăuga `tenantId`. Dar **ține tot accesul la date în `packages/core`**, în servicii, nu împrăștiat prin componente. Dacă peste doi ani vrei o versiune SaaS, scoping-ul se adaugă într-un singur loc, nu în 400.

**Excepție de discutat**: dacă un client va vrea vreodată două magazine pe aceeași instalare (ex. `magazin.ro` + `shop.hu` cu același stoc), acela e „multi-store", nu multi-tenant, și se rezolvă cu un `storeId` doar pe câteva entități (Order, Page, Setting, Price). Nu-l construi acum, dar nu-l face imposibil.

---

## 1. Stack

| Strat | Alegere | Notă |
|---|---|---|
| Framework | **Next.js 15+, App Router, TypeScript strict** | Server Components + Server Actions |
| DB | **PostgreSQL 16** | Tranzacții, JSONB, FTS |
| ORM | **Prisma** | Migrații versionate — critice pentru mecanismul de update |
| Auth | **Better Auth** sau **Auth.js v5** | Roluri + conturi de firmă (B2B) |
| UI | **Tailwind + shadcn/ui** | shadcn = cod în repo, deci temabil din DB |
| Formulare | **React Hook Form + Zod** | Schema partajată client/server |
| Cache/cozi | **Redis** + **BullMQ** | Sesiuni, coș guest, rate limit, joburi |
| Fișiere | **Local disk sau S3-compatible** | La o instalare per client, discul local + backup e acceptabil. Fă-l comutabil din setări. |
| Email | **SMTP configurabil din admin** (+ Resend/Postmark opțional) | Clientul trebuie să-și poată pune propriul SMTP fără să atingă codul |
| Search | Postgres FTS + `pg_trgm` → Meilisearch peste ~5.000 produse | Meilisearch opțional, activabil din setări |
| Plăți | **Netopia + EuPlătesc** | Confirmat |
| Curieri | **Sameday + FAN Courier** | Confirmat |
| Facturare | **Oblio + SmartBill** (cu e-Factura) | Confirmat |
| Erori | **Sentry** (opțional, DSN din setări) | |
| Teste | **Vitest** + **Playwright** | |
| Distribuție | **Docker Compose** | Vezi fișierul 08 |

### Ce NU facem
❌ Microservicii · ❌ GraphQL · ❌ Kubernetes · ❌ CMS extern · ❌ MongoDB · ❌ abstractizări „pentru viitor"

---

## 2. Structura repo

```
ecom-package/
├─ apps/
│  └─ web/
│     ├─ src/app/
│     │  ├─ (storefront)/         # magazin public
│     │  ├─ (admin)/admin/        # panou de administrare
│     │  ├─ (auth)/
│     │  ├─ install/              # wizard de instalare (se blochează după setup)
│     │  ├─ api/                  # webhook-uri, feed-uri, API v1
│     ├─ middleware.ts            # auth guard + redirect la /install dacă nu e instalat
├─ packages/
│  ├─ db/                         # Prisma schema, migrații, seed
│  ├─ core/                       # logica de business — FĂRĂ React
│  │  ├─ catalog/ cart/ checkout/ orders/ pricing/ inventory/
│  │  ├─ promotions/ shipping/ payments/ invoicing/ returns/
│  ├─ ui/                         # design system (tokens din DB)
│  ├─ emails/                     # React Email
│  ├─ integrations/
│  │  ├─ payments/{netopia,euplatesc,bank-transfer,cod}/
│  │  ├─ shipping/{sameday,fancourier}/
│  │  ├─ invoicing/{oblio,smartbill}/
│  ├─ jobs/                       # workers BullMQ
│  ├─ config/                     # env schema (Zod), constante, versiune pachet
│  ├─ extensions/                 # registry de hooks + override-uri (vezi fișier 08)
│  └─ shared/                     # tipuri, utils, Money, erori
├─ extensions/                    # ⚠️ zonă NEATINSĂ de update — personalizări per client
├─ docker/
├─ scripts/                       # install.sh, update.sh, backup.sh
├─ docs/
├─ e2e/
└─ CLAUDE.md
```

**Regula de aur:** logica de business trăiește în `packages/core`. `PlaceOrderUseCase` trebuie apelabil din server action, API REST, panou admin, worker și test — fără să știe de React.

---

## 3. Setări: inima white-label-ului

Împărțirea corectă între `.env` și baza de date:

| `.env` (setat la instalare, tehnic) | Baza de date (editabil din admin) |
|---|---|
| `DATABASE_URL` | Numele magazinului, slogan |
| `REDIS_URL` | Logo, favicon, OG image |
| `APP_KEY` (criptare integrări) | Culori, fonturi, radius, preset temă |
| `APP_URL` | Date firmă: CUI, Reg.Com., sediu, IBAN |
| `NODE_ENV` | SMTP / provider email + expeditor |
| `STORAGE_DRIVER` (local\|s3) + credențiale | Chei Netopia/EuPlătesc (criptate) |
| `SENTRY_DSN` (opțional) | Chei Sameday/FAN (criptate) |
| | Chei Oblio/SmartBill (criptate) |
| | TVA, monedă, limbă, fus orar |
| | Metode de plată și livrare active |
| | Texte legale, meniuri, pagini |
| | Feature flags (blog on/off, B2B on/off, recenzii on/off) |

**Test de validare:** dacă poți lua instalarea A, îi schimbi doar setările din admin și obții un magazin care arată complet diferit de instalarea B — ai reușit. Dacă trebuie să atingi un fișier `.tsx`, ai eșuat.

### Design tokens
```
--color-primary --color-primary-fg --color-accent --color-bg --color-fg
--color-muted --color-border --color-success --color-danger
--radius --font-heading --font-body --container-width
```
Stocate în tabela `Branding`, injectate server-side ca `<style>` în layout → zero flash de temă greșită. **Nicio culoare hardcodată în nicio componentă.**

---

## 4. Feature flags (B2B, blog, recenzii, multi-limbă)

Pentru că e un pachet unic instalat la clienți diferiți, aproape totul trebuie să se poată stinge:

```ts
FEATURES = {
  blog: true,
  reviews: true,
  wishlist: true,
  multiCurrency: false,
  multiLanguage: false,
  multiWarehouse: false,
  giftCards: false,
  loyaltyPoints: false,
  marketplaceSync: false,
  guestCheckout: true,
  customerGroups: true,    // discount procentual pe grupuri (Partener, Client fidel)
}
```
Helper `isEnabled('blog')` folosit în UI, în rute și în API. Un flag stins înseamnă: meniu ascuns în admin, rută care dă 404, cod care nu se încarcă.

---

## 5. Convenții obligatorii

- **Bani**: `int` în bani. `1999` = 19,99 lei. Helper `Money`. Niciodată `float`.
- **TVA**: stocat pe linie de comandă (rată + valoare). Cote configurabile din admin.
- **Date**: UTC în DB, afișare în fusul din setări.
- **ID-uri**: `cuid2` sau `uuidv7`. Nu auto-increment.
- **Slug-uri**: unice, imutabile după publicare, cu redirect automat la schimbare.
- **Erori**: `DomainError`, `ValidationError`, `IntegrationError` cu cod stabil.
- **Validare Zod** la marginea sistemului: formular, API, webhook, env.
- **Idempotență** pe webhook-uri și plasare comandă.
- **Audit** pe orice scriere din admin.
- **Soft delete** pe produse, comenzi, clienți. Hard delete doar la cerere GDPR.
- **Snapshot pe comandă**: produs, preț, TVA, adrese — copiate. Comanda nu se schimbă retroactiv.
- **Migrații idempotente și reversibile** — de asta depinde mecanismul de update.

## 6. Securitate

- Rate limiting (login, register, forgot, checkout, contact, API)
- CSRF pe mutații, cookies `httpOnly` + `secure` + `SameSite=Lax`
- Headers: CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy
- **Chei de integrare criptate AES-256-GCM cu `APP_KEY` din `.env`** (nu în DB)
- Verificare semnătură pe toate webhook-urile
- RBAC verificat pe server
- `/install` blocat definitiv după instalare (flag în DB + verificare)
- Upload: validare MIME reală, re-encodare imagini, nume randomizate
- 2FA pentru admini
- Backup zilnic + test de restore lunar

---

## 7. Ce mai rămâne de decis

Toate întrebările deschise sunt centralizate în **`10-decizii-deschise.md`**, cu recomandarea mea pentru fiecare. Completează-l înainte de Faza 1.

Deciziile deja luate:
- ✅ Model: pachet instalabil, o instalare = un magazin
- ✅ Prețuri afișate **cu TVA inclus**, identice pentru toți
- ✅ Fără prețuri ascunse: vizitatorul vede prețul complet
- ✅ Grupuri de clienți cu discount procentual (Partener, Client fidel) — vezi `09`
- ✅ **Fără modul B2B clasic** (fără liste de prețuri, tranșe, conturi de firmă multi-utilizator)
- ✅ Integrări: Netopia / EuPlătesc · Sameday / FAN Courier · Oblio / SmartBill
