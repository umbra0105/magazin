# 12 — eMAG Marketplace și canale de vânzare

Ai confirmat eMAG. **Vestea importantă: asta schimbă modelul de date acum, chiar dacă integrarea propriu-zisă o faci peste 3 luni.**

---

## 1. Regula de aur

> **Construiește abstracția de canal acum (~1 zi). Fă integrarea eMAG la final (~8-12 zile).**

Motivul: dacă modelul tău de produs, stoc și comandă nu știe de „canale" din prima, retrofitul e cel mai scump lucru din tot proiectul. Dar dacă construiești integrarea eMAG înainte ca magazinul tău propriu să funcționeze, pierzi 2 săptămâni pe ceva ce nu poți testa.

**Deci: în Faza 4 (catalog) adaugi tabelele de canal. Integrarea eMAG e o fază separată, după lansare.**

---

## 2. Ce trebuie adăugat ACUM în modelul de date

```
SalesChannel
  code              'web' | 'emag' | ...
  name, isActive, config(JSON)

ChannelListing        ⚠️ tabelul cheie
  channelId
  productId, variantId
  externalId          ID-ul ofertei la eMAG
  externalProductKey  part_number_key — identificatorul produsului în catalogul eMAG
  status              'draft'|'pending'|'active'|'rejected'|'inactive'
  price               preț specific canalului (poate diferi de cel de pe site)
  salePrice?
  stock               stoc alocat canalului
  validationErrors    JSON — ce a respins eMAG și de ce
  lastSyncAt, lastSyncStatus

ChannelCategoryMapping
  channelId
  categoryId          categoria ta
  externalCategoryId  categoria eMAG
  characteristicsMap  JSON — atributul tău → caracteristica eMAG

Order
  + channelId         de unde a venit comanda
  + externalId        numărul comenzii la eMAG
  + externalData      JSON brut, pentru depanare

ProductVariant
  + ean               ⚠️ OBLIGATORIU la eMAG. Adaugă-l de la început.
  + brandId           obligatoriu la eMAG
  + warrantyMonths    obligatoriu la eMAG
```

Câmpurile marcate ⚠️ le adaugi în Faza 4, chiar dacă nu le folosești încă. Costă zero acum, costă zile mai târziu.

---

## 3. Cum funcționează eMAG Marketplace (pe scurt)

- **Autentificare**: user + cheie API, cu **whitelist de IP** — serverul tău trebuie să aibă IP fix. Notează asta la configurarea VPS-ului.
- **Produs vs. Ofertă**: eMAG are un catalog propriu. Dacă produsul tău există deja acolo, îți atașezi doar *oferta* (preț + stoc) folosind `part_number_key`. Dacă nu există, trimiți **documentație de produs** completă și treci prin validare (poate dura zile și poate fi respinsă).
- **Caracteristici obligatorii per categorie**: fiecare categorie eMAG are un set propriu de caracteristici obligatorii. De aici tabelul de mapare.
- **EAN obligatoriu** pe majoritatea categoriilor.
- **Comenzi**: le tragi periodic prin API. Trebuie **confirmate/preluate** într-un interval, altfel primești penalizări.
- **Statusuri eMAG** diferă de ale tale — ai nevoie de o mapare explicită în ambele sensuri.
- **AWB**: fie îl generezi prin eMAG (cu curierii lor), fie prin curierul tău și le comunici numărul.
- **Factura** trebuie încărcată la eMAG pentru fiecare comandă (PDF sau URL). SmartBill poate genera, tu trebuie să o urci.
- **Retururi (RMA)** vin tot prin API și trebuie procesate.
- **Comision** per categorie, reținut de eMAG. Reconcilierea o faci lunar.

⚠️ Detaliile tehnice (versiuni de API, câmpuri exacte, termene, penalizări) se schimbă. **Citește documentația oficială de la eMAG în momentul implementării** — nu te baza pe ce scrie aici sau pe ce știe un model de limbaj.

---

## 4. Riscuri operaționale (astea dor mai mult decât codul)

| Risc | Consecință | Cum îl previi |
|---|---|---|
| **Stoc desincronizat** | Vinzi ce nu ai → anulare → penalizare → oferte suspendate | Sincronizare la fiecare modificare de stoc, nu doar pe cron. Rezervă un tampon de siguranță. |
| Preț greșit trimis | Vinzi sub cost, la scară | Validare: refuză sincronizarea dacă prețul scade cu peste X% față de ultimul |
| Comenzi neconfirmate la timp | Penalizări | Cron la 5 minute + alertă dacă o comandă stă neconfirmată |
| Ofertă respinsă la validare | Produsul nu apare | Ecran de erori de validare în admin, pe fiecare produs |
| Factură neîncărcată | Reclamații, penalizări | Job automat după emitere, cu retry și alertă |
| Dublă vânzare pe site și eMAG | Ultimul produs vândut de două ori | Stoc unic, cu alocare pe canal sau tampon |

**Strategia de stoc — decide:**
- **A. Stoc comun** — același stoc pe toate canalele, cu tampon de siguranță (ex: dacă ai 10, trimiți 8 la eMAG). Simplu, recomandat la început.
- **B. Stoc alocat per canal** — rezervi explicit 3 bucăți pentru eMAG. Mai sigur, mai greu de administrat.

Recomandare: **A, cu tampon configurabil.**

---

## 5. Ce construiești, în ce ordine

### Faza 4 (acum, ~1 zi)
- [ ] Tabelele `SalesChannel`, `ChannelListing`, `ChannelCategoryMapping`
- [ ] Câmpuri `ean`, `warrantyMonths` pe variantă; `brandId` obligatoriu
- [ ] `channelId`, `externalId`, `externalData` pe `Order`
- [ ] Canalul `web` creat implicit la instalare
- [ ] Interfața `ChannelProvider` (publishListing, syncStock, syncPrice, fetchOrders, acknowledgeOrder, pushAwb, pushInvoice, fetchReturns)

### Fază separată, după lansarea magazinului propriu (~8-12 zile)
- [ ] Client API eMAG cu rate limiting și retry
- [ ] Mapare de categorii și caracteristici, cu UI în admin
- [ ] Publicare oferte: atașare pe `part_number_key` sau documentație nouă
- [ ] Sincronizare stoc și preț (la eveniment + cron de siguranță)
- [ ] Import comenzi la 5 minute → `Order` cu `channelId = emag`
- [ ] Confirmare automată a comenzilor
- [ ] Generare AWB și comunicare către eMAG
- [ ] Încărcare factură automată după emitere
- [ ] Import și procesare retururi
- [ ] Ecran „Canale" în admin: status oferte, erori de validare, log de sincronizare, sincronizare manuală
- [ ] Raport: vânzări pe canal, comisioane, profitabilitate comparativă

---

## 6. Alte canale (același model, efort mic)

Odată ce ai `ChannelProvider`, adaugi ieftin:
- **Google Merchant Center** (feed XML) — ~0,5 zile, deja în plan
- **Facebook / Instagram Shopping** (feed) — ~0,5 zile, deja în plan
- **TikTok Shop** — feed similar
- Alte marketplace-uri românești — fiecare ~4-6 zile

Feed-urile sunt mult mai ieftine decât API-urile. Dacă scopul e vizibilitate, începe cu feed-urile.

---

## 7. Recomandarea mea onestă

eMAG aduce volum, dar și: comisioane, presiune pe preț, cerințe operaționale stricte și penalizări. Pentru un **pachet white-label vândut mai multor clienți**, integrarea eMAG e o funcționalitate premium — nu toți clienții tăi o vor folosi.

**Deci**: pune-o în spatele feature flag-ului `emagMarketplace`, construiește-o pe bani, după ce ai primul client care chiar o cere. Dar **pregătește modelul de date acum**.
