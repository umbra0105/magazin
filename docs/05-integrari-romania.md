# 05 — Conformitate legală și integrări pentru piața din România

> ⚠️ **Avertisment**: legislația fiscală și de protecția consumatorului din România se schimbă des. Informațiile de mai jos reflectă situația cunoscută de mine până în mai 2026. **Verifică fiecare punct cu contabilul și cu un avocat înainte de lansare** — mai ales cotele de TVA, e-Factura și obligațiile de afișare. Eu nu sunt avocat și nu ofer consultanță juridică.

---

## 1. Obligații legale — checklist de conformitate

### 1.1 Informații obligatorii pe site
- [ ] Denumire completă, formă juridică, CUI, nr. Registrul Comerțului, sediu social, capital social
- [ ] Date de contact: email, telefon, adresă
- [ ] Link către **ANPC** (Autoritatea Națională pentru Protecția Consumatorilor)
- [ ] Link către **SAL** (Soluționarea Alternativă a Litigiilor)
- [ ] ⚠️ Platforma europeană **SOL/ODR a fost închisă în iulie 2025** — verifică ce linkuri mai sunt obligatorii, multe magazine încă le afișează din inerție
- [ ] Politici: Termeni și condiții · Confidențialitate · Cookie-uri · Retur · GDPR · Livrare · Garanții

### 1.2 Drepturile consumatorului
- [ ] **Drept de retragere 14 zile** fără motiv (de la primirea produsului), cu **formular de retragere tip** descărcabil
- [ ] Excepții de la retragere menționate clar (produse personalizate, sigilate de igienă etc.)
- [ ] **Garanție legală de conformitate 2 ani** menționată explicit
- [ ] Informații precontractuale complete înainte de plasarea comenzii
- [ ] Butonul de finalizare trebuie să spună clar că implică obligația de plată („Plasează comanda cu obligație de plată" sau echivalent)
- [ ] Confirmarea comenzii pe email conține toate informațiile precontractuale + politica de retur

### 1.3 Prețuri
- [ ] Prețuri afișate **cu TVA inclus** pentru consumatori
- [ ] Toate costurile suplimentare (transport, ramburs) afișate **înainte** de plasarea comenzii
- [ ] **Directiva Omnibus**: la orice anunț de reducere trebuie afișat **cel mai mic preț practicat în ultimele 30 de zile**
      → de aici tabela `PriceHistory` + cronul zilnic de snapshot
- [ ] Preț pe unitate de măsură (lei/kg, lei/l) unde legea o cere

### 1.4 TVA
- [ ] Cota standard: **21%** (crescută de la 19% în august 2025) — **confirmă valoarea curentă**
- [ ] Cotă redusă: **11%** pentru categoriile aplicabile — confirmă lista
- [ ] Cotele trebuie să fie **configurabile din admin**, nu hardcodate. Vei mai avea schimbări.
- [ ] Regim intracomunitar B2B (taxare inversă cu VIES valid) — doar dacă vinzi către firme din UE
- [ ] OSS dacă vinzi în alte state UE peste plafon

### 1.5 GPSR (Regulamentul general privind siguranța produselor, din dec. 2024)
- [ ] Pe fiecare produs: numele și datele de contact ale **producătorului** și, dacă e din afara UE, ale **persoanei responsabile din UE**
- [ ] Avertismente de siguranță, instrucțiuni, pictograme
- [ ] Procedură de rechemare produse (recall)
→ adaugă câmpurile astea în modelul `Product` din prima, nu ulterior

### 1.6 GDPR
- [ ] Banner de cookie-uri cu **blocare reală a scripturilor** până la consimțământ (nu doar un banner decorativ)
- [ ] Consimțământ granular pe categorii (necesare / analitice / marketing) + posibilitate de retragere
- [ ] Google **Consent Mode v2** implementat
- [ ] Registru de evidență a prelucrărilor
- [ ] Export și ștergere date la cerere (implementat în cont client + admin)
- [ ] Contracte de prelucrare cu furnizorii (procesator plăți, curier, email)
- [ ] Newsletter cu **opt-in neprebifat** + dublu opt-in + dezabonare într-un click
- [ ] Perioade de retenție definite (ex: coșuri 30 zile, loguri 90 zile, comenzi 10 ani fiscal)

### 1.7 Altele de verificat pentru domeniul tău
- [ ] **SGR** (Sistemul Garanție-Returnare) dacă vinzi băuturi în ambalaje SGR
- [ ] Autorizații specifice: alimente (ANSVSA), cosmetice, suplimente, dispozitive medicale, jucării
- [ ] Taxa de timbru verde / raportare ambalaje (OIREP)
- [ ] Marcaj CE, declarații de conformitate

---

## 2. e-Factura (RO e-Factura, ANAF)

Situația cunoscută:
- **B2B**: obligatoriu din iulie 2024
- **B2C**: obligatoriu din ianuarie 2025
- Format: **XML UBL 2.1** (CIUS-RO), transmis prin **SPV** (Spațiul Privat Virtual)
- Necesită **certificat digital calificat** înrolat în SPV + aplicație OAuth2 la ANAF
- Termen de transmitere: câteva zile lucrătoare de la emitere (verifică termenul curent)
- Amenzi pentru netransmitere

### 👉 Recomandarea mea fermă
**Nu implementa direct integrarea cu ANAF la primul proiect.** Folosește un furnizor de facturare care are e-Factura inclusă:

| Furnizor | Observații |
|---|---|
| **Oblio** | API modern, documentație bună, e-Factura inclusă, cel mai prietenos pentru dezvoltatori |
| **SmartBill** | Cel mai răspândit, contabilii îl cunosc, API decent |
| **FGO** | Ieftin, API simplu |
| **Facturis / Keez** | Alternative viabile |

Astfel emiți factura printr-un apel API, iar furnizorul se ocupă de XML + SPV + statusuri. Îți rămâne doar: stochează `providerRef`, `pdfUrl`, `efacturaStatus` și afișează-le în admin și în contul clientului.

Lasă o interfață `InvoiceProvider` ca să poți adăuga mai târziu și integrarea directă ANAF pentru clienții care o cer.

---

## 3. Plăți

| Provider | Note |
|---|---|
| **Netopia mobilPay** | Cel mai folosit în RO. Redirect + IPN. Suportă rate. |
| **EuPlătesc** | Bine implementat, folosit intens. |
| **PayU România** | Parte din grup internațional, API bun. |
| **Stripe** | Cel mai bun DX, dar comisioane mai mari și mai puțin „localizat". Bun pentru clienți cu vânzări externe. |
| **Twispay / Libra PayZone** | Alternative. |
| **Ramburs (COD)** | **Obligatoriu în RO** — încă o parte semnificativă din comenzi. Taxă separată, limită de valoare, rată de refuz mai mare. |
| **Transfer bancar / OP** | Necesar pentru clienții persoană juridică. Comandă în așteptare până la confirmarea încasării. Emite proformă. |
| **Rate / BNPL** | TBI Pay, PayPo, Mokka — cresc AOV-ul semnificativ pe coșuri mari. |
| **Apple Pay / Google Pay** | Prin procesator, dacă îl suportă. |

**Design tehnic**: interfață comună
```ts
interface PaymentProvider {
  createPayment(order, opts): Promise<{ redirectUrl?, clientSecret?, providerRef }>
  verifyWebhook(req): Promise<PaymentEvent>
  capture(paymentRef, amount?): Promise<void>
  refund(paymentRef, amount, reason): Promise<RefundResult>
  getStatus(paymentRef): Promise<PaymentStatus>
}
```
Obligatoriu: mod test/live comutabil din setări · verificare semnătură IPN · idempotență · reconciliere zilnică · pagină de „reîncearcă plata" cu link valabil 24h.

---

## 4. Curieri

### ⚠️ Schimbare importantă de piață (august 2026)
**Sameday a finalizat achiziția Cargus.** Din 3 august 2026 Cargus e deținut 100% de Sameday (parte din grupul eMAG), iar cele două companii au intrat în integrare operațională: rețele, echipe și sisteme interne aliniate treptat.

**Consecință pentru tine**: nu construi integrări separate pentru Sameday și Cargus. Sistemele lor se vor unifica, iar munca dublă se pierde. Verifică statusul integrării înainte de a începe.

### Peisajul curierilor
| Curier | Puncte forte |
|---|---|
| **Sameday** | Cea mai mare rețea de lockere din regiune (~8.000 easybox), prezent și în HU și BG. Practic obligatoriu în RO |
| **Cargus** | Acum parte din Sameday. Lockere SHIP & GO, bun pe colete mari |
| **FAN Courier** | Cea mai mare acoperire independentă, lockere FanBox. API mai vechi (SOAP/XML + REST parțial) |
| **DPD / GLS** | Alternative, bune pe colete mari și internațional |

### 👉 Recomandare: agregator, nu integrări directe
Pentru un **pachet vândut mai multor clienți**, agregatorul e aproape sigur alegerea corectă: fiecare client va vrea alt curier, iar tu nu poți întreține 5 integrări pe 20 de instalări.

| Opțiune | Model de cost | Pentru cine |
|---|---|---|
| **wootPRO** (woot.ro) | **Fără abonament** dacă folosești tarifele și contractele lor — plătești doar transportul. Abonament doar dacă vrei să îți aduci propriile contracte de curierat în platformă | 🥇 Magazine mici și medii. Cel mai apropiat de „gratuit" |
| **Innoship** (grup Alsendo) | Abonament sau cost per livrare. Conectează peste 85 de curieri din 15 țări, 250+ clienți activi în RO, PL, CZ | Volume mari, reguli automate de alocare pe preț/calitate |
| **Integrări directe** | API-urile curierilor sunt gratuite; plătești doar contractul de curierat | Dacă ai deja contracte negociate și volum mare |

**Notă importantă**: „gratuit" înseamnă lucruri diferite. API-urile curierilor sunt gratuite — costul e timpul tău de dezvoltare și întreținere. wootPRO e gratuit ca platformă dacă folosești tarifele lor, dar tarifele lor pot fi mai mari decât un contract negociat direct la volum mare.

⚠️ Verifică prețurile și condițiile curente înainte de a decide — se schimbă.

### Arhitectura recomandată
Două adaptoare în spatele interfeței `ShippingProvider`, nu cinci:
1. **Agregator** (wootPRO sau Innoship) — acoperă majoritatea curierilor
2. **Sameday direct** — pentru clienții care au deja contract Sameday și vor easybox nativ

**Funcționalități necesare**: generare AWB individual și în masă · etichetă PDF + ZPL pentru imprimante termice · selectare easybox/punct de ridicare cu hartă în checkout · calcul cost livrare · ramburs transmis către curier și reconciliat · sincronizare status la 5-10 min cu email automat · AWB de retur · anulare AWB.

```ts
interface ShippingProvider {
  calculateRate(shipment): Promise<Rate[]>
  createAwb(shipment): Promise<{ awb, labelUrl, cost }>
  getLabel(awb, format: 'pdf' | 'zpl'): Promise<Buffer>
  track(awb): Promise<TrackingStatus>
  cancel(awb): Promise<void>
  getPickupPoints(county, city): Promise<PickupPoint[]>
  createReturnAwb(shipment): Promise<{ awb, labelUrl }>
}
```

**Date necesare**: lista județelor și localităților din România (dataset SIRUTA), pentru validarea adreselor și maparea la nomenclatoarele curierilor. Pregătește un seed cu asta.

## 5. Marketplace-uri

**eMAG Marketplace** — dacă intri, planifică din prima:
- API pentru produse (documentație proprie, validare strictă), oferte, stoc, preț, comenzi, AWB
- Comenzile eMAG intră în același `Order` cu `source: 'emag'` — **nu face un sistem paralel**
- Sincronizare bidirecțională de stoc (altfel vinzi ce nu ai)
- Reguli de preț separate pentru marketplace
- Comisioane și reconciliere

Alte canale: Cel.ro, Vexio, Answear (pe nișă), Google Shopping, Meta Shops, TikTok Shop.

---

## 6. Recenzii și încredere
- **Trusted.ro** — badge-ul de încredere recunoscut în RO
- **Google Customer Reviews** — apare în Google Shopping și în rezultate
- Recenzii proprii cu „achiziție verificată" (cel mai ieftin și sub controlul tău)
- ⚠️ Legal: recenziile trebuie să fie reale și trebuie să declari cum verifici autenticitatea (cerință Omnibus)

## 7. Analytics și marketing
GA4 cu Enhanced Ecommerce complet · Google Tag Manager (server-side ideal) · Meta Pixel + **Conversions API** (server-side, necesar din cauza blocării cookie-urilor) · Google Ads + Merchant Center · TikTok Pixel · Microsoft Clarity / Hotjar pentru heatmaps · Plausible/Umami self-hosted pentru date fără cookie-uri.

**Evenimente obligatorii**: `view_item_list`, `view_item`, `select_item`, `add_to_cart`, `remove_from_cart`, `view_cart`, `begin_checkout`, `add_shipping_info`, `add_payment_info`, `purchase`, `refund`, `search`, `sign_up`, `login`.

## 8. Alte integrări utile
Chat: Tawk.to, Crisp, WhatsApp Business · Email marketing: Klaviyo, Mailchimp, Brevo · ERP/contabilitate: SAGA, WinMentor, Ciel (de obicei prin export/import sau API furnizor) · SMS: Twilio, SMSlink, Vodafone · Automatizări: Zapier/Make prin webhook-uri.

---

## 9. Checklist final înainte de lansare (partea legală)
```
[ ] Toate paginile legale scrise de un avocat, nu copiate de pe alt site
[ ] Date firmă corecte peste tot (footer, facturi, emailuri)
[ ] Banner cookie funcțional, testat că blochează scripturile
[ ] Formular de retragere descărcabil
[ ] Omnibus funcțional pe produse cu reducere
[ ] GPSR completat pe toate produsele
[ ] Facturare testată cap-coadă, inclusiv storno și e-Factura
[ ] TVA verificat de contabil pe o comandă reală
[ ] Politica de confidențialitate acoperă toți procesatorii folosiți
[ ] Emailurile pleacă cu SPF/DKIM/DMARC valide
[ ] Test de comandă reală cu card real, urmată de rambursare
```
