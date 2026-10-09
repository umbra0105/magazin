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

### Catalog
```
Product           slug, title, subtitle, description(rich), status(draft|active|archived),
                  brandId, taxClassId, type(physical|digital),
                  requiresInstallation, shippingClass(standard|oversized),
                  energyClass?, eprelUrl?,
                  manageStock(bool), stockStatus(instock|outofstock|onbackorder)
                  excludeFromGroupDiscount, warrantyMonths,
                  publishedAt, sortOrder, metadata(JSON)
ProductVariant    productId, sku, ean, barcode, manufacturerPartNumber, manufacturerName,
                  price, compareAtPrice,
                  costPrice(NET, fără TVA, DOAR admin), costPriceDate,
                  weight, dimensions, position, isDefault
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
Attribute         code, name, type(text|number|select|bool), isFilterable, unit
AttributeValue    productId, attributeId, value
Media             url, key, mime, width, height, size, alt, folder
ProductMedia      productId, variantId?, mediaId, position
ProductRelation   productId, relatedId, type(similar|accessory|upsell|crosssell)
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
                  datasheet|warranty|other), title, fileUrl, language, position, showInTab
PartsDiagram      title, imageUrl, productIds[]
PartsDiagramHotspot diagramId, number, x, y, productId, label
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
TaxClass          name, isDefault
TaxRate           taxClassId, country, rate, name, isCompound
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
| **Editor conținut** | CMS, blog, SEO, media |
| **Suport clienți** | Vede comenzi și clienți, poate anula/rambursa până la o limită |
| **Depozit** | Comenzi (doar fulfillment), stoc, AWB — fără prețuri și date financiare |
| **Contabil** | Rapoarte, facturi, export — doar citire |

**Prețul de achiziție (`products.cost.view`)** îl văd doar Owner, Admin, Manager și Contabil; Editor, Suport și Depozit nu. Maparea completă rol → permisiuni este în `packages/core/src/rbac/catalog.ts` (sursa de adevăr pentru seed).

Permisiuni ca string-uri: `orders.read`, `orders.write`, `companies.approve`, `pricelists.write`, `orders.refund`, `orders.cancel`, `products.write`, `inventory.write`, `customers.read_pii`, `settings.write`, `integrations.write`, `users.manage`, `reports.financial`. Verificare **pe server**, la fiecare acțiune.

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
