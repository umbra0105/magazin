# 14 — Puncte de loialitate și vouchere cadou

Ambele confirmate. Ambele ating **motorul de prețuri și plasarea comenzii**, deci trebuie proiectate cu grijă — sunt zone unde bug-urile costă bani reali.

---

# PARTEA A — Puncte de loialitate

## 1. Ce ai stabilit
- **Acumulare: 1 punct la fiecare 100 de lei cheltuiți** (adică 1%)
- 100 lei → 1 punct · 1.000 lei → 10 puncte

## 2. ✅ Regulile stabilite

| Regulă | Decizie |
|---|---|
| Valoare punct | **1 punct = 1 leu** (cashback 1%) |
| Moment de acordare | **Automat, la expirarea ferestrei de retur** (14 zile de la livrare) |
| Expirare | **12 luni**, cu email de avertizare cu 30 de zile înainte |
| Limită de utilizare | **Fără limită** — clientul poate acoperi integral comanda |
| Grupul Partener | **Nu acumulează puncte deloc** — are deja prețuri preferențiale |

### De ce acordare automată, nu manuală cu revocare

Ai propus și varianta „acordăm la livrare și retragem manual dacă face retur". **Recomand ferm varianta automată**, din trei motive:

1. **Retragerea manuală se uită.** Nu o dată, ci sistematic. Peste un an ai zeci de clienți cu puncte pentru produse returnate și nu mai știi care.
2. **Retururile parțiale devin un coșmar.** Client returnează 1 din 3 produse — cineva trebuie să calculeze manual câte puncte se retrag. Automat, punctele pur și simplu nu se acordă pentru liniile returnate. Mult mai simplu.
3. **Nu creezi niciodată sold negativ.** Dacă acorzi și apoi retragi, clientul poate cheltui punctele între timp și ajungi să-i datorezi bani.

**Dar păstrăm și ajustarea manuală**, în fișa clientului, cu motiv obligatoriu și audit — pentru excepții, gesturi comerciale sau corecții.

Clientul vede punctele ca „în așteptare" din momentul livrării, cu data la care devin disponibile. Psihologic funcționează la fel de bine.

### ⚠️ Utilizare nelimitată — patru cazuri care trebuie tratate explicit

Ai ales să nu pui limită. E o decizie comercială validă la 1%, dar deschide patru situații care **trebuie rezolvate în cod**, altfel se sparge ceva:

**A. Comandă de 0 lei.** Dacă punctele acoperă tot, procesatorul de plăți nu poate procesa 0 lei. Ai nevoie de o ramură separată: comanda trece direct în `paid`, fără gateway, cu `paymentMethod = 'loyalty_points'`.
*Necesar în cod. Fără asta, checkout-ul crapă la primul client care încearcă.*

**B. Transportul.** La echipamente de piscină, transportul unei pompe de căldură poate fi 150-400 de lei. Dacă punctele acoperă și transportul, plătești curierul din buzunar.
*Recomandare: punctele se aplică **doar pe produse**, nu pe transport. Configurabil, dar implicit așa. Clientul plătește transportul cu bani.*

**C. Acumulare pe comenzi plătite cu puncte.** Dacă un client cumpără de 500 de lei folosind 500 de puncte și primește 5 puncte noi, ai creat o buclă.
*Recomandare: punctele se acumulează **doar pe suma plătită efectiv cu bani**. Comandă de 0 lei = 0 puncte noi.*

**D. Factura de 0 lei.** Contabil, o factură cu valoare zero e problematică. **Am adăugat asta la lista de întrebări pentru contabil** (fișierul 10). Posibil să fie nevoie să impui totuși un minim de plată în bani — întreabă înainte de a implementa.

### Partener: nu acumulează, dar ce face cu punctele existente?

Un client obișnuit strânge 200 de puncte, apoi îl promovezi la Partener. *Recomandare: **își păstrează și își poate folosi soldul existent**, dar nu mai acumulează. Confiscarea a ceva câștigat produce reclamații justificate.* Setare pe grup: `earnsLoyaltyPoints = false`.

## 3. Model de date

```
LoyaltySettings          (în Setting, grup „loyalty")
  enabled
  earnRatePerCurrency    1 punct la câte bani cheltuiți → 10000 (100 lei)
  pointValue             cât valorează 1 punct la răscumpărare → 100 (1 leu)
  grantOn                'order_paid' | 'return_window_closed'
  returnWindowDays       14
  expiryMonths           12
  maxRedeemPercent       100    ← fără limită, conform deciziei
  redeemAppliesToShipping  false ← punctele nu acoperă transportul
  earnOnDiscountedItems  bool
  earnOnShipping         false
  earnOnlyOnCashPaid     true   ← nu acumulezi puncte pe partea plătită cu puncte
  minRedeemPoints        10

LoyaltyAccount
  customerId
  balance                puncte disponibile
  pending                puncte în așteptare (comandă nelivrată încă)
  lifetimeEarned, lifetimeRedeemed

LoyaltyTransaction       ⚠️ registru imutabil, ca la contabilitate
  customerId, orderId?
  type      'earn' | 'redeem' | 'expire' | 'adjust' | 'revoke'
  points    (+/-)
  balanceAfter
  reason, expiresAt?, createdBy?, createdAt
```

**Regula de aur**: soldul nu se editează niciodată direct. Se scrie o tranzacție, iar soldul e recalculat. Altfel nu poți depana niciodată „de ce am 47 de puncte".

## 4. Calcul — unde intră în motorul de prețuri

**Acumularea** se calculează pe baza subtotalului **după toate reducerile și fără transport**:
```
bază = subtotal după reduceri (fără transport, fără taxă ramburs)
puncte = floor(bază / earnRatePerCurrency)
```
`floor`, nu rotunjire — 199 lei = 1 punct, nu 2.

**Acumularea se face doar dacă `CustomerGroup.earnsLoyaltyPoints = true`.** Pentru grupul Partener e `false`.

**Răscumpărarea** intră ca ultima reducere, după cupon, și se aplică **doar pe valoarea produselor**, nu pe transport:
```
preț → salePrice → discount de grup → cupon → PUNCTE → total
```
Reducerea din puncte se afișează ca linie separată în coș, checkout și factură. Din perspectivă contabilă e o reducere comercială — **confirmă cu contabilul cum se trece pe factură**.

## 5. Cazuri de tratat (aici apar bug-urile)

| Situație | Ce se întâmplă |
|---|---|
| Comandă anulată | Punctele acordate se revocă; punctele folosite se returnează în cont |
| Retur parțial | Se revocă proporțional punctele acumulate pe liniile returnate |
| Retur după ce clientul a cheltuit deja punctele | Soldul poate deveni negativ. *Recomandare: permite sold negativ, blochează răscumpărarea până se acoperă* |
| Comandă plătită parțial cu puncte, apoi rambursată | Rambursezi **doar banii**, punctele se întorc ca puncte. Nu converti puncte în bani niciodată |
| **Comandă acoperită integral din puncte** | Ramură separată: fără gateway de plată, status `paid` direct, `paymentMethod = 'loyalty_points'`. Transportul rămâne de plătit cu bani |
| Client promovat la Partener | Păstrează soldul și îl poate folosi, dar nu mai acumulează |
| Guest checkout | Fără puncte. Afișează „Creează cont și primești X puncte" — e un motiv bun de înregistrare |
| Puncte expirate în timp ce comanda e în curs | Blochează expirarea punctelor rezervate într-o comandă activă |

## 6. Interfață

**Cont client**: sold, puncte în așteptare cu data la care devin disponibile, istoric complet, data de expirare a următorului lot, cât valorează în lei.
**Coș/checkout**: „Ai 47 de puncte (47 lei). Folosește-le?" cu slider sau câmp de cantitate. Fără limită pe valoarea produselor; transportul rămâne de plătit cu bani.
**Pagina de produs**: „Primești 12 puncte la această achiziție" — crește conversia.
**Admin**: sold per client, ajustare manuală cu motiv obligatoriu, istoric, raport de datorie totală în puncte (cât „datorezi" clienților).

---

# PARTEA B — Vouchere cadou

## 1. Ce ai stabilit
Voucher sub formă de **cod de reducere**.

## 2. ⚠️ O întrebare importantă

Un voucher de 500 de lei folosit la o comandă de 300 de lei. Ce se întâmplă cu restul de 200?

| Variantă | Consecință |
|---|---|
| **A. Se pierde** — cod de reducere clasic, o singură utilizare | Simplu (~0,5 zile), dar la produse scumpe e o sursă sigură de reclamații |
| **B. Rămâne pe cod** — voucher cu sold, utilizabil de mai multe ori | ~1,5 zile în plus, dar e ce așteaptă clientul |

*Recomandare fermă: **B**. Vinzi echipamente de câteva mii de lei — un voucher care „arde" 200 de lei îți costă mai mult în reputație decât ziua de dezvoltare.*

## 3. Model de date

```
Voucher
  code               unic, generat, cu prefix configurabil
  initialValue       suma inițială, în bani
  balance            soldul rămas
  currency
  status             'active' | 'used' | 'expired' | 'cancelled'
  issuedTo?          email destinatar
  issuedBy?          userId dacă e emis din admin
  purchasedOrderId?  dacă a fost cumpărat ca produs pe site
  message?           mesaj personalizat pentru destinatar
  expiresAt?
  isTransferable     poate fi folosit de oricine are codul

VoucherTransaction
  voucherId, orderId, amount, balanceAfter, createdAt
```

## 4. Diferența față de un cupon (importantă)

| | Cupon | Voucher |
|---|---|---|
| Ce e | Instrument de marketing | **Instrument de plată** — clientul a dat bani pe el |
| Se cumulează cu alte reduceri | Depinde de reguli | **Da, întotdeauna** — e ca și cum ar plăti cu bani |
| Se aplică pe transport | De obicei nu | **Da** — acoperă întregul total |
| TVA | Reduce baza de TVA | ⚠️ **Nu reduce baza de TVA** — e o metodă de plată |
| Expiră | De obicei da | Termen legal minim — verifică |
| Contabil | Reducere comercială | **Datorie** în bilanț până la utilizare |

⚠️ **Asta e diferența cea mai des greșită.** Un voucher nu e o reducere, e o plată anticipată. Pe factură apare ca metodă de plată, nu ca discount. **Întrebare obligatorie pentru contabil** — am adăugat-o în lista din fișierul 10.

Deci în motorul de prețuri: voucherul **NU** intră în lanțul de reduceri. Intră la **plată**, alături de card și ramburs:
```
Total de plată: 1.850 lei
  - Voucher CADOU-4F2A:  -500 lei
  - De plătit cu cardul: 1.350 lei
```

## 5. Emitere
- **Din admin**: creezi un voucher cu valoare, destinatar, mesaj, expirare. Se trimite pe email cu design.
- **Vândut ca produs pe site**: produs de tip special, cu valoare la alegere sau valori fixe (200/500/1000 lei). La confirmarea plății se generează codul și se trimite pe email destinatarului, cu mesajul cumpărătorului.
- Generare în masă pentru campanii.

## 6. Admin
Listă cu status, sold, valoare inițială, cine l-a folosit și când. Anulare cu motiv. Ajustare de sold cu audit. **Raport de datorie**: valoarea totală a voucherelor neutilizate — cifra pe care ți-o va cere contabilul.

---

## Estimare
| | Zile |
|---|---|
| Puncte de loialitate | ~4 |
| Vouchere cu sold | ~2 |
| Ramura de comandă 0 lei + reguli de acumulare | ~0,5 |
| **Total** | **~6,5 zile** |

Ambele se fac într-o fază proprie, **după ce comenzile și plățile funcționează complet** (adică după Faza 13). Nu le construi mai devreme — depind de fluxul de comandă, retur și rambursare.
