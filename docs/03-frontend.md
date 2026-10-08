# 03 — Necesar Frontend (storefront)

## 1. Sitemap complet

```
/                                  Homepage
/magazin                           Toate produsele
/categorie/[...path]               Categorie (nested: /categorie/barbati/incaltaminte)
/produs/[slug]                     Pagina de produs (PDP)
/brand/[slug]                      Pagina de brand
/colectie/[slug]                   Colecție / campanie
/cautare?q=                        Rezultate căutare
/cos                               Coș
/checkout                          Checkout
/checkout/plata/[orderId]          Redirect / 3DS către procesator
/comanda/confirmare/[token]        Mulțumim + sumar
/comanda/urmarire                  Tracking pentru guest (nr. comandă + email)

/cont                              Dashboard client
/cont/comenzi                      Istoric comenzi
/cont/comenzi/[id]                 Detaliu comandă + facturi + AWB
/cont/adrese                       Agendă adrese
/cont/retururi                     Retururi + inițiere retur nou
/cont/favorite                     Wishlist
/cont/recenzii                     Recenziile mele
/cont/date-personale               Date, parolă, GDPR (export/ștergere)
/cont/abonamente                   (dacă e cazul)

/autentificare                     Login
/inregistrare                      Register
/recuperare-parola                 Forgot password
/resetare-parola/[token]           Reset password
/verificare-email/[token]          Email verification

/blog                              Listă articole
/blog/[slug]                       Articol
/blog/categorie/[slug]             Categorie blog

/contact                           Contact + formular + hartă + program
/despre-noi
/livrare-si-plata
/intrebari-frecvente
/termeni-si-conditii
/politica-de-confidentialitate
/politica-cookie-uri
/politica-de-retur                 + formular de retragere descărcabil
/gdpr
/anpc                              sau doar linkuri în footer
/garantii

/sitemap.xml  /robots.txt  /feed/google.xml  /feed/facebook.xml  /rss.xml
/404  /500  /mentenanta
```

---

## 2. Pagină cu pagină — ce conține și de ce date are nevoie

### Homepage
Secțiuni configurabile din admin, în ordine drag & drop:
`Hero slider` · `Categorii evidențiate` · `Produse noi` · `Bestsellers` · `Banner campanie` · `Colecție curatoriată` · `Bandă de beneficii (livrare gratuită, retur 30 zile, plată securizată)` · `Branduri` · `Articole blog` · `Recenzii clienți` · `Newsletter` · `Instagram/UGC`

Fiecare secțiune = un „block type" cu schema proprie. Aceasta e piesa care face homepage-ul *editabil*, nu hardcodat — esențial pentru white-label.

### PLP (categorie / căutare / brand / colecție)
- Breadcrumbs, titlu, descriere SEO (colapsabilă)
- **Filtre** în sidebar desktop / drawer mobil: preț (slider), brand, atribute dinamice, disponibilitate, reducere, rating
- Contorizări pe fiecare filtru; filtrele se reflectă în URL (`?brand=x&pret=100-300`) — shareable și indexabil controlat
- Sortare + număr per pagină
- Grid de carduri: imagine (cu hover pe a doua), badge-uri, titlu, rating, preț + preț tăiat + procent, variante rapide (culori), buton adăugare rapidă, wishlist
- Paginare cu SEO corect (nu infinite scroll pur — folosește „load more" + link paginat)
- Stare goală („niciun rezultat") cu sugestii

### PDP — pagina de produs (cea mai importantă pagină din magazin)
- Galerie: zoom, thumbnails, video, lightbox, swipe pe mobil
- Titlu, brand, SKU, rating agregat + link la recenzii
- Preț: curent, tăiat, procent, **„cel mai mic preț din ultimele 30 zile" (Omnibus)**, preț pe unitate de măsură
- Pentru clienții dintr-un grup cu discount: **prețul de partener** + prețul standard tăiat + badge „Preț partener −X%" (vezi `09-preturi-si-parteneri.md` §4)
- Selector variante (dezactivează combinațiile inexistente, schimbă imaginea și prețul)
- Cantitate + Adaugă în coș + Cumpără acum + Wishlist
- Stoc: „În stoc, livrare 24-48h" / „Ultimele 3 bucăți" / „Stoc epuizat + anunță-mă"
- Estimare livrare și cost, calculator de transport
- Beneficii: retur 14 zile, garanție 24 luni, plată securizată
- Taburi: Descriere · Specificații · Livrare & retur · Recenzii · Întrebări
- **GPSR**: date producător / persoană responsabilă UE, avertismente
- Produse similare, accesorii, „cumpărate împreună"
- Recent vizualizate
- Sticky add-to-cart pe mobil la scroll
- Structured data Product + Offer + AggregateRating

### Coș
- Linii cu imagine, variantă, preț unitar, cantitate editabilă, subtotal, ștergere (cu undo)
- Cod de reducere
- Estimare transport
- Indicator prag transport gratuit
- Sumar: subtotal, transport, reducere, TVA, total
- „Continuă cumpărăturile" + „Finalizează comanda"
- Cross-sell sub coș
- Coș gol cu recomandări

### Checkout — fluxul complet
Recomandare: **o singură pagină, cu pași accordion** (rate de conversie mai bune decât 4 pagini).

```
1. Contact       → email (+ telefon). „Ai deja cont? Autentifică-te" (opțional, nu blocant)
2. Livrare       → nume, telefon, județ, localitate, adresă, cod poștal
                   sau selectare easybox/punct ridicare pe hartă
3. Metodă livrare→ curier standard / easybox / ridicare personală, cu preț și estimare
4. Facturare     → „la fel ca livrarea" bifat implicit; opțional persoană juridică (CUI + validare ANAF)
5. Plată         → card online / ramburs / transfer bancar / (BNPL)
6. Sumar         → linii, totaluri, cupon
7. Acorduri      → checkbox Termeni (obligatoriu), newsletter (opțional, neprebifat)
8. [Plasează comanda]
```
Reguli:
- Salvare progresivă în `localStorage` + server (nu pierde datele la refresh)
- Validare inline, mesaje clare, fără reload
- Metodele de plată/livrare se recalculează dinamic (ex: ramburs indisponibil peste 5.000 lei)
- Buton dezactivat + spinner + **protecție la dublu-click** (idempotency key)
- Fără header/footer complet — checkout „curat", doar logo + indicator de securitate
- Tracking evenimente: `begin_checkout`, `add_shipping_info`, `add_payment_info`, `purchase`

### Confirmare comandă
Număr comandă, sumar, ce urmează (pași), estimare livrare, link tracking, buton creare cont din comandă, descărcare factură (când e gata), share/referral. Eveniment `purchase` trimis o singură dată (protecție la refresh).

### Cont client
Dashboard cu ultimele comenzi + acțiuni rapide. Detaliu comandă: timeline de status, linii, adrese, plată, facturi PDF, AWB + link tracking curier, buton „solicită retur", buton „comandă din nou".

### Contact
Formular (nume, email, telefon, subiect, mesaj, atașament opțional) cu honeypot + rate limit + captcha invizibil. Date firmă complete, hartă, program, canale (WhatsApp/telefon).

---

## 3. Componente partajate (design system)

**Layout**: `Header` (sticky, cu search, cont, wishlist, cart badge) · `MegaMenu` · `MobileNav` (drawer) · `Footer` (coloane configurabile + ANPC/SOL + plăți acceptate) · `AnnouncementBar` · `Breadcrumbs`

**Comerț**: `ProductCard` · `ProductGrid` · `PriceDisplay` (gestionează preț redus, Omnibus și prețul de partener — singura componentă care afișează prețuri) · `VariantSelector` · `QuantityStepper` · `AddToCartButton` · `StockBadge` · `Rating` · `WishlistButton` · `CartDrawer` · `OrderSummary` · `ShippingSelector` · `PaymentSelector` · `AddressForm` (cu județe/localități RO) · `CouponInput`

**Conținut**: `BlockRenderer` (mapează tipuri de blocuri CMS la componente) · `RichText` · `Hero` · `Banner` · `FAQAccordion` · `Newsletter`

**UI**: `Button` `Input` `Select` `Checkbox` `Radio` `Dialog` `Sheet` `Tabs` `Accordion` `Toast` `Skeleton` `Pagination` `EmptyState` `Spinner` `Tooltip` `Badge`

**Utilitare**: `SeoHead` · `StructuredData` · `CookieConsent` · `AnalyticsProvider` · `ErrorBoundary`

---

## 4. Temare (mecanica white-label)

```ts
// Tokens din tabela Branding, injectate server-side ca CSS variables
--color-primary, --color-primary-fg, --color-accent, --color-bg, --color-fg,
--color-muted, --color-border, --color-success, --color-danger,
--radius, --font-heading, --font-body, --container-width, --spacing-unit
```
- Toate componentele consumă **doar** tokens, niciodată culori hardcodate.
- Logo, favicon, OG image din `Branding`, editabile din admin.
- Un `<style>` cu variabilele se randează în layout-ul server → zero flash de temă greșită.
- Presets de temă în admin + editor cu preview live.
- Dark mode opțional, activabil din setări.

---

## 5. Performanță

- Server Components implicit; `"use client"` doar unde e nevoie de interactivitate
- Streaming + `<Suspense>` cu skeletons pe secțiunile lente
- `next/image`, `priority` doar pe LCP, `sizes` corect
- `next/font` cu `display: swap`, self-hosted
- ISR pe PDP/PLP (`revalidate` + `revalidateTag` la salvare în admin)
- Prefetch pe hover pentru carduri de produs
- Bundle: analizează cu `@next/bundle-analyzer`; scoate librăriile grele din bundle-ul inițial
- Fără layout shift: dimensiuni fixe pentru imagini, skeletons de aceeași înălțime
- Scripturi terțe (pixeli, chat) încărcate `afterInteractive` sau doar după consimțământ

**Buget**: JS inițial < 150 KB gzip pe PDP · LCP < 2.5s pe 4G mobil · scor Lighthouse mobil ≥ 90.

## 6. Accesibilitate
Contrast AA · navigare completă din tastatură · focus vizibil · label-uri pe toate inputurile · `aria-live` pentru adăugare în coș și erori · alt-text obligatoriu la upload de imagini în admin · `prefers-reduced-motion` respectat · skip-to-content.

## 7. Mobile-first
Peste 70% din traficul de eCommerce în RO e mobil. Proiectează întâi ecranul de 375px: sticky add-to-cart, filtre în bottom sheet, checkout cu tastatură numerică pe telefon (`inputmode`), butoane minim 44px, fără hover-only.
