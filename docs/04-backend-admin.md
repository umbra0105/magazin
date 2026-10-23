# 04 — Necesar Backend + Panou de administrare

## 1. Model de date

> ⚠️ **Revizuit**: modelul e *pachet instalabil, o instalare = un magazin*. **Nu există `tenantId`.**
> Pentru B2B, vezi tabelele suplimentare din `09-preturi-si-parteneri.md` §1.

Toate tabelele au: `id`, `createdAt`, `updatedAt`, iar cele de business și `deletedAt`.

### Configurare instalare
```
Setting           key, value(JSON), group  — general, company, regional, tax,
                                             checkout, email, legal, seo, appearance
Branding          logo, favicon, ogImage, tokens(JSON), themePreset, customCss, customJs
FeatureFlag       key, enabled
Integration       type, provider, credentials(criptat AES-256-GCM), config, isActive
Installation      version, installedAt, lastUpdateAt, licenseKey?
```

### Utilizatori și acces
```
User              email, passwordHash, name, phone, emailVerifiedAt, twoFactorSecret
Role              name, isSystem
Permission        key ("orders.refund", "products.write", ...)
RolePermission    roleId, permissionId
UserRole          userId, roleId
Session           userId, token, ip, userAgent, expiresAt
Customer          userId?, email, phone, firstName, lastName, groupId,
                  acceptsMarketing, totalSpent, ordersCount, notes, tags
CustomerGroup     name, slug, pricingType(none|discount|cost_plus),
                  discountBps?, markupBps?, isDefault, stacksWithSalePrice,
                  earnsLoyaltyPoints, freeShippingThreshold?, minOrderValue?,
                  color, isActive
                  → detalii în 09-preturi-si-parteneri.md
Address           customerId, type, firstName, lastName, company, vatId, regCom,
                  phone, county, city, street, number, details, postalCode, country, isDefault
```

### Reguli pentru schema bazei

- **CHECK compus = comparații explicite pe NULL.** Un CHECK al cărui rezultat e NULL TRECE (NULL nu e fals). `(x IS NULL AND y IS NULL) OR (x BETWEEN 0 AND 9 AND y BETWEEN 0 AND 9)` acceptă `x = 5, y = NULL`, fiindcă a doua ramură dă NULL. Corect: `(x IS NULL AND y IS NULL) OR (x IS NOT NULL AND y IS NOT NULL AND x BETWEEN … AND y BETWEEN …)`. Fiecare CHECK compus are un test cu cazul „una setată, una nulă” (exemple: `parts_diagram_hotspot_position_check`, `channel_listing_salePrice_check`).
- Enum-urile sunt `TEXT` cu CHECK în migrație, cu lista și în constanta din `@ecom/core` (un test verifică potrivirea).
- Sumele sunt `int` în bani; procentele `int` în puncte de bază; măsurile fizice `int` (grame, milimetri); valorile tehnice zecimale `NUMERIC`, niciodată `float`.
- Unicitatea fără diferență de majuscule și cea condiționată (soft delete, NULL în părinte) se scriu ca indecși parțiali în migrație.

### Catalog
```
Product           slug, title, subtitle, description(rich), status(draft|active|archived),
                  brandId?(opțional; obligatoriu doar la publicarea pe eMAG), taxClassId, type(physical|digital),
                  requiresInstallation, shippingClass(standard|oversized|pallet),
                  legacyId?, legacyUrl?,
                  energyClass?(A+++…G), eprelUrl?(https),
                  gpsrManufacturerName?, gpsrManufacturerContact?,
                  gpsrResponsibleName?, gpsrResponsibleContact?, safetyWarnings?,
                  manageStock(bool), stockStatus(instock|outofstock|onbackorder)
                  excludeFromGroupDiscount, expectedRestockDate?, allowBackorder,
                  publishedAt, sortOrder, metadata(JSON)
ProductVariant    productId, sku, ean?, warrantyMonths?, manufacturerPartNumber?, manufacturerName?,
                  price, salePrice?, saleStartsAt?, saleEndsAt?,
                  costPrice(NET, fără TVA, DOAR admin), costPriceDate,
                  weightGrams, lengthMm, widthMm, heightMm, manageStock?, stockStatus?,
                  position, isDefault, legacyId?
                  (price = BRUT, cu TVA inclus, int în bani)
CostPriceHistory  variantId, costPrice, effectiveDate, source(manual|import), importId?, createdAt
                  (doar admin; costPrice nu apare în API public, snapshot, feed-uri sau loguri)
ProductOption     productId, name("Mărime"), position
OptionValue       optionId, value("42"), position
VariantOptionValue variantId, optionValueId
Category          parentId, slug, name, description, image, path, depth, sortOrder
ProductCategory   productId, categoryId, isPrimary
Brand             slug, name, logo, description
Collection        slug, name, type(manual|automated), rules(JSON)
Attribute         code, name, type(text|number|select|bool), isFilterable, unit(doar number), sortOrder
AttributeOption   attributeId, value, position            (valorile unui atribut select)
AttributeValue    productId, attributeId, textValue|numberValue(NUMERIC 18,4)|boolValue|optionId (exact una)
Media             url, key, mime, width, height, size, alt, folder
ProductMedia      productId, variantId?, mediaId, position
ProductRelation   productId, relatedProductId, type(similar|accessory|upsell|crosssell|spare_part|compatible_with), position
                  Sensul: productId = produsul PRINCIPAL, relatedProductId = ASOCIATUL (spare_part: piesa de
                  schimb a principalului; compatible_with: principalul e compatibil cu cel asociat). Relația
                  NU e simetrică automat: se creează într-un singur sens. Adminul (editorul de produs, tabul
                  „Asociate”) o arată din ambele părți: „Asociate acestui produs” și „Acest produs e asociat la”.
DigitalProduct    productId, deliveryType, accessType, accessDays, maxDownloads
DigitalAsset      productId, title, type(video|file|link), storageKey,
                  fileSize, duration, position, isPreview
DigitalEntitlement orderId, orderLineId, customerId, productId, grantedAt,
                  expiresAt, downloadCount, maxDownloads, revokedAt, accessToken
DigitalAccessLog  entitlementId, assetId, ip, userAgent, action, createdAt
                  → detalii complete în 11-produse-digitale.md
PriceList         name, currency, customerGroupId?
PriceListItem     priceListId, variantId, price, minQuantity
PriceHistory      variantId, price, effectiveFrom     ← necesar pentru Omnibus
```

### Stoc
```
Warehouse         name, code, address, isDefault, priority
InventoryItem     variantId, warehouseId, onHand, reserved, incoming, lowStockThreshold

⚠️ **Gestiunea stocului — exact ca în WooCommerce:**
- Setare globală `inventory.manageStock` (implicit ON) — valoarea implicită pentru produse noi
- Bifă per produs `manageStock`, care suprascrie setarea globală
- La produse cu variante, bifa poate fi și la nivel de variantă (moștenește de la produs)

**Dacă `manageStock = true`** (implicit):
  disponibilitatea vine din `InventoryItem.onHand - reserved`
  → rezervare la inițierea plății, expirare 15 min, decrement la confirmare
  → alerte de stoc mic, istoric de mișcări, backorder opțional

**Dacă `manageStock = false`**:
  disponibilitatea vine din `stockStatus` — un simplu dropdown în admin
  → NICIUN InventoryItem nu se creează, nicio rezervare, niciun decrement
  → se poate comanda oricâte bucăți; adminul comută manual pe „stoc epuizat"
  → ramură explicită în cod, nu simulare cu o cantitate mare
StockMovement     variantId, warehouseId, type(purchase|sale|return|adjustment|transfer|reservation),
                  quantity, reference(orderId/...), reason, userId, createdAt
StockReservation  variantId, warehouseId, quantity, orderId|cartId, expiresAt
BackInStockAlert  variantId, email, notifiedAt
```

### Coș și comandă
```
Cart              customerId?, token, currency, items, couponCode,
                  shippingAddressId?, expiresAt, abandonedEmailSentAt
CartItem          cartId, variantId, quantity, unitPrice, metadata

LoyaltyAccount    customerId, balance, pending, lifetimeEarned, lifetimeRedeemed
LoyaltyTransaction customerId, orderId?, type(earn|redeem|expire|adjust|revoke),
                  points, balanceAfter, reason, expiresAt, createdBy, createdAt
Voucher           code, initialValue, balance, status, issuedTo, message,
                  purchasedOrderId, expiresAt, isTransferable
VoucherTransaction voucherId, orderId, amount, balanceAfter
                  → detalii în 14-loializare-si-vouchere.md

ProductDocument   productId, type(energy_label|product_sheet|manual|ce_declaration|
                  datasheet|warranty|other), title, storageKey, originalName, mime(pdf|png|jpeg|webp),
                  sizeBytes, language(ro), position, showInTab
PartsDiagram      title, mediaId (imagine din bibliotecă; cu provider de utilizare media)
PartsDiagramProduct diagramId, productId           (o fișă la mai multe produse)
PartsDiagramHotspot diagramId, number, xBp?, yBp?, productId, label?
                  (xBp/yBp: sutimi de procent 0–10000; ambele sau niciuna; varianta A: nule)
                  → detalii în 15-specific-nisa-piscine.md

SalesChannel      code(web|emag), name, isActive, config
ChannelListing    channelId, productId, variantId, externalId, externalProductKey,
                  status, price, salePrice, stock, validationErrors, lastSyncAt
ChannelCategoryMapping channelId, categoryId, externalCategoryId, characteristicsMap
                  → detalii în 12-emag-marketplace.md

Order             number, channelId, externalId, externalData, customerId?, email, phone, currency,
                  status, paymentStatus, fulfillmentStatus,
                  subtotal, discountTotal, shippingTotal, taxTotal, grandTotal,
                  shippingAddress(JSON snapshot), billingAddress(JSON snapshot),
                  shippingMethod, paymentMethod, couponCode, customerNote, adminNote,
                  customerGroupId, groupPricingType, groupDiscountBps?, groupMarkupBps?,
                  groupAdvantageAmount,
                  digitalConsentAt, digitalConsentText,
                  installationRequested, installationNote, installationStatus,
                  ipAddress, userAgent, source(web|admin|emag|api), placedAt, cancelledAt
OrderLine         orderId, variantId?, productSnapshot(JSON), sku, title, variantTitle,
                  quantity, unitPrice, discountAmount, taxRate, taxAmount, lineTotal, imageUrl
                  (productSnapshot NU conține costPrice)
OrderEvent        orderId, type, message, data(JSON), userId?, createdAt   ← timeline
Payment           orderId, provider, providerRef, amount, currency, status,
                  method, cardLast4, rawPayload(JSON), idempotencyKey, capturedAt
Refund            paymentId, orderId, amount, reason, status, providerRef, userId
Shipment          orderId, warehouseId, carrier, awb, trackingUrl, cost, weight,
                  parcels, status, shippedAt, deliveredAt, labelUrl
ShipmentItem      shipmentId, orderLineId, quantity
Invoice           orderId, series, number, type(invoice|proforma|storno),
                  provider, providerRef, pdfUrl, xmlUrl, efacturaStatus, issuedAt, total
ReturnRequest     orderId, customerId, status, reason, items, refundMethod,
                  awb?, receivedAt, resolvedAt, refundId?
```

### Promoții
```
Discount          code?, type(percentage|fixed|free_shipping|bxgy),
                  value, appliesTo(all|products|categories|collections), targetIds,
                  minSubtotal, minQuantity, usageLimit, usageLimitPerCustomer, usedCount,
                  customerGroupIds, startsAt, endsAt, isAutomatic, priority, canCombine
DiscountUsage     discountId, orderId, customerId
GiftCard          code, initialValue, balance, expiresAt, status
```

### Livrare și taxe
```
ShippingZone      name, countries, counties, cities
ShippingMethod    zoneId, name, carrier, type(flat|weight|price|free|pickup),
                  price, rules(JSON), freeAbove, codFee, estimatedDays, isActive
TaxClass          code, name, isDefault           (pregătită; neexpusă în admin, nu schimbă calculul: cota = tax.standardRate)
TaxRate           taxClassId, rateBps(int, 2100 = 21%), validFrom
```

### CMS și marketing
```
Page              slug, title, blocks(JSON), status, seo(JSON), publishedAt
BlockPreset       type, name, schema, data
Menu              location(header|footer|mobile), items(JSON tree)
Banner            placement, image, link, startsAt, endsAt, isActive
BlogPost          slug, title, excerpt, content, coverImage, authorId,
                  categoryId, tags, status, publishedAt, seo
Faq               categoryId, question, answer, position
Review            productId, customerId?, orderId?, rating, title, body,
                  status(pending|approved|rejected), isVerified, media, reply, repliedAt
Question          productId, customerId?, body, answer, answeredBy, status
Subscriber        email, status, confirmedAt, unsubscribedAt, source
Wishlist          customerId, variantId
Redirect          from, to, statusCode
SeoMeta           entityType, entityId, title, description, ogImage, noindex
```

### Sistem
```
AuditLog          userId, action, entityType, entityId, before, after, ip, createdAt
Webhook           url, events[], secret, isActive
WebhookDelivery   webhookId, event, payload, statusCode, attempts, nextRetryAt
ApiKey            name, hashedKey, scopes[], lastUsedAt, expiresAt
EmailTemplate     key, subject, html, text, isOverride
Notification      userId?, type, title, body, readAt
JobLog            queue, name, status, error, duration, createdAt
Setting           key, value
Translation       locale, namespace, key, value
```

> ~60 de tabele. Nu le face pe toate deodată — vezi ordinea din fișierul 06.

---

## 2. State machines (scrie-le explicit, cu tranziții validate)

### `Order.status`
```
draft → pending → confirmed → processing → completed
                     ↓            ↓
                 cancelled    cancelled
completed → returned (parțial sau total)
```

### `Order.paymentStatus`
```
pending → authorized → paid → partially_refunded → refunded
   ↓          ↓
 failed   cancelled
paid → chargeback
```

### `Order.fulfillmentStatus`
```
unfulfilled → partially_fulfilled → fulfilled → in_transit → delivered
                                        ↓
                                    returned
unfulfilled → cancelled
```

**De ce trei**: o comandă poate fi `confirmed` + `paid` + `unfulfilled`. Sau `processing` + `pending` (ramburs) + `in_transit`. Cu un singur câmp ajungi la stări imposibile.

Implementare: un obiect `TRANSITIONS` cu tranzițiile permise + funcție `transition(order, to, actor)` care validează, scrie `OrderEvent`, declanșează side-effects (email, stoc, factură) prin queue — nu sincron.

### `ReturnRequest.status`
```
requested → approved → awaiting_shipment → received → inspected → refunded
     ↓          ↓                                          ↓
 rejected   cancelled                                  rejected
```

---

## 3. Fluxul de plasare comandă (cel mai important cod din proiect)

```
1.  Validează coșul (produse active, prețuri actuale, stoc disponibil)
2.  Recalculează TOT pe server (nu te încrede în ce trimite clientul)
3.  Validează adresa și metoda de livrare pentru zona respectivă
4.  Aplică promoțiile și cuponul (verifică limitele de utilizare)
5.  Calculează TVA pe fiecare linie
6.  [TRANZACȚIE]
      - creează Order + OrderLines cu snapshot complet
      - rezervă stocul (StockReservation, expiră în 15 min pentru plata online)
      - alocă număr de comandă (secvență, fără goluri, thread-safe)
      - creează Payment în status pending
7.  Dacă plată online → inițiază la procesator, redirect/3DS
    Dacă ramburs → confirmă direct comanda
8.  [WEBHOOK plată] verifică semnătura → verifică idempotency →
      - paid: confirmă comanda, transformă rezervarea în decrement real,
              enqueue: email confirmare, emitere factură, notificare internă
      - failed: eliberează rezervarea, email „plata a eșuat" cu link de reîncercare
9.  Golește coșul, marchează cuponul ca folosit
10. Trimite evenimentele de analytics server-side (Meta CAPI, GA4 MP)
```

**Reguli**: idempotency key pe pasul 6 · rollback complet la orice eroare · niciodată side-effects în tranzacție · toate emailurile prin queue cu retry · webhook-urile trebuie să răspundă 200 rapid și să proceseze async.

---

## 4. API și suprafață de server

### Server Actions (admin + storefront)
Pentru mutații venite din UI-ul propriu. Fiecare acțiune: `withAuth` → `withPermission` → `withTenant` → validare Zod → use-case din `packages/core` → `revalidateTag`.

### Route Handlers `/api/...`
```
POST /api/webhooks/payments/[provider]     semnătură verificată
POST /api/webhooks/shipping/[carrier]      update status AWB
POST /api/webhooks/invoicing/[provider]
GET  /api/health
GET  /api/feed/google.xml | facebook.xml
GET  /api/sitemap/[type].xml
POST /api/revalidate                       protejat prin secret
GET  /api/og/[type]/[id]                   imagini OG dinamice
```

### API public v1 (pentru integrări externe / apps / ERP)
```
Auth: Bearer ApiKey, scopes, rate limit per cheie
GET/POST/PATCH  /api/v1/products, /variants, /categories
GET/PATCH       /api/v1/inventory
GET/POST/PATCH  /api/v1/orders
GET             /api/v1/customers
POST            /api/v1/webhooks
Paginare cursor, filtrare, `?fields=`, `updated_since`
```

---

## 5. Panoul de administrare — module

**Convenția de navigare (blocul 8b, Faza 5):** meniul din stânga are **o singură intrare pe grup**, iar ecranele grupului sunt **taburi** în bara de deasupra paginii (legături de navigare, nu taburi ARIA). Primul grup este **Produse**: Toate produsele (`/admin/produse`), Categorii, Branduri, Atribute, Unități de măsură, Fișe explodate (cu flag), Stoc, toate sub `/admin/produse/…`; **Media** rămâne intrare separată. Același model se aplică la **Comenzi, Clienți, Marketing, Conținut și Setări** când apar, iar ecranele noi se construiesc direct în structura asta.

- **Drepturi:** un tab apare doar dacă utilizatorul are permisiunea (și flag-ul) ecranului; intrarea de meniu apare dacă vede cel puțin un tab și duce la primul tab permis. Meniul și bara nu sunt măsuri de securitate: fiecare pagină își păstrează `requireAdmin`, iar rutele `api/admin` verifică permisiunea.
- **Pagini întregi:** editorul unei entități (produs, fișă explodată), formularele «nou» și importul stau în afara grupului de rute `(tabs)`, deci fără bara de taburi (editorul are propriile taburi).
- **Adrese:** adresele vechi (`/admin/categorii`, `/admin/branduri`, `/admin/atribute`, `/admin/unitati-de-masura`, `/admin/fise-explodate`, `/admin/stoc`, inclusiv căile adânci) redirecționează permanent (308) la cele noi, păstrând parametrii (`apps/web/src/lib/admin-redirects.ts`, citit de `next.config.ts`). Nicio sursă nu mai leagă de ele (test de arhitectură).
- **Filtre:** la schimbarea tabului se păstrează doar parametrii pe care ambele ecrane îi înțeleg (`keepParams`: căutarea `q` între «Toate produsele» și «Stoc»); restul se resetează.
- **Cod:** grupurile se declară în `apps/web/src/lib/admin-nav.ts` (`tabs` pe intrare, ex. `PRODUCT_TABS`); pagina taburilor stă într-un grup de rute `(tabs)` cu un `layout.tsx` care desenează `AdminTabBar`.

### 5.1 Dashboard
Vânzări azi/7z/30z cu comparație · comenzi noi de procesat · valoare medie comandă · rata de conversie · produse fără stoc · plăți eșuate · retururi în așteptare · recenzii de moderat · grafic vânzări · top produse · trafic pe surse · sarcini rapide.

### 5.2 Comenzi
- Listă cu filtre (status, plată, fulfillment, dată, sumă, metodă, canal, etichete), căutare, salvare de vizualizări, selecție multiplă
- Acțiuni în masă: marchează procesată, generează AWB, printează etichete/facturi, export
- **Detaliu comandă**: linii editabile · adrese editabile · timeline complet · plăți și rambursări · expedieri și AWB · facturi · note interne și pentru client · date client cu istoric · retrimitere email · anulare cu motiv · duplicare · imprimare bon/AWB/factură
- Comandă manuală (draft order) creată de operator, cu link de plată trimis pe email
- Editare comandă după plasare (adaugă/scoate produse, recalculează, diferență de plată)

### 5.3 Clienți
Listă cu LTV, nr. comenzi, ultima comandă, etichete · fișă client cu istoric, adrese, note, activitate · grupuri și segmente (reguli: „au comandat de peste 2x în ultimele 90 zile") · export GDPR · anonimizare/ștergere · impersonare (cu audit) · conturi B2B.

### 5.4 Produse
- Listă cu preview imagine, stoc, preț, status, categorie; filtre și editare inline
- Editor produs: informații generale, descriere rich, media (drag&drop, reordonare, alt), prețuri, variante (generator de combinații), stoc per depozit, atribute, categorii/colecții, SEO, produse asociate, livrare (greutate/dimensiuni), GPSR, produs digital
- Editare în masă (preț ±%, categorie, status, etichete)
- **Import/export CSV & XLSX** cu mapare de coloane, dry-run, raport de erori pe rând, actualizare pe SKU
- Duplicare produs, arhivare
- Generator de descrieri cu AI (opțional, dar util)

### 5.5 Stoc
Vizualizare per depozit · ajustări cu motiv · istoric mișcări · transfer între depozite · alerte stoc mic · import stoc CSV · inventariere (stock take) · rapoarte de rotație.

### 5.6 Categorii, colecții, branduri
Arbore drag & drop · imagine și banner · descriere SEO · reguli automate pentru colecții · ordonare produse în categorie (manual + reguli).

### 5.7 Reduceri și promoții
Creare cupon cu toate condițiile · promoții automate · generator de coduri în masă · statistici de utilizare · carduri cadou · reguli de cumulare și prioritate · preview „cine se califică".

### 5.8 Retururi (RMA)
Cereri de retur · aprobare/respingere cu motiv · generare AWB de retur · recepție și inspecție · rambursare parțială/totală · repunere pe stoc · rapoarte de motive de retur.

### 5.9 Recenzii și întrebări
Moderare (aprobă/respinge/editează) · răspuns public · marcaj „achiziție verificată" · solicitări automate post-livrare · raport rating pe produs.

### 5.10 Conținut (CMS)
- **Editor de pagini pe blocuri** (drag & drop, preview live) — inclusiv homepage
- Meniuri (header, footer, mobil) cu editor de arbore
- Blog: articole, categorii, autori, programare
- FAQ
- Bannere și pop-up-uri cu programare și targetare
- Bibliotecă media cu foldere, căutare, optimizare automată
- Pagini legale cu versiuni (important juridic: să știi ce versiune a acceptat clientul)

### 5.11 Marketing
Newsletter: liste, campanii, template-uri, statistici · automatizări: coș abandonat, bun venit, post-cumpărare, win-back · pop-up-uri de captare · feed-uri produse · UTM și rapoarte pe campanii · integrare Meta/Google/TikTok.

### 5.12 SEO
Meta per entitate cu preview SERP · redirect-uri 301 (import CSV) · sitemap și robots · structured data toggle · audit intern (produse fără meta, imagini fără alt, linkuri rupte) · Search Console integrat.

### 5.13 Rapoarte
Vânzări (zi/lună/produs/categorie/brand/canal/județ) · profit dacă ai cost de achiziție · AOV, LTV, rata de conversie, rata de abandon coș · retururi · stoc și valoare de inventar · cupoane · TVA de raportat · export XLSX/CSV · rapoarte programate pe email.

### 5.14 Setări
```
General        nume magazin, date firmă (CUI, Reg.Com, sediu, capital), contact, program
Regional       monedă, limbă, fus orar, format dată, unități
Taxe           clase de TVA și cote (implicit o singură cotă, 21%)
Livrare        zone, metode, tarife, praguri, taxă ramburs, depozite
Plăți          metode active, ordine, chei API, mod test/live, taxe suplimentare
Checkout       câmpuri obligatorii, guest checkout on/off, acorduri, politici
Emailuri       expeditor, SMTP/provider, template-uri, notificări interne
Legal          politici, ANPC/SOL, versiuni, cookie banner
Aspect         temă, culori, fonturi, logo, favicon, layout homepage
Notificări     cine primește ce
Domenii        domenii custom, SSL, redirecturi
```

### 5.15 Integrări
Pagină per integrare cu conectare/testare/deconectare: procesatoare de plăți · curieri · facturare + e-Factura · eMAG Marketplace · ERP/contabilitate · Google/Meta/TikTok · chat (Tawk/Crisp) · email marketing (Mailchimp/Klaviyo) · review platforms · Zapier/Make prin webhook-uri.

### 5.16 Sistem
Utilizatori și roluri (permisiuni granulare, invitații) · jurnal de audit cu filtre · chei API și webhook-uri (cu istoric de livrare și retry) · cozi de joburi (vezi, reia, șterge) · loguri de erori · cache (golește selectiv) · import/export bază de date · mod mentenanță.

### 5.17 Sistem → Actualizări și mentenanță
Versiune instalată vs. disponibilă · changelog · istoric actualizări · verificare checksum pe core · backup manual și programat · restore · mod mentenanță · informații de diagnostic (versiuni, conexiuni, spațiu pe disc).

### 5.18 Companii și liste de prețuri (B2B)
Vezi `09-preturi-si-parteneri.md` §5.

---

## 6. RBAC — roluri implicite

| Rol | Poate |
|---|---|
| **Owner** | Tot, inclusiv setări de sistem, actualizări și integrări |
| **Admin** | Tot, mai puțin actualizări de sistem și chei de integrare |
| **Manager** | Comenzi, produse (inclusiv prețul de achiziție, `products.cost.view`), clienți, reduceri, rapoarte |
| **Editor conținut** | CMS, blog, SEO, media și conținutul produselor (`products.content.write`: descriere, SEO, media, documente), fără prețuri, stoc sau cost |
| **Suport clienți** | Vede comenzi și clienți, poate anula comenzi. **Rambursarea (`orders.refund`) rămâne la Manager, Admin și Owner până există o limită de rambursare** (decizie utilizator) |
| **Depozit** | Comenzi (doar fulfillment), stoc, AWB — fără prețuri și date financiare |
| **Contabil** | Rapoarte, facturi, export — doar citire |

**Conținutul produsului (`products.content.write`)** îl au Owner, Admin, Manager și Editor. Acoperă DOAR: titlu, subtitlu, descriere, adresă (slug), SEO, legăturile media și documentele. Orice alt câmp (preț, preț redus și fereastra de promoție, stoc, cost, clasă de livrare, TVA, variante, stare, brand, categorii, excluderea de la discount...) cere `products.write`; costul cere în plus `products.cost.edit` ȘI `products.cost.view`. Reguli aplicate pe server (`ProductUpdateGuard`, nu doar în interfață):
- **deny-by-default:** un câmp care nu e explicit de conținut cere `products.write`, deci un câmp nou din model nu devine editabil de Editor din greșeală;
- **cerere mixtă = respinsă întreagă:** dacă o cerere combină câmpuri permise și interzise, nu se aplică nimic (nici partea permisă);
- **refuz clar și auditat:** HTTP 403, cod stabil `AUTH_FORBIDDEN`, mesaj cu numele câmpurilor refuzate și permisiunea cerută; încercarea intră în jurnalul de audit cu `outcome: denied`, cu NUMELE câmpurilor, niciodată cu valorile trimise;
- `products.write` o include pe `products.content.write` (cine poate modifica prețuri poate modifica și descrierea); invers nu;
- orice server action sau endpoint care modifică produse trece prin `withPermission("products.…")` (test de arhitectură).

**Import de produse din CSV/XLSX, punctul 14a** (Faza 4). Pagina `/admin/produse/import`, serviciul `ProductImportService` (`packages/core/src/catalog/import/`), coada `product-import` (`packages/jobs`), tabelul `ProductImport`. Exportul vine la 14b.

- **Pașii:** (1) încărcare: `POST /api/admin/product-imports` (Origin → sesiune → `products.write` → rate limit separat → limită pe flux → format real din octeți → limite → stocare privată `private/product-imports/<uuid>`); (2) mapare (propusă automat din antete, cu delimitator ales/confirmat la CSV); (3) verificare (dry-run): planifică fiecare rând față de catalog, **fără nicio modificare în catalog**, salvează maparea și amprenta planului; (4) aplicare: reverifică hash-ul fișierului stocat și recalculează planul față de starea CURENTĂ; dacă amprenta nu coincide cu cea verificată, refuză (`IMPORT_STALE`) și nu scrie nimic. Rândurile se aplică pe rând, fiecare prin serviciile obișnuite ale catalogului (cu audit tăcut): o eroare pe un rând nu oprește restul. **Un singur eveniment de audit `product.import`** cu numere agregate.
- **Sincron sau în fundal:** până la `import.syncMaxRows` (100) rânduri se aplică pe loc; peste, un job BullMQ (`product-import`, o singură încercare, concurență 1) cu progres (`processedRows`, interogat de interfață). Jobul reîncarcă utilizatorul care a pornit importul și **reverifică `products.write`**; la reluarea unui job căzut la mijloc se continuă cu starea curentă (rândurile deja aplicate apar «neschimbate»). Cache-ul catalogului se invalidează din aplicație când vede finalizarea.
- **Upsert pe SKU:** SKU existent → actualizare doar a coloanelor mapate; SKU nou → produs simplu (o variantă), ciornă (sau starea dată). Celulă goală = neschimbat; `-` șterge valoarea, doar la subtitlu, descriere, preț promoțional, brand, EAN, garanție, greutate, dimensiuni. Produsele arhivate sau din coșul de gunoi: «ignorate», raportate separat. Categorie sau brand inexistent: eroare pe rând (nu se creează nimic; categoriile se creează la importul WooCommerce, 15). Categorii: «A > B > C», mai multe separate prin «|», înlocuiesc categoriile produsului.
- **Valori:** prețuri în lei cu TVA, virgulă sau punct, cel mult 2 zecimale, fără separator de mii, cel puțin 0,01, convertite exact în bani; promoția ≤ prețul rezultat; EAN 8–14 cifre; enum-urile acceptă și etichetele în română. Un câmp invalid dă eroare pe rând, nu rotunjire în tăcere.
- **Prețul de achiziție NU se importă:** nu e câmp importabil; o coloană al cărei antet pare de cost/furnizor e blocată în interfață, iar maparea ei pe orice câmp (sau un nume de câmp de cost trimis direct) e refuzată cu `IMPORT_MAPPING_COST`. Valorile din acele coloane nu intră în raport, audit sau loguri (testat cu o valoare-santinelă).
- **Fișiere:** CSV UTF-8 cu/fără BOM (rezervă Windows-1250, cu avertisment), delimitator `,` `;` tab; XLSX doar prima foaie, fără macro-uri, formulele nu se evaluează (valoarea din cache). `read-excel-file` nu limitează dimensiunea decomprimată, deci `sanitizeXlsx` verifică arhiva ÎNAINTE: lista de intrări permise, plafon pe dimensiunea declarată (fflate trunchiază la ea, deci o dimensiune mincinoasă nu ocolește plafonul), număr maxim de intrări, apoi rearhivare curată. Limite în setările grupului `import`: 10 MB, 5.000 rânduri, 60 coloane, 100.000 caractere pe celulă, 60 MB decomprimat, 100 intrări.
- **Raport:** pe rând (nou / actualizat / neschimbat / ignorat / eroare, cu motiv în română), în interfață și ca CSV descărcabil (rândurile cu probleme; celulele care încep cu `=`, `+`, `-`, `@` sunt neutralizate). Fișierul se șterge după aplicare, la anulare sau la expirare (24 h; curățare la fiecare încărcare nouă).
- **CSV deschis corect în Excel (regulă pentru ORICE CSV generat de aplicație, inclusiv exportul de la 14b):** începe cu BOM UTF-8 și cu linia «sep=<delimitator>» (`toCsv`). Excel citește delimitatorul din ea la deschiderea cu dublu-click, indiferent de separatorul de listă din setările regionale (altfel un fișier cu «;» apare într-o singură coloană pe un calculator cu separatorul «,»). Importul recunoaște și scoate prima linie «sep=<un caracter>» (`extractSepLine`): caracterul devine delimitatorul (cu mențiune în previzualizare), alegerea explicită a administratorului o bate, un fișier fără ea merge ca înainte; sunt acceptate «,» «;» și tab (alt caracter se refuză cu mesaj clar). Antetul rămâne rândul 1 (Excel nu afișează linia «sep=»). Pagina de import recomandă șablonul XLSX (primul) și explică deschiderea CSV-ului prin Date → Din text/CSV.
- **CSV salvat din Excel în limba română** («CSV (delimitat prin virgulă)»): Windows-1250, câmpuri în ghilimele, antet cu virgulă în interior, zecimale cu virgulă. Se citește corect. Windows-1250 nu are ș/ț cu virgulă, ci doar ş/ţ cu sedilă (pe care Excel le scrie în locul lor): din fișierele Windows-1250 ele se normalizează la forma corectă (ș, ț), ca titlurile să nu aibă două variante ale aceleiași litere.
- **Șablon:** generat din `IMPORT_FIELDS` (aceeași definiție ca importul; test că antetul fiecărui câmp se mapează automat pe el însuși): CSV (BOM + `;`) și XLSX (cu foaia «Instrucțiuni»), cu antet și două rânduri de exemplu.
- **Permisiuni:** totul cere `products.write` (importul atinge preț, stare și structură; un Editor cu doar `products.content.write` nu poate importa). Importul aparține celui care a încărcat fișierul.

**Istoricul importurilor, punctul 15a+** (Faza 4). Pagina `/admin/produse/import/istoric` (listă, 25 pe pagină, cele mai noi întâi) și `/istoric/<id>` (detalii), citite din `ProductImport` prin `ProductImportService.listHistory/getHistory`; fila «Exporturi» din auditul `product.export` (`ProductExportService.history`).

- **Ce intră:** importurile care au ajuns la aplicare (`queued`, `running`, `completed`, `failed`), ale tuturor utilizatorilor. Stări afișate: În curs, Aplicat, Eșuat, Întrerupt (`running`/`queued` fără progres de `import.interruptedAfterMinutes`, 30 implicit, după `updatedAt`).
- **Retenție:** `import.historyRetentionDays` (180). `expiresAt` al unui import aplicat = «până când se păstrează raportul detaliat»; după termen se șterge doar `report`, iar `summary` (contoare + entități create), utilizatorul, fișierul și profilul rămân. Fișierul original nu se păstrează. Purja se face la acțiuni obișnuite (încărcare, deschiderea istoricului/detaliilor). `findExpired` șterge doar importurile neaplicate.
- **Securitate:** pagini cu `requireAdmin({ permission: "products.write" })` (test `admin-pages-guard`); raportul CSV: `GET /api/admin/product-imports/<id>/report`, `products.write`, limită proprie (`import.reportDownloadMaxAttempts`), `410` după purjare (test `admin-routes-guard` pentru orice rută din `api/admin`, inclusiv GET). Fără costul în istoric, detalii sau CSV (test cu valoare-santinelă).

**Profilul de import WooCommerce, punctul 15a** (Faza 4). Se alege la pasul 1 al paginii `/admin/produse/import` (Generic / WooCommerce) și rulează peste infrastructura importului generic (aceeași rută de încărcare, aceeași verificare legată de amprentă, același raport, același job în fundal). Codul: `packages/core/src/catalog/import/woo/`.

- **Pași:** încărcare (fișierul se analizează: tipuri de rânduri, clase de livrare, atribute, unități, coloane ignorate/blocate) → opțiuni (starea, unitățile, corespondența claselor de livrare, atributele) → verificare (dry-run, fără nicio scriere, cu LISTA a ce se creează) → confirmare → aplicare. Profilul și opțiunile se salvează în `ProductImport.mapping` (JSON): lista de câmpuri (generic) sau `{ profile: "woocommerce", options }`.
- **Coloane:** recunoscute după antet (română sau engleză; `woo-columns.ts`). Ignorate cu motiv: stoc, etichete, setări WooCommerce, produse digitale, meta personalizate. Coloana «Imagini» (prima) are rol propriu și se importă la cerere (punctul 15b, mai jos). BLOCATE: orice antet de cost/furnizor/intrare, nu se citesc. Unitatea de greutate/dimensiuni din antet se verifică față de opțiunea aleasă (unități nesuportate: lbs, oz, in → refuz clar).
- **Reguli:** SKU = cheia (fără SKU: `WC-<ID>`, cu avertisment); celulă goală = neschimbat; produsele noi = ciornă (starea din fișier doar la cerere); `legacyId` din ID (cere `catalog.legacy.edit`), `legacyUrl` gol; greutate kg→g și dimensiuni cm→mm exact (pe șirul de cifre); promoția cu datele ei în fusul magazinului; categorii «Părinte > Copil, Altă» cu virgula escapată «\,»; `>` și `|` interzise în numele categoriilor.
- **Ce se creează:** categoriile, brandurile și atributele LIPSĂ, doar după verificare și confirmare, înaintea produselor, prin serviciile catalogului (regulile arborelui se respectă). Atributele noi sunt text. Potrivire fără diferență de majuscule/diacritice.
- **Produse variabile:** `variable` + `variation` → produs cu opțiuni (max 3 opțiuni, 50 de valori, 100 de variante) și variante, într-o singură tranzacție; întreg sau deloc. Variație nouă la un produs existent: eroare clară. Grupate/externe/alte tipuri: ignorate cu motiv.
- **Relații:** Upsells/Vânzări încrucișate, în a doua trecere (după ce toate produsele din fișier există); ținte nerezolvate = avertisment.
- **Descrieri:** `htmlToPlainText` (text simplu; fără HTML în baza de date). Descrierea bogată (HTML sanitizat) e un punct separat înainte de Faza 6.
- **Idempotență:** a doua rulare = «neschimbat» pe toate rândurile valide.
- **Istoric de prețuri (Omnibus):** un produs creat primește UN punct în `PriceHistory`, la data importului, cu prețul efectiv de atunci. Punct de decizie înainte de lansare.
- **Permisiuni:** `products.write` (ca la importul generic); `catalog.legacy.edit` doar pentru ID-ul din magazinul vechi.
- **Limite:** `import.maxColumns` 200 (exporturile WooCommerce au 80+ coloane; pragul efectiv nu coboară sub 200), 5.000 de rânduri (variațiile se numără).

**Import de imagini din adrese (WooCommerce), punctul 15b** (Faza 4). Coloana «Imagini» a exportului WooCommerce se poate aduce în biblioteca media, în fundal, după ce produsele sunt create. E cea mai sensibilă parte a importului: serverul face cereri către adrese date de utilizator (risc SSRF). Codul: `packages/core/src/media/{safe-fetch,ip-guard,image-url,host}.ts` (descărcarea) și `packages/core/src/catalog/import/woo/{image-importer,image-store}.ts` (sarcinile).

- **O singură cale în rețea:** `safeFetchImage` (`media/safe-fetch.ts`). Testul de arhitectură `network-access.architecture.test.ts` pică dacă în `media/` sau `catalog/import/` apare `fetch`, `node:http(s)`, `net`, `tls`, `dns`, `axios`, `undici`, WebSocket etc. în afara lui (singura excepție: funcțiile pure `isIP*` din `node:net`). Verificările nu au comutator: niciun `process.env`/`NODE_ENV` în fișierele lor, iar fabrica de producție leagă `safeFetchImage(url, policy)` fără parametri (rezolvatorul și conectorul injectabile există doar în teste).
- **Lista de domenii permise** = setarea `imageImport.allowedHosts` (listă JSON de nume, ex. `["piscineshop.ro"]`). Este o SETARE DE SECURITATE: nu se editează din formularul de import și nu de un rol cu doar `products.write`; se scrie cu `settings.write` (Owner, Admin) sau direct în tabela `setting` (Prisma Studio, cheia `imageImport.allowedHosts`, grupul `imageImport`). Se citește FĂRĂ cache (`getGroupUncached`). Potrivire EXACTĂ pe numele normalizat (litere mici, fără punct final, IDNA/punycode); fără wildcard, fără IP-uri, fără port. Lista goală = nicio imagine descărcată, cu mesaj clar.
- **Regulile adresei** (fără rețea; aceleași la verificare și la fiecare salt al descărcării): doar `https`, doar portul 443, fără utilizator/parolă, fără fragment, fără IP literal în nicio formă (zecimal, octal, hex, IPv6, IPv4-mapat), fără spații/caractere de control/bară inversă, lungime maximă (`maxUrlLength`), gazda în lista de domenii.
- **DNS înainte de conectare:** numele se rezolvă O SINGURĂ dată pe salt, iar TOATE adresele trebuie să fie publice (respinse: loopback, privat, link-local inclusiv 169.254.169.254, CGNAT 100.64/10, 0.0.0.0/8, multicast, rezervat, documentație, IPv6 unique-local/link-local/loopback, IPv4-mapat, NAT64, 6to4 etc.). Dacă UN record e privat, tot numele se respinge. Lista de domenii NU anulează această verificare.
- **Anti DNS-rebinding:** conectarea se face la IP-ul DEJA validat (`lookup` fixat în `https.request`), cu certificatul verificat pe numele gazdei, SNI și Host = gazda. Verificat cu un server TLS real local (vezi PROGRESS): numele greșit față de certificat și certificatul necunoscut sunt respinse.
- **Redirecturi:** manuale, cel mult `maxRedirects` (3), fiecare salt revalidat de la zero (listă, https, port, DNS, IP). Un redirect către ALTĂ gazdă (chiar permisă), http, IP sau port diferit se respinge.
- **Limite:** timp de conectare și total (`connectTimeoutSeconds`, `totalTimeoutSeconds`), mărime pe flux cu oprire imediată (`maxDownloadBytes`; Content-Length nu e de încredere), `Accept-Encoding: identity` (răspunsul comprimat se refuză), User-Agent fix, fără cookie/autorizare/antete interne, concurență globală și pe gazdă (`concurrency`, `perHostConcurrency`), imagini pe produs și pe import (`maxImagesPerProduct`, `maxImagesPerImport`). Toate sunt setări cu plafoane.
- **Conținutul:** tipul se decide din octeți, prin aceeași conductă ca încărcarea din admin (`MediaService.upload`: SVG și tipuri active refuzate, limita de pixeli, reencodare cu sharp, fără EXIF), apoi variante prin procesorul media. HTML deghizat, fișier prea mare, corupt sau peste limita de pixeli = eroare pe IMAGINE, nu pe produs.
- **Verificarea (dry-run) NU face nicio cerere în rețea:** doar parsează adresele, aplică regulile fără rețea și arată câte imagini sunt, de pe ce domenii, ce se respinge și de ce (motive în română, fără adresa completă).
- **Aplicarea** creează produsele ca la 15a și salvează sarcinile (`ProductImportImage`); descărcarea rulează apoi în fundal (coada `product-import-images`, un job pe import), cu progres vizibil în pagina de import și în istoric (descărcate / deja existente / eșuate / în așteptare). Jobul reîncarcă utilizatorul care a pornit importul și reverifică `products.write` ȘI `media.write`.
- **Idempotență:** adresa sursă normalizată are hash SHA-256 pe `Media.sourceHash` (UNIC): aceeași adresă nu produce al doilea fișier, nici la importuri paralele. A doua rulare descarcă doar ce lipsește; o imagine eșuată nu strică produsul și se reîncearcă la rulările următoare sau cu «Reia imaginile».
- **Atașarea:** în ordinea din fișier, DUPĂ imaginile existente ale produsului; prima devine principală doar dacă produsul nu are imagini. Nu se șterge și nu se înlocuiește nimic. Textul alternativ = titlul produsului. Folosirea e vizibilă în urmărirea utilizării media (legătura `ProductMedia`).
- **Permisiuni:** importul de imagini cere `products.write` ȘI `media.write` (un rol fără dreptul de media nu poate încărca imagini prin ușa din spate a importului). Fără `media.write`, produsele se importă normal, iar imaginile se ignoră cu explicație. Reluarea imaginilor: doar utilizatorul care a pornit importul.
- **Raport și audit:** contoare de imagini în raport, sumar și istoric; evenimentul `product.import` primește `imagesTotal/imagesRejected/imagesQueued`, iar la sfârșitul descărcării `product.import.images` are `downloaded/existing/failed/attached`. Nimic cu adrese, IP-uri, anteturi sau corpuri de răspuns.
- **Nu se importă (încă):** documentele din meta (fișă tehnică, manual), imaginile rândurilor de variație.
- **Faza 18 (producție):** pe lângă verificările din aplicație, serverul trebuie să aibă și o restricție de ieșire la nivel de rețea (egress: firewall / grup de securitate / proxy de ieșire care permite doar domeniile necesare), ca o eroare viitoare de cod să nu poată deschide servicii interne.

**Export de produse în CSV/XLSX, punctul 14b** (Faza 4). Butonul «Exportă…» din lista de produse (`ProductExportDialog`), ruta `POST /api/admin/product-exports` (`handleProductExport`) și serviciul `ProductExportService` (`packages/core/src/catalog/export/`).

- **Domeniul:** produsele selectate în pagină (cel mult 200), toate produsele care respectă filtrele curente (aceeași condiție ca lista: `buildProductListWhere`) sau tot catalogul. Coșul de gunoi este EXCLUS implicit; se include explicit (sau se exportă din vederea «Coș de gunoi»). Selecția exportă exact ce s-a ales, oricare ar fi starea. Format: CSV sau XLSX.
- **Formatul fișierului:** un rând = o variantă (un SKU); câmpurile produsului se repetă pe rândurile variantelor lui. Coloanele sunt EXACT cele ale importului (`IMPORT_FIELDS`: aceleași antete în română, aceeași ordine), apoi două coloane doar pentru citire: «ID produs» și «Modificat la» (data în fusul magazinului). Importul le recunoaște după antet și le ignoră cu mențiune («Coloană informativă din export»); astfel un fișier exportat se reimportă FĂRĂ mapare manuală. Prețuri în lei cu TVA (CSV: «1299,50»; XLSX: număr cu formatul `#,##0.00" lei"`), categoriile ca «Cale > Subcale | Altă cale» (prima = principală), starea și clasa de livrare cu etichetele din import. Ordinea rândurilor este cea de creare (id), nu alfabetică. Produsele fără nicio variantă nu au SKU și nu au rânduri (se numără în foaia «Despre export»).
- **CSV:** prin funcția comună (`csvStreamResponse`: BOM UTF-8 + «sep=;» + antet în română), scris în flux pe loturi de 200 de produse, fără să țină tot fișierul în memorie. Codurile cu zerouri la început (SKU, EAN) se pierd la deschiderea CSV-ului în Excel (Excel le face numere); pentru ele, XLSX.
- **XLSX:** foaia «Produse» (antet îngroșat și fixat; SKU, EAN și celelalte coduri ca TEXT, deci zerourile se păstrează; prețurile ca NUMERE cu formatul de lei) și foaia «Despre export» (data, domeniul, filtrele aplicate, coșul de gunoi, numărul de rânduri și de produse, cum se reimportă, ce NU se exportă; fără date sensibile). Importul citește doar prima foaie. Se construiește în memorie (limitat de `productExport.maxRows`).
- **PREȚUL DE ACHIZIȚIE NU SE EXPORTĂ, pentru nimeni** (nici cu `products.cost.view`): tipurile exportului nu au câmp pentru el, interogările din `export-store.ts` au `select` explicit fără coloanele de cost, iar fișierul nu e pe lista celor care pot numi costul (`cost-exposure.architecture.test.ts` pică dacă îl menționează). Test cu valoare-santinelă: costul pus pe fiecare variantă nu apare în nicio formă (`7654321`, `76543,21`, `76.543,21`…) nici în CSV, nici în XLSX (toate intrările arhivei), nici în antete. Un export de costuri, dacă va fi nevoie vreodată, este un punct separat și explicit.
- **Neutralizarea injecției de formule:** un text care începe cu `=`, `+`, `-`, `@`, tab sau CR primește un apostrof în față (CSV: `csvCell`; XLSX: `export-xlsx.ts`); numerele (prețuri, dimensiuni, garanție) nu trec pe aici, deci nu se strică. Regula este bijectivă (`cell-safety.ts`): la export, o valoare care se potrivește cu `'*` + caracter periculos primește UN apostrof; la import, o celulă care se potrivește cu `'+` + caracter periculos pierde UN apostrof (deci `=SUM(A1)` ↔ `'=SUM(A1)`, iar `'=x` ↔ `''=x`). O valoare restaurată este text literal: «-» venit din «'-» nu e marcajul de ștergere. Un text obișnuit, cu apostrof sau fără, nu se atinge. Testat dus-întors (toate șirurile de până la 5 caractere din alfabetul `' = + - @ a spațiu tab CR`) și pe fișiere reale.
- **Permisiune: `products.export`** (nouă; Owner, Admin, Manager). `products.read` nu ajunge: ar permite Depozitului sau Editorului (care văd lista) să scoată tot catalogul, cu ciorne și date interne, dintr-un click; `products.write` ar cupla exportul de dreptul de a modifica. O instalare existentă primește permisiunea la rularea seed-ului (`db:seed`, idempotent). Butonul nu apare fără ea, iar ruta refuză (403).
- **Ruta și securitatea:** POST (nu GET): exportul are efecte (contor de rate limit, eveniment de audit) și citește tot catalogul, iar un GET ar putea fi declanșat de o pagină străină printr-o navigare simplă; POST cere verificarea originii. Ordinea: origine → sesiune → `products.export` → rate limit (`productExport.uploadMaxAttempts` per fereastră, contor separat de importuri, media și documente) → cerere validă (JSON de cel mult 32 KB, `strictObject`) → domeniu numărat → limită de rânduri. Refuzurile se înregistrează `denied` (cu motivul, fără conținutul cererii), plafonate pe IP. Fiind rută API, o acoperă testul de arhitectură al rutelor care scriu (`upload-route`: handlerul trebuie să conțină `isSameOriginRequest` și `can`), care a primit explicit `handleProductExport` și ruta.
- **Limită de rânduri:** `productExport.maxRows` (20.000 de variante, plafon 100.000). Peste limită exportul se REFUZĂ înainte să curgă vreun octet, cu un mesaj în română (numărul de rânduri, limita și cum se restrânge). Nu există job în fundal: fișierul ajunge direct în browser, iar un job ar cere stocare, notificare și curățare fără câștig la mărimea unui catalog de magazin; refuzul explicit e mai simplu și mai previzibil.
- **Audit:** UN eveniment `product.export`, doar cu NUMERE (format, domeniu, rânduri, produse, produse fără variante, dacă s-a inclus coșul, dacă au fost filtre), fără valori din catalog; scris la sfârșitul fluxului (`success`) sau la întrerupere/eroare (`failed`, `reason: interrupted`).

**Ciclul de viață al produsului (duplicare, arhivare, coș de gunoi), punctul 13** (Faza 4). `ProductLifecycleService` (`packages/core/src/catalog/product-lifecycle*.ts`), acțiuni în `produse/lifecycle-actions.ts`.

- **Două axe independente:** `status` (`draft` / `active` / `archived`) și `deletedAt` (coșul de gunoi). Ștergerea soft NU atinge `status`, deci restaurarea e „undo” (revine cu starea de dinainte); dezarhivarea duce în `draft` (nu republică în tăcere). Regula „se poate vinde” e una singură: `isSellable` = activ ȘI neșters (storefront-ul, Faza 7, și canalele, Faza 18, o folosesc; `ChannelListing` nu se modifică la arhivare).
- **Permisiuni:** toate operațiile cer `products.write` (`withPermission` + re-verificare în serviciu). Permisiunea `products.archive` din Faza 2 rămâne nefolosită (rezervată): starea `archived` se poate seta deja cu `products.write` (listă, editor), deci o a doua poartă pe același efect ar fi ocolibilă. **Același lucru e valabil pentru ștergerea în coș, restaurarea și ștergerea DEFINITIVĂ (purge): toate cer doar `products.write`** (Blocul C, C-22: decizie de aliniere a documentației cu ce e aplicat; permisiunile NU s-au schimbat). Pentru rolurile implicite (Manager/Admin/Owner) cele două sunt identice; un rol personalizat cu `products.write` fără `products.archive` poate deci șterge definitiv produse, iar dacă se dorește altfel, ștergerea definitivă ar putea cere o permisiune proprie (de decis).
- **Selecție** (arhivează, dezarhivează, șterge, restaurează): cel mult `MAX_BULK_PRODUCTS` (50), `confirm: true` + `expectedCount`, tot sau nimic într-o singură instrucțiune cu re-verificarea eligibilității la scriere (o schimbare de stare între timp anulează tot), UN singur eveniment de audit agregat (`ids`, `count`, starea nouă). Duplicarea și ștergerea definitivă sunt pe un singur produs.
- **Duplicarea** (tranzacție unică, ciornă): titlu `<titlu> (copie)`, adresă nouă unică (verificată și față de produsele șterse), coduri `<SKU>-COPIE` / `-COPIE-2`… (coloana e `NOT NULL` și unică; marcajul „de completat” e derivat din cod, fără stare stocată). **Se copiază:** conținutul, SEO, GPSR, structura (opțiuni, valori, variante cu prețuri, promoții, greutate/dimensiuni, garanție), atributele (valori exacte), categoriile (cu cea principală), relațiile ieșite, legăturile media (aceleași fișiere din bibliotecă). **Nu se copiază niciodată:** prețul de achiziție și istoricul lui (`select` explicit, fără acele coloane; testul costului acoperă fișierul), stocul, EAN-ul, `legacyId`/`legacyUrl`, codul producătorului, clasa energetică și linkul EPREL (atestări ale unui model), documentele (specifice modelului; cheie unică de stocare), colecțiile, fișele explodate, ofertele de canal, relațiile intrate. Istoricul de prețuri (Omnibus) pornește de la zero, cu prețul efectiv curent.
- **Ștergerea definitivă:** doar pentru un produs deja în coșul de gunoi, cu adresa tastată; refuzată dacă are oferte de canal `active`/`pending` sau o referință `RESTRICT` din baza de date (comenzile, Faza 9, când există: plasa de siguranță e testată cu un tabel de test; **la Faza 9 cheia străină spre produs din liniile de comandă trebuie să fie `RESTRICT`**). Hotspot-urile fișelor explodate NU blochează: rămân în fișă, „fără produs” (migrația din 11d), iar asocierea produs–fișă dispare; dialogul le numără și le numește, și funcționează și cu flag-ul `partsDiagrams` oprit. Fișierele documentelor se șterg din storage după tranzacție (un eșec lasă orfani, prinși de `docs:sweep-orphans`).
- **Interfață:** lista are vederea „Coș de gunoi” (`?view=deleted`), acțiuni pe selecție cu confirmare, „Duplică” pe rând; pagina produsului are Duplică / Arhivează / Dezarhivează / Mută în coșul de gunoi; produsul din coșul de gunoi nu are pagină de editare (404) și se restaurează din listă.

**Fișa explodată (piese de schimb), blocul 11d** (Faza 4), în spatele flag-ului `partsDiagrams` (oprit implicit).

- **Flag:** oprit = nicio intrare în meniu, `/admin/produse/fise-explodate` și `/admin/produse/fise-explodate/<id>` răspund 404 (`requireAdmin({ feature })`), tabul „Piese de schimb” nu apare pe produs și `PartsDiagramService` refuză orice operație cu `FEATURE_DISABLED`. Testul de arhitectură `parts-diagram-flag.architecture.test.ts` impune toate acestea (pagină fără flag în `requireAdmin`, intrare de meniu fără `feature`, folosirea directă a delegatelor Prisma ale fișelor, metodă de serviciu fără `gate()` pică). Excepția explicită: providerul de utilizare media (doar citire) rămâne activ și cu flag oprit, ca imaginea unei fișe să nu devină ștergibilă în tăcere.
- **Model:** `PartsDiagram` (titlu + imagine din bibliotecă) ↔ `PartsDiagramProduct` (fișa se asociază MAI MULTOR produse) și `PartsDiagramHotspot` (număr unic pe fișă, `xBp`/`yBp` în puncte de bază 0–10000, ambele sau niciuna, `productId` opțional, `label` opțional; cel puțin unul dintre produs și etichetă la salvare). **Migrația `parts_diagram_hotspot_product_set_null`:** `productId` devine nullable cu `ON DELETE SET NULL`, deci ștergerea definitivă a unui produs lasă hotspot-ul în fișă, „fără produs”; un produs șters „soft” rămâne legat și se vede ca „șters”.
- **Imaginea:** doar fișiere `ready` din bibliotecă; FK `Restrict` + provider (cu link la editorul fișei): ștergerea unei imagini folosite e refuzată cu „Fișă explodată: <titlu>” ca loc de folosire.
- **Permisiuni:** toate scrierile (fișă, titlu, imagine, hotspot-uri, asociere) cer `products.write`; citirea `products.read` (Editorul vede paginile doar pentru citire). **Justificare pentru titlu:** schema fișei nu are descriere, iar titlul identifică fișa în tabelul din magazin; o permisiune separată ar adăuga o regulă de cerere mixtă fără beneficiu real.
- **Ștergerea fișei** cere confirmare cu numărul EXACT de hotspot-uri (`expectedHotspots`, verificat pe server: numărul greșit refuză).
- **Editorul:** poziția se introduce în procente cu cel mult 2 zecimale (= puncte de bază exacte: 12,34% = 1234). Trei moduri echivalente: click pe imagine cu hotspot-ul ales, săgeți pe marcajul focusat (1%, Shift 0,1%, Ctrl 10%, Enter salvează) sau câmpuri numerice în tabel (fără mouse). Marcajele sunt butoane cu etichetă completă (număr, nume, poziție), schimbările se anunță prin `aria-live`, iar modificările nesalvate declanșează avertismentul la părăsire.

**Documente de produs și conformitate, blocul 11c** (Faza 4).

- **Încărcare** — `POST /api/admin/products/<id>/documents` (rută proprie, nu server action; corpul e fișierul, nu multipart). Verificările, în ordinea asta: 1. origine (`isSameOriginRequest`) · 2. sesiune · 3. `products.content.write` (documentele sunt conținut, conform deciziei de la punctul 7; `products.write` o include) · 4. rate limit (grupul de setări `documents`, contoare separate de media) · 5. mărime, aplicată pe FLUX (`documents.maxUploadBytes`, implicit 15 MB, plafon 50 MB) · 6. tip real din OCTEȚI: PDF (`%PDF-` la început) sau PNG/JPEG/WebP (cu `file-type`, apoi re-codificate fără EXIF); nimic altceva · 7. stocare + bază de date · 8. audit. Fiecare refuz are rezultat `denied` (sau `failed` la defecte de infrastructură), cu motivul și FĂRĂ conținutul sau numele fișierului; refuzurile înregistrate sunt limitate pe IP. Testul de arhitectură `upload-route.architecture.test.ts` pică dacă o rută care scrie nu conține verificarea de origine și cea de permisiune (direct sau în handlerul din core la care deleagă).
- **PDF cu conținut activ** — se refuză la încărcare dacă structura brută conține `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile(s)`, `/RichMedia` sau `/XFA` (inclusiv cu nume ofuscate prin `#xx`), cu mesaj care spune soluția (tipărire în PDF din cititor, apoi reîncărcare). **Limită:** detectarea e parțială, marcajele din fluxuri comprimate nu se văd; sanitizarea completă (rescriere cu qpdf/ghostscript) e datorie (Faza 21). Indiferent de asta, **fișierul nu se execută și nu se randează niciodată din originea magazinului**.
- **Stocare și servire** — cheia o generează serverul: `private/product-documents/<uuid>.<extensie>` (numele trimis nu intră în cheie și e doar informativ, sanitizat). Documentele NU sunt în biblioteca media. Descărcarea: `GET /api/admin/products/<id>/documents/<documentId>` (sesiune + `products.read`) face redirecționare la un link semnat de 120 de secunde cu `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` și `Content-Security-Policy: default-src 'none'; sandbox` (aceleași ca la imaginile din bibliotecă). Pagina publică „Descărcări” din Faza 7 va emite linkuri semnate la cerere, tot din această cale.
- **Fără orfani** — la eroare după scrierea fișierului, fișierul se șterge; la ștergere/înlocuire, rândul din bază e sursa adevărului și fișierul vechi se șterge după aceea (un eșec la fișier se loghează și lasă un orfan). **Curățare:** `npm run docs:sweep-orphans` (doar raport) sau `-- --delete`; operează STRICT pe `private/product-documents/` (prin `StorageDriver.list(prefix)`, local + S3), compară cu `product_document`, nu atinge niciodată `public/` sau alte prefixe și șterge doar obiecte mai vechi de 1 oră.
- **Conformitate** — tabul Conformitate: clasa energetică (A+++ … G), linkul EPREL (validat doar ca `https://`; serverul nu îl urmează niciodată, deci fără SSRF) și GPSR (producător, persoană responsabilă din UE, avertismente). Sunt câmpuri restricționate: cer `products.write`, iar Editorul le vede doar pentru citire.

**Atribute, relații și variante, blocul 11b** (Faza 4). Toate cer `products.write` (permisiune dedicată nu se justifică: sunt date de catalog la același nivel cu prețul și starea; Editorul de conținut le vede doar pentru citire). Toate acțiunile sunt `withPermission("products.*")` (testul `product-write-guard` le enumeră exact).

- **Atribute** — pagina `/admin/produse/atribute` (vizibilă cu `products.read`, scriere cu `products.write`). Definiție: nume, **cod stabil** (litere mici, cifre, `_`; nu se mai schimbă după creare), tip `text` / `number` / `select` (listă) / `bool`, unitate (doar la numerice), filtrabil (nu la text liber), ordine, opțiuni (la listă; unice fără diferență de majuscule, ordonabile). **Tipul nu se mai schimbă cât atributul are valori** (mesaj cu numărul de produse); fără valori, tipul se schimbă și unitatea/opțiunile care nu mai corespund se curăță. **Ștergerea** atributului sau a unei opțiuni folosite e refuzată cu numărul de produse.
- **Valori pe produs** — tabul Atribute: control potrivit tipului, unitatea în etichetă; numerele se introduc cu virgulă sau punct (cel mult 4 zecimale), se trimit ca TEXT și se stochează EXACT (`NUMERIC(18,4)`, fără `float`; `0,1` rămâne `0.1000`); golul șterge valoarea; cererea e parțială și respinsă întreagă la o valoare greșită. Baza are în plus CHECK-ul „exact o coloană setată” și triggerul care potrivește coloana cu tipul.
- **Relații** — tabul Asociate. Un rând NESIMETRIC: `productId` (principal) → `relatedProductId` (asociat), cu un tip:

| tip | sens (principal → asociat) |
|---|---|
| `similar` | alternative asemănătoare („ți-ar mai putea plăcea”) |
| `accessory` | asociatul e accesoriu al principalului |
| `upsell` | asociatul e o variantă superioară, propusă în locul principalului |
| `crosssell` | asociatul completează principalul, propus la coș |
| `spare_part` | asociatul e piesă de schimb a principalului |
| `compatible_with` | principalul se montează/funcționează cu asociatul |

  „A accessory B” NU înseamnă „B accessory A”. În admin, relația apare din ambele părți: la A ca „din acest produs către altele” (ordonabilă), la B ca „din alte produse către acesta”; ștergerea merge din oricare parte (același rând). Reguli: fără auto-relație (și CHECK în bază), fără dubluri (unic pe principal + asociat + tip; aceeași pereche poate avea tipuri diferite), produse existente și neșterse, cel mult 50 pe tip. Căutarea produsului asociat: titlu, SKU, EAN sau cod producător (aceeași ca în listă), cu cel puțin 2 caractere, fără produsul însuși.
- **Variante** — tabul Variante: tabel cu editare în rând (SKU unic, EAN, garanție, preț, preț redus cu fereastră în ora magazinului, greutate, cod producător; aceleași reguli ca la Prețuri). **Generatorul** compară opțiunile cu variantele existente și adaugă DOAR combinațiile care lipsesc, cu aceleași limite (3 opțiuni, 50 de valori, 100 de variante). **Previzualizarea** (fără scriere) arată ce se creează (cu SKU-uri), ce există și ce variante cu opțiuni rămân „orfane”: acestea NU se șterg niciodată automat; se șterg explicit, cu confirmare, din tabel (nu se poate șterge ultima variantă; dacă era implicită, prima rămasă o preia; legăturile de opțiuni, imaginile și istoricele variantei se șterg în cascadă). Variantele fără opțiuni (produs simplu) rămân neatinse. Prețul de achiziție nu apare în acest tab (panoul de server din Prețuri, pe fiecare variantă).

**Editorul de produs, blocul 11a** (Faza 4): `/admin/produse/nou` (creare rapidă: titlu, SKU, preț, brand, categorie, clasă de livrare; produsul se creează ca ciornă, cu o variantă, categoria în aceeași tranzacție) și `/admin/produse/[id]` (taburi: General, Prețuri, Stoc, Categorii, Media, SEO; Variante, Atribute, Asociate în 11b; Documente, GPSR/energie, Fișă explodată în 11c). Ce vede și ce poate face fiecare rol, pe tab:

| Tab / câmp | Fără drept (ex. Suport) | `products.read` (Depozit) | `products.content.write` (Editor) | `products.write` (Manager, Admin, Owner) |
|---|---|---|---|---|
| Pagina produsului | acces interzis | doar citire | conținut editabil, restul citire | tot (mai puțin costul) |
| General: titlu, subtitlu, adresă, descriere | – | citire | **editabil** | editabil |
| General: stare, brand, livrare, montaj, discount de grup | – | citire | citire | editabil |
| Prețuri: preț, redus, fereastră, SKU, EAN, garanție | – | citire | citire (prețul e public) | editabil |
| Stoc, Categorii | – | citire | citire | editabil |
| Media, SEO | – | citire | **editabil** | editabil |
| Preț de achiziție (NIR) | **absent din HTML** | **absent din HTML** | **absent din HTML** | vizibil doar cu `products.cost.view` (Manager, Owner, Admin, Contabil), editabil doar cu `products.cost.edit` (Admin, Owner) |

- **Costul:** panou de SERVER (`PurchasePanel`) în tabul Prețuri, cu formular și server action proprii (`savePurchasePrice`); fără `products.cost.view` nu se randează deloc (nici gol, nici ascuns). Rezultatul salvării revine prin URL ca cod de stare, niciodată cu valoarea. Componentele client nu-l primesc (testul de arhitectură al costului).
- **Salvare:** pe tab; clientul trimite DOAR câmpurile modificate. Serverul validează cu Zod strict și trece cererea prin `ProductUpdateGuard`; o cerere mixtă (conținut + câmp restricționat) se respinge întreagă, cu audit `denied` și doar numele câmpurilor.
- **Prețuri:** introducere în lei cu cel mult 2 zecimale (→ bani fără `float`); previzualizare „fără TVA” din `tax.standardRate` (funcție pură `netFromGross` în `packages/shared`); prețul redus ≤ prețul întreg; fereastra de promoție în ORA MAGAZINULUI (`regional.timezone`), sfârșitul după început.
- **Regula de activare:** la trecerea în „Activ” (și la activarea în masă), variantele fără garanție proprie primesc `catalog.defaultWarrantyMonths` (implicit 24, din registrul de setări; editabilă prin acțiunea `updateSetting` până apare pagina de setări). EAN-ul și brandul nu sunt obligatorii.
- **Protecție la pierderea modificărilor:** `beforeunload` (dialogul nativ al browserului), iar link-urile interne și butonul „înapoi” cer confirmare într-un dialog propriu al aplicației, în română (nu `window.confirm`) cât timp un tab e modificat; indicatorul „●” apare pe tab.
- **Accesibilitate:** etichete legate de câmp, erori legate prin `aria-describedby`/`aria-invalid` cu focus pe primul câmp greșit, taburi WAI-ARIA (săgeți, Home, End), reordonarea imaginilor cu butoane și anunț `aria-live`.

**Lista de produse și editarea în masă** (Faza 4, punctul 10):
- lista cere `products.read`; titlul se editează inline cu `products.content.write`, starea, stocul, prețul și acțiunile în masă cu `products.write` (aceeași poartă `ProductUpdateGuard`);
- **editarea în masă:** cel mult 50 de produse per cerere (`MAX_BULK_PRODUCTS`), confirmare explicită (`confirm` + `expectedCount`, deci și serverul o cere), toate produsele existente și neșterse, aplicare într-o singură tranzacție (tot sau nimic), un eveniment de audit agregat `product.bulk_update` cu lista de id-uri și schimbările (fără valori sensibile). Cererea mixtă se respinge întreagă; prețul de achiziție NU se poate schimba prin editare în masă (nu există cheie pentru el, schema e strictă);
- **prețul ±%:** în puncte de bază (de la -90% la +300%), rotunjit pe variantă, promoția păstrează proporția și nu depășește prețul întreg, `PriceHistory` primește prețul efectiv nou;
- **fără cost:** proiecția listei nu are câmpuri de cost, parametrii din URL nu pot cere sortare sau filtru după cost (se ignoră), iar componenta client a listei nu primește costul (test de arhitectură). Imaginile: doar varianta `thumb`, niciodată originalul.

**Categorii și branduri** (Faza 4, punctul 9) folosesc același model, fără permisiune dedicată de „catalog”:
- **conținut** (nume, descriere, SEO, imagine/logo): `products.content.write` (Editor, Manager, Admin, Owner);
- **structură** (creare, mutare, adresă, excluderea de la discountul de grup, ștergere): `products.write` (Manager, Admin, Owner);
- **magazinul vechi** (`legacyId`, `legacyUrl`): în plus `catalog.legacy.edit`, pe care o au doar **Admin și Owner** (nu Manager). Permisiunea e nouă și dedicată: acești identificatori alimentează importul și redirecționările 301, deci nu sunt „conținut” și nici „structură” obișnuită;
- toate acțiunile trec prin `withPermission("products.…")` (același test de arhitectură ca la produse), iar `FieldAccessGuard` verifică pe server câmpurile: cerere mixtă respinsă întreagă, 403 cu numele câmpurilor, audit `denied` fără valori.

**Arborele de categorii:** adâncime maximă `MAX_CATEGORY_DEPTH = 4` (5 niveluri: rădăcina are adâncimea 0); adâncimea unui subarbore contează la mutare. Mutarea e validată pe server: fără cicluri (nu sub propriile subcategorii), fără categorie părinte a ei însăși, fără depășirea adâncimii, adresa unică între frații noului părinte. Adresa (slug) a unei categorii e unică între frați, fără diferență de majuscule (aceeași adresă e permisă sub părinți diferiți); `path` e unic. Ștergerea e refuzată cu număr: subcategorii și produse (separat cele șterse). Imaginea categoriei și logoul brandului sunt fișiere din bibliotecă (FK `Restrict`) cu provideri de utilizare media: un fișier folosit nu se șterge din bibliotecă, iar mesajul numește categoria/brandul.

**Interfața arborelui:** glisare HTML5 nativă (peste un rând = subcategorie; sus/jos pe rând = reordonare) ȘI alternativă completă de tastatură: „Mută sus/jos”, „Mută…” (părinte permis + poziție), anunțuri `aria-live`.

**Adresa (slug) a produsului** e unică pe TOATE produsele, inclusiv cele șterse (soft delete), fără diferență de majuscule: o adresă a unui produs șters nu se refolosește (restaurare, redirecționări 301). Generarea din titlu adaugă sufix numeric (`-2`, `-3`); o adresă introdusă manual care e ocupată e refuzată cu numele produsului care o deține.

**Prețul de achiziție (`products.cost.view`)** îl văd doar Owner, Admin, Manager și Contabil; Editor, Suport și Depozit nu. Maparea completă rol → permisiuni este în `packages/core/src/rbac/catalog.ts` (sursa de adevăr pentru seed).

**Accesul în admin** cere permisiunea explicită `admin.access`. O au cele 7 roluri de sistem (Owner o are implicit, ca pe toate). Un rol fără `admin.access` (de ex. un rol personalizat) și un client fără roluri NU intră în `/admin`, iar `can()` e fals pentru orice altă permisiune fără ea.

### Matricea rol × permisiune

Generată din `packages/core/src/rbac/catalog.ts`; un test pică dacă tabelul de mai jos diferă de catalog (`pnpm test`). Pentru a-l regenera după o modificare în catalog, copiază rezultatul din testul `rbac/matrix.test.ts`.

<!-- rbac-matrix:start -->
| Permisiune | Owner | Admin | Manager | Editor conținut | Suport clienți | Depozit | Contabil |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `admin.access` — Intră în zona de administrare (/admin) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `orders.read` — Vede comenzile | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ |
| `orders.write` — Modifică comenzile | ✓ | ✓ | ✓ |  |  |  |  |
| `orders.cancel` — Anulează comenzi | ✓ | ✓ | ✓ |  | ✓ |  |  |
| `orders.refund` — Rambursează comenzi | ✓ | ✓ | ✓ |  |  |  |  |
| `orders.fulfill` — Pregătește și expediază comenzi (fulfillment, AWB) | ✓ | ✓ | ✓ |  |  | ✓ |  |
| `products.read` — Vede produsele | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |
| `products.write` — Creează și modifică produse (prețuri, stoc, variante, clasă de livrare, TVA) | ✓ | ✓ | ✓ |  |  |  |  |
| `products.content.write` — Editează conținutul produselor (descriere, SEO, media, documente), fără prețuri, stoc sau cost | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `products.archive` — Rezervată, neaplicată: arhivarea, ștergerea, restaurarea și ștergerea definitivă a produselor cer products.write | ✓ | ✓ | ✓ |  |  |  |  |
| `products.export` — Exportă produsele în CSV sau XLSX (fără prețul de achiziție, pentru nimeni) | ✓ | ✓ | ✓ |  |  |  |  |
| `products.cost.view` — Vede prețul de achiziție (NIR) al produselor | ✓ | ✓ | ✓ |  |  |  | ✓ |
| `products.cost.edit` — Modifică prețul de achiziție (NIR) al produselor | ✓ | ✓ |  |  |  |  |  |
| `catalog.legacy.edit` — Editează identificatorii și adresele din magazinul vechi (legacyId, legacyUrl) ale produselor, categoriilor și brandurilor | ✓ | ✓ |  |  |  |  |  |
| `inventory.read` — Vede stocul | ✓ | ✓ | ✓ |  |  | ✓ |  |
| `inventory.write` — Modifică stocul | ✓ | ✓ | ✓ |  |  | ✓ |  |
| `customers.read` — Vede clienții | ✓ | ✓ | ✓ |  | ✓ |  |  |
| `customers.read_pii` — Vede datele personale ale clienților | ✓ | ✓ | ✓ |  | ✓ |  |  |
| `customers.write` — Modifică clienții | ✓ | ✓ | ✓ |  |  |  |  |
| `customers.groups.manage` — Gestionează grupurile de clienți | ✓ | ✓ |  |  |  |  |  |
| `discounts.read` — Vede reducerile și cupoanele | ✓ | ✓ | ✓ |  |  |  |  |
| `discounts.write` — Creează și modifică reduceri și cupoane | ✓ | ✓ | ✓ |  |  |  |  |
| `content.read` — Vede conținutul (CMS, blog, SEO) | ✓ | ✓ |  | ✓ |  |  |  |
| `content.write` — Editează conținutul (CMS, blog, SEO) | ✓ | ✓ |  | ✓ |  |  |  |
| `media.read` — Vede biblioteca media și poate alege fișiere în formulare | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |
| `media.write` — Încarcă și șterge fișiere media | ✓ | ✓ |  | ✓ |  |  |  |
| `invoices.read` — Vede facturile | ✓ | ✓ |  |  |  |  | ✓ |
| `invoices.write` — Emite și stornează facturi | ✓ | ✓ |  |  |  |  |  |
| `reports.read` — Vede rapoartele operaționale | ✓ | ✓ | ✓ |  |  |  | ✓ |
| `reports.financial` — Vede rapoartele financiare | ✓ | ✓ |  |  |  |  | ✓ |
| `settings.read` — Vede setările | ✓ | ✓ |  |  |  |  |  |
| `settings.write` — Modifică setările | ✓ | ✓ |  |  |  |  |  |
| `integrations.write` — Modifică integrările și cheile lor | ✓ |  |  |  |  |  |  |
| `users.manage` — Gestionează utilizatorii și rolurile | ✓ | ✓ |  |  |  |  |  |
| `audit.read` — Vede jurnalul de audit | ✓ | ✓ |  |  |  |  |  |
| `system.update` — Actualizează sistemul și rulează mentenanță | ✓ |  |  |  |  |  |  |
<!-- rbac-matrix:end -->

**`products.export` (punctul 14b): cine o are și de ce.** Owner, Admin și Manager (rolurile care pot modifica și importa catalogul). Nu o au Depozit și Editor, deși văd lista (`products.read`): exportul scoate tot catalogul într-un click, cu ciorne, date interne și identificatori, deci cere o poartă proprie, nu `products.read`; `products.write` ar fi cuplat exportul de dreptul de a modifica. Exportul nu conține niciodată prețul de achiziție, nici pentru cine are `products.cost.view`. O instalare veche primește permisiunea la rularea seed-ului (`db:seed`).

Permisiuni ca string-uri: `admin.access`, `orders.read`, `orders.write`, `companies.approve`, `pricelists.write`, `orders.refund`, `orders.cancel`, `products.write`, `inventory.write`, `customers.read_pii`, `settings.write`, `integrations.write`, `users.manage`, `reports.financial`. Verificare **pe server**, la fiecare acțiune.

---

## 7. Joburi și cron-uri (BullMQ)

**Cozi**: `emails`, `webhooks`, `shipping`, `invoicing`, `search-index`, `imports`, `exports`, `marketplace-sync`, `analytics`

**Joburi**: trimite email · generează AWB · sincronizează status AWB · emite factură · trimite la e-Factura · reindexare search · import/export produse · sync eMAG (stoc, preț, comenzi) · trimite eveniment server-side de analytics · generează feed-uri · procesează imagini (resize, AVIF)

**Cron-uri**:
```
*/5  * * * *  sincronizare status AWB pentru expedieri active
*/10 * * * *  eliberează rezervările de stoc expirate
0    * * * *  emailuri de coș abandonat (1h/24h/72h)
0    2 * * *  backup DB + upload off-site
0    3 * * *  regenerare feed-uri produse
0    4 * * *  curățare sesiuni, coșuri și token-uri expirate
0    9 * * *  solicitări de recenzie (livrate acum 5 zile)
0    9 * * *  raport zilnic de vânzări pe email
0    1 * * 1  raport săptămânal + verificare stoc mic
*/15 * * * *  sync eMAG (dacă e activ)
0    5 * * *  snapshot preț pentru Omnibus (30 zile)
```

---

## 8. Erori și reziliență
- Circuit breaker pe integrările externe (dacă curierul e picat, nu bloca comanda)
- Retry cu backoff exponențial pe joburi (3-5 încercări), apoi dead-letter queue vizibilă în admin
- Timeout explicit pe orice apel extern (max 10s)
- Degradare grațioasă: dacă search-ul e picat, cade pe Postgres; dacă recomandările sunt picate, ascunde secțiunea
- **Niciodată nu pierde o comandă**: dacă emiterea facturii eșuează, comanda rămâne validă și jobul se reia
