# 11 — Produse digitale (tutoriale video)

Vinzi **și fizic, și digital**. Asta nu e „încă un tip de produs" — schimbă checkout-ul, livrarea, TVA-ul, dreptul de retur și modelul de fulfillment. Merită un fișier separat.

---

## 1. Ce se schimbă față de un magazin pur fizic

| Zonă | Schimbare |
|---|---|
| Produs | Tip nou: `digital`. Fără greutate, fără dimensiuni, fără stoc (de obicei) |
| Coș | Coș poate fi 100% digital, 100% fizic, sau **mixt** |
| Checkout | Fără adresă de livrare și fără transport dacă e doar digital |
| Plată | **Ramburs indisponibil** pentru comenzi doar digitale |
| Livrare | Instantanee, la confirmarea plății. Fără AWB. |
| Retur | ⚠️ Regim legal special — vezi §5 |
| TVA | Serviciu prestat electronic, nu bun. Reguli diferite la vânzare în afara RO |
| Cont client | Secțiune nouă: „Produsele mele digitale" / „Cursurile mele" |
| Fulfillment | O comandă mixtă e **parțial livrată instant**, parțial expediată ulterior |

---

## 2. Model de date

```
Product
  type            'physical' | 'digital'
  ...

DigitalProduct        (extensie 1:1 pe Product de tip digital)
  deliveryType        'download' | 'stream' | 'external_link'
  accessType          'lifetime' | 'limited_days'      ✅ DECIS: lifetime implicit
  accessDays          int?                             (câmpul rămâne, nefolosit)
  maxDownloads        int?                             null = nelimitat
  requiresLogin       bool                             recomandat: true

DigitalAsset          (fișierele efective; un produs poate avea mai multe)
  productId
  title               "Modul 1 — Introducere"
  type                'video' | 'file' | 'link'
  storageKey          cheia în S3 / ID-ul din platforma de streaming
  fileSize, duration, mimeType
  position
  isPreview           bool — se poate viziona gratuit ca demo

DigitalEntitlement    (dreptul de acces al unui client, generat la plată)
  orderId, orderLineId, customerId, productId
  grantedAt, expiresAt?
  downloadCount, maxDownloads
  revokedAt?          la rambursare
  accessToken         token unic pentru linkurile semnate

DigitalAccessLog      (audit + anti-piraterie)
  entitlementId, assetId, ip, userAgent, action('view'|'download'), createdAt
```

---

## 3. Unde ții videoclipurile — decizia cea mai importantă

| Variantă | Cost | Protecție | Recomandare |
|---|---|---|---|
| **S3/R2 + linkuri semnate** | Foarte mic | Slabă — cine descarcă o dată, are fișierul | OK pentru PDF-uri și fișiere, **slab pentru video** |
| **Bunny Stream** | ~1 USD/TB + storage | Bună: streaming HLS, token securizat, watermark, DRM opțional | 🥇 **Recomandarea mea** — ieftin și bun pentru RO |
| **Cloudflare Stream** | ~5 USD/1000 min | Bună, signed URLs, adaptive | Bun, mai scump |
| **Vimeo OTT / Vimeo Pro** | Abonament | Bună, dar te legi de ecosistemul lor | OK |
| **YouTube nelistat** | Gratis | ❌ Niciuna. Linkul se distribuie instant | Nu face asta |

### ✅ DECIS: Bunny Stream

Motivele, cu cifre verificate (septembrie 2026 — confirmă înainte de a plăti):
- Minim lunar 1 USD, plus consum: stocare de la ~0,01 USD/GB, livrare CDN de la ~0,005 USD/GB
- Encodare standard inclusă gratuit; transcriere AI și DRM enterprise sunt add-on-uri plătite
- Include: streaming adaptiv HLS, **autentificare prin token**, restricționare pe domeniu, **watermark**, player personalizabil, analytics, upload TUS
- Companie europeană (Slovenia) — latență bună pentru România și mai simplu din perspectivă GDPR
- Un exemplu de cost real raportat de un utilizator: ~3,5 USD/lună pentru 300 GB video stocat cu 50 GB trafic lunar

Comparativ: Cloudflare Stream și Mux facturează pe minute, ceea ce urcă rapid pe măsură ce crește timpul de vizionare.

**Arhitectura**: interfața `MediaDeliveryProvider` cu **trei drivere**:
- `local` — pentru dezvoltare pe localhost, servește de pe disc cu token semnat. **Nu ai nevoie de niciun cont ca să dezvolți.**
- `bunny` — pentru video în producție, cu token și watermark
- `s3` — pentru fișiere (PDF-uri, arhive), cu presigned URL de 15 minute

Driverul se alege din setări, la instalare. Fiecare client poate folosi contul lui.

### Măsuri anti-piraterie realiste
- Linkuri semnate cu expirare scurtă (nu linkuri permanente)
- Limită de descărcări per achiziție
- **Watermark cu emailul cumpărătorului** peste video (Bunny o face nativ) — cea mai eficientă măsură; nu împiedică copierea, dar descurajează distribuirea
- Log de accesări; alertă în admin la tipare anormale (50 de IP-uri diferite pe același entitlement)
- Vizionare obligatoriu logat

Nu construi DRM greu. Costă mult, supără clienții cinstiți și tot se sparge.

---

## 4. Fluxul de livrare

```
1. Plata confirmată (webhook)
2. → creează DigitalEntitlement pentru fiecare linie digitală
3. → email „Produsul tău e gata" cu link către /cont/produsele-mele
     (NU trimite linkul direct de descărcare pe email — expiră și ajunge în spam)
4. → clientul intră în cont, vede produsul, apasă Vizionează/Descarcă
5. → serverul verifică entitlement-ul, generează link semnat, incrementează contorul
6. → la rambursare: entitlement revocat, accesul se oprește
```

**Pentru cumpărături ca vizitator (guest)**: creează automat un cont sau trimite un link magic cu token lung. Recomand crearea contului — pentru produse digitale contul e util oricum.

---

## 5. ⚠️ Dreptul de retragere — obligație legală, greșită de aproape toată lumea

Pentru conținut digital livrat imediat, consumatorul **pierde** dreptul de retragere de 14 zile, **dar doar dacă** sunt îndeplinite cumulativ:

1. Consumatorul își dă **acordul expres prealabil** pentru începerea livrării înainte de expirarea celor 14 zile;
2. Consumatorul **confirmă că a luat cunoștință** că își pierde dreptul de retragere;
3. Comerciantul furnizează **confirmarea acordului** pe suport durabil (în emailul de confirmare).

### Implementare concretă
- În checkout, **doar dacă în coș există produse digitale**, apare o **bifă separată, neprebifată**, obligatorie:
  > „Solicit livrarea imediată a conținutului digital și confirm că îmi pierd dreptul de retragere de 14 zile după începerea livrării."
- Bifa e **distinctă** de acceptarea Termenilor. Nu le combina.
- Momentul și textul bifei se salvează pe comandă (`digitalConsentAt`, `digitalConsentText`) — dovada ta în caz de litigiu.
- Acordul se reia în emailul de confirmare.
- Fără bifă → comanda nu se poate plasa dacă are produse digitale.

Pentru comenzile mixte, produsele fizice își păstrează dreptul de retur de 14 zile. Politica de retur trebuie să explice separat cele două regimuri.

---

## 6. TVA la produse digitale

- Vânzare către consumatori **din România**: cota standard românească, ca la orice altceva. Simplu.
- Vânzare către consumatori **din alte state UE**: serviciile prestate electronic se taxează cu **TVA din țara cumpărătorului**, peste plafonul de 10.000 EUR/an pe total vânzări la distanță în UE. Sub plafon poți aplica TVA din RO. Peste → înregistrare **OSS**.
- Dacă vinzi în UE, ai nevoie de: detectarea țării cumpărătorului, **două dovezi independente** de localizare (IP + adresă de facturare + prefix telefonic), cote de TVA per țară, raportare OSS.

**Recomandarea mea**: în Val 1, **limitează vânzarea produselor digitale la România** (validare pe țara de facturare). Adaugă OSS doar când chiar vinzi în afară. Altfel intri într-un hățiș fiscal pentru zero venit.
→ **Confirmă cu contabilul** — e întrebarea 8 din lista de mai jos.

---

## 7. Coș și checkout mixt — cazurile de tratat

| Situație | Comportament |
|---|---|
| Coș doar digital | Fără pas de livrare, fără adresă de livrare, doar adresă de facturare. Ramburs ascuns. |
| Coș doar fizic | Fluxul normal |
| Coș mixt | Transport calculat **doar pe liniile fizice**. Adresă de livrare obligatorie. Ramburs disponibil, dar produsul digital se livrează abia la confirmarea încasării |
| Prag de transport gratuit | Se calculează **doar din valoarea produselor fizice** (altfel cumperi un curs de 300 lei și primești transport gratuit la o șurubelniță) |
| Comandă mixtă plătită cu ramburs | Digitalul se eliberează la confirmarea plății de la curier, nu la plasare. Explică asta clientului în checkout. |
| Rambursare parțială | Doar linia rambursată își pierde entitlement-ul |

`fulfillmentStatus` trebuie să suporte `partially_fulfilled`: digitalul livrat, fizicul încă nu.

---

## 8. Admin

- Editor produs: tab **„Conținut digital"** — încărcare fișiere/videoclipuri, ordonare module, marcare preview gratuit, tip de acces, limită de descărcări
- Upload de video în background, cu progres și transcodare
- Listă entitlements per comandă și per client
- Acțiuni: **resetează contorul de descărcări**, **prelungește accesul**, **revocă accesul**
- Raport: cele mai vizionate materiale, rata de accesare după cumpărare (câți chiar deschid ce au cumpărat)
- Alertă la accesări suspecte

---

## 9. Storefront

- Pagina de produs digital: listă de module cu durată, **lecție de preview gratuită (✅ decis)**, ce primești, cerințe, format
- Badge „Acces imediat după plată" / „Acces pe viață"
- `/cont/produsele-mele`: bibliotecă cu toate achizițiile digitale, player integrat, progres de vizionare (opțional), buton de descărcare cu contor rămas
- Fără mențiuni de livrare/transport pe produsele digitale

---

## 10. Ce NU construim în Val 1

Marcaje explicite ca să nu se extindă proiectul:
- ❌ Platformă LMS completă (quiz-uri, certificate, teme, forum)
- ❌ Abonamente cu acces recurent
- ❌ Progres detaliat de vizionare per secundă
- ❌ Aplicație mobilă pentru vizionare offline
- ❌ Vânzare în UE cu OSS (doar RO)
- ❌ Acces limitat în timp (toate produsele au acces pe viață)

Dacă vrei vreodată LMS, e un produs separat, nu un modul de magazin.
