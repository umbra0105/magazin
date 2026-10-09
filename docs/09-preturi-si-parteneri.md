# 09 — Prețuri, grupuri de clienți și parteneri (revizuit)

## 0. Ce e decis

- **Un preț public unic**, setat de noi, afișat **cu TVA inclus**, identic pentru vizitator, client persoană fizică și client persoană juridică. Niciun preț nu se ascunde.
- **Trei tipuri de grup de clienți** (`CustomerGroup.pricingType`):

| Tip | Cum se calculează prețul | Grupuri inițiale (valori editabile din admin) |
|---|---|---|
| `none` | prețul public | **Client standard** |
| `discount` | prețul public minus un procent | **Client fidel** 5% · **Client VIP** 7% |
| `cost_plus` | **prețul de achiziție (NIR, fără TVA)** + adaos + TVA | **Partener 1** 12% · **Partener 2** 17% · **Partener 3** 21% |

- Toate procentele sunt **editabile din admin, per grup**. Atribuirea clientului în grup rămâne **manuală** (individual sau în masă).
- **Nu adăugăm acum** prețuri pe categorie sau pe produs per grup. Posibil mai târziu; modelul nu îl blochează.
- **Fără modul B2B clasic**: fără liste de prețuri per client, fără tranșe de cantitate, fără comutator cu/fără TVA, fără conturi de firmă multi-utilizator. Facturarea pe firmă (CUI) la checkout rămâne disponibilă oricui.

### Ce rămâne tăiat din plan

| Tăiat | De ce nu-ți trebuie | Economie |
|---|---|---|
| Liste de prețuri per client | Ai un preț public + trei tipuri de grup | ~3 zile |
| Prețuri pe tranșe de cantitate | N-ai cerut | ~1 zi |
| Comutator „cu/fără TVA" | Prețul e mereu cu TVA | ~2 zile |
| Conturi de firmă cu utilizatori multipli și roluri | N-ai cerut | ~3 zile |
| Cereri de ofertă, aprobări interne | N-ai cerut | ~4 zile |
| Limită de credit, situație de creanțe | N-ai cerut | ~3 zile |
| **Total** | | **~16 zile** |

---

## 1. Model de date

```
CustomerGroup
  id, name, slug              "Client standard", "Client fidel", "Client VIP", "Partener 1"...
  pricingType                 'none' | 'discount' | 'cost_plus'
  discountBps?                pentru 'discount': 500 = 5,00%   (întreg în puncte de bază, NU float)
  markupBps?                  pentru 'cost_plus': 1200 = 12,00% (întreg în puncte de bază, NU float)
  isDefault                   grupul în care intră automat clienții noi
  stacksWithSalePrice         bool — doar pentru 'discount', vezi §3
  earnsLoyaltyPoints          bool — fals pentru Partener 1/2/3
  freeShippingThreshold?      opțional, prag diferit de transport gratuit
  minOrderValue?              opțional
  color                       pentru badge în admin
  isActive

Customer
  + groupId                   FK către CustomerGroup

ProductVariant
  + costPrice                 int, în bani, FĂRĂ TVA, prețul de achiziție (NIR). DOAR în admin.
  + costPriceDate             data intrării (din NIR) la care se referă costPrice

CostPriceHistory              istoricul prețurilor de achiziție
  variantId, costPrice, effectiveDate, source('manual'|'import'), importId?, createdAt

Product
  + excludeFromGroupDiscount  bool — la produsul exclus, TOȚI plătesc prețul public
Category
  + excludeFromGroupDiscount  bool — se propagă la produsele din categorie

Order (snapshot)
  + customerGroupId, groupPricingType
  + groupDiscountBps?         snapshot pentru 'discount'
  + groupMarkupBps?           snapshot pentru 'cost_plus'
  + groupAdvantageAmount      diferența față de prețul public curent, în bani (informativ)
```

> **Valorile concrete din tabelul de mai sus nu sunt în cod.** Instalarea creează doar grupul „Client standard" (`none`, neștergibil). Celelalte cinci grupuri sunt un **seed specific magazinului** (nu default de pachet), editabile din admin.

### ⚠️ Confidențialitatea prețului de achiziție
`costPrice` și `CostPriceHistory` sunt **doar pentru admin**:
- nu apar în API public, în props trimise către componente client, în JSON-ul storefront-ului, în feed-uri (Google Merchant, Facebook), în emailuri sau în loguri (cheia se adaugă în lista de câmpuri mascate a loggerului, în Faza 4);
- `OrderLine.productSnapshot` **nu include** `costPrice`. Dacă vor fi rapoarte de profit, se adaugă o coloană separată, vizibilă doar în admin;
- vizibil doar cu permisiunea `products.cost.view`, editabil cu `products.cost.edit`. În rolurile implicite, `products.cost.view` o au **Owner, Admin, Manager și Contabil**; Editor, Suport și Depozit nu o au. `products.cost.edit` o au doar Owner și Admin (`packages/core/src/rbac/catalog.ts`).

---

## 2. Cum se stochează prețul — convenția

**Prețul public se stochează BRUT (cu TVA inclus), ca `int` în bani.** Ce tastezi în admin e ce vede clientul.

```
price     = 19900          → 199,00 lei (cu TVA)
taxRate   = 21             → din TaxClass; cota standard vine din setări (implicit 21)
net       = round(19900 / 1.21)  = 16446  → 164,46 lei
tva       = 19900 - 16446        =  3454  →  34,54 lei
```

**Excepția controlată: `costPrice` e NET (fără TVA)**, pentru că așa apare pe NIR. Se transformă în brut doar în formula de la §3.

**Reguli obligatorii (sunt și în `CLAUDE.md`):**
- Toate sumele sunt `int` în bani. Procentele sunt `int` în puncte de bază. Niciodată `float`.
- **Rotunjirea se face pe linie de comandă, o singură dată.** Totalul comenzii e suma liniilor rotunjite.
- TVA-ul se extrage din brut pentru factură, nu se adaugă peste.
- Fiecare `OrderLine` stochează: `unitPrice`, `taxRate`, `taxAmount`, `netAmount`, `lineTotal`, toate ca snapshot.
- `lineTotal` se calculează o singură dată, din valoarea **exactă** (fără rotunjiri intermediare) × cantitate. `unitPrice` e prețul unitar rotunjit și are rol informativ; la prețuri publice (întregi) cele două coincid, la prețurile `discount` și `cost_plus` pot diferi cu 1 ban pe linie, iar `lineTotal` este cel care contează.
- Verifică cu contabilul pe o comandă reală înainte de lansare.

---

## 3. Ordinea de calcul a prețului

```
1. price                      preț de listă, brut
2. → salePrice                dacă există promoție publică activă
                              => prețul public curent = min(price, salePrice)
3. → preț de grup             depinde de pricingType (mai jos)
4. → cupon                    aplicat peste rezultatul de mai sus
5. → puncte de loialitate     ultima reducere (vezi 14)
6. → total linie              rotunjit o singură dată
7. → extragere TVA            pentru factură
```

### Pasul 3, pe tip de grup

**`none`** — prețul public curent. Nimic de calculat.

**`discount`** (Client fidel 5%, Client VIP 7%):
```
candidat = price × (1 − discountBps / 10000)
rezultat = min(candidat, prețul public curent)          ← implicit, NU se cumulează cu promoția
                                                          (se ia prețul cel mai mic)
dacă group.stacksWithSalePrice și există salePrice:
rezultat = salePrice × (1 − discountBps / 10000)        ← cumulare, doar dacă e bifat pe grup
```

**`cost_plus`** (Partener 1/2/3):
```
pret_brut = costNet × (1 + adaos) × (1 + TVA)
          = costNet × (10000 + markupBps) × (10000 + vatBps) / 10000²
rezultat  = min(pret_brut, prețul public curent)        ← PLAFON
```
- `costNet` = `ProductVariant.costPrice` (NIR, fără TVA). `TVA` = cota produsului (clasa de taxare; cota standard din setări, implicit 21%).
- **Plafon:** partenerul plătește **minimul** dintre prețul lui calculat și prețul public curent (inclusiv promoția). **Nu poate plăti mai mult decât oricine altcineva.**
- **Produs fără preț de achiziție** (`costPrice` lipsă): se aplică **prețul public**, iar produsul apare cu avertisment în admin („produse fără preț NIR").
- `stacksWithSalePrice` nu are efect la `cost_plus` (se ia oricum minimul).
- Exemplu: `costNet` = 100,00 lei, Partener 1 (12%), TVA 21% → 100 × 1,12 × 1,21 = **135,52 lei**. Dacă prețul public curent e 129,00 lei (promoție), partenerul plătește **129,00 lei**.

**Excluderi (ambele tipuri):** dacă produsul sau categoria are `excludeFromGroupDiscount`, grupul nu se aplică și toți plătesc prețul public curent.

### Cuponul
- Cuponul **SE cumulează** cu prețul de grup, cu excepția cupoanelor marcate `notForDiscountedGroups`.
- „Grup cu preț special" înseamnă orice grup cu `pricingType ≠ none` (deci Fidel, VIP și Parteneri). Un cupon marcat `notForDiscountedGroups` nu se aplică deloc acestor clienți. Îl folosești la campaniile mari.

### Punctele de loialitate
- Clienții **Standard, Fidel și VIP acumulează puncte**; **Partenerii NU** (`earnsLoyaltyPoints = false`).
- Discountul Fidel/VIP se **cumulează** cu punctele. Vezi `14`.

---

## 4. Prețul de achiziție (NIR)

### Ce e „prețul de achiziție"
**Cel mai recent preț de intrare** din lista de recepții (NIR). Poate scădea sau crește; câștigă mereu cel mai recent, nu minimul sau maximul.

### Cum ajunge în sistem
Săptămânal, utilizatorul importă un fișier exportat din SmartBill („lista de mișcări produse", cu preț și dată de intrare). Un API SmartBill poate înlocui importul mai târziu.

**Instrumentul de import (Faza 15, odată cu grupurile):**
1. Upload în admin + **dry-run** cu previzualizare, apoi confirmare. Procesare în queue.
2. **Potrivire pe codul produsului (SKU de variantă).**
3. Per produs se ia **intrarea cu cea mai recentă dată** din fișier.
4. Se actualizează `costPrice` și `costPriceDate` **doar dacă data e mai nouă** decât `costPriceDate` curentă. Fiecare actualizare scrie în `CostPriceHistory`.
5. **Raport final:** actualizate · neschimbate (data nu e mai nouă) · **coduri necunoscute** (SKU inexistent) · rânduri invalide (preț sau dată neparsabile). Descărcabil.
6. **Repetabil:** același fișier rulat de două ori nu schimbă nimic și nu dublează istoricul.
7. Permisiune dedicată, `auditLog()` pe fiecare import.

> ⏳ **Format exact: așteptăm un fișier exemplu de la utilizator înainte de Faza 15.** Se confirmă atunci: numele coloanelor, formatul datei, dacă prețul din export e fără TVA, tratamentul mai multor intrări cu aceeași dată pentru același cod.

### Avertisment în admin: „produse fără preț NIR"
- Indicator în dashboard și în lista de produse, cu filtru.
- Banner în editorul produsului.
- Asemenea produse se vând partenerilor la prețul public (vezi §3).

### Consecințe de care ținem cont
- **Prețul unui partener se schimbă săptămânal**, odată cu importul. Coșurile deschise se revalidează la fiecare afișare (mesaj clar dacă s-a schimbat prețul). Comanda plasată păstrează snapshot-ul.
- **Prețul de partener e per client.** Paginile publice cu cache (ISR) nu îl pot conține; se calculează separat, dinamic, pentru clientul logat (Fazele 7 și 15).

---

## 5. Afișare în storefront

| Cine | Ce vede |
|---|---|
| Vizitator / client standard | `199,00 lei` |
| Client fidel (−5%) | `189,05 lei` · dedesubt: `Preț standard 199,00 lei` · badge **„Preț client fidel −5%"** |
| Partener | `178,00 lei` · dedesubt: `Preț standard 199,00 lei` · badge **„Preț partener"** (dacă prețul lui e mai mic decât cel public; dacă e egal, se afișează simplu) |

- **Pe PLP și pe PDP**: același tratament pe carduri, altfel clientul vede un preț în listă și altul pe pagina produsului.
- **În coș și checkout:**
  - Fidel/VIP: linie separată `Reducere client fidel (−5%): −9,95 lei`.
  - Partener: linie informativă `Avantaj partener: −21,00 lei` (diferența față de prețul public, deja inclusă în preț).
- **În factură:**
  - Fidel/VIP: reducerea apare explicit pe linie sau ca discount.
  - Partener: apare **prețul unitar încasat**, **nimic special** (confirmat de contabil).
- Nu există comutator cu/fără TVA. Prețul afișat e mereu cu TVA inclus.

### ⚠️ Notă legală (Omnibus)
Prețul de grup e un **preț personalizat**, nu un anunț public de reducere. Nu intră sub obligația de a afișa cel mai mic preț din ultimele 30 de zile. **Dar**: nu îl prezenta ca promoție publică („−15% doar azi!"). Etichetează-l clar ca preț de fidelitate/partener. Promoțiile publice (`salePrice`) rămân sub regula Omnibus și au nevoie de `PriceHistory`.

---

## 6. În panoul de administrare

**Setări → Grupuri de clienți**
- CRUD: nume, **tip de preț** (`none` / `discount` / `cost_plus`), procentul relevant (reducere sau adaos), culoare de badge, grup implicit, bifa „acumulează puncte", prag transport gratuit opțional, valoare minimă de comandă opțională, bifa de cumulare cu promoții (doar la `discount`).
- Grupul „Client standard" (`none`) există din instalare și nu se poate șterge.

**Clienți**
- Coloană „Grup" cu badge colorat + filtru după grup · dropdown de grup în fișa clientului.
- **Atribuire în masă**: selectezi 20 de clienți → „Mută în grupul Partener 1".
- Istoric în audit log: cine a schimbat grupul și când.

**Produse**
- Bifă „Exclude din prețul de grup" pe produs și pe categorie.
- Câmpurile `costPrice` / `costPriceDate` în tab-ul „Prețuri", vizibile doar cu `products.cost.view`.
- Indicator și filtru „produse fără preț NIR".

**Import NIR** (§4): upload, dry-run, raport.

**Rapoarte**
- Vânzări per grup de clienți.
- Valoarea totală a avantajului acordat (discount + avantaj partener), pe perioadă.
- Top parteneri după valoarea comenzilor.

### ✅ DECIS: atribuirea grupului se face MANUAL
Adminul mută clientul în grup, individual sau în masă. Nu construim regulă automată de promovare în Val 1.

---

## 7. Teste obligatorii (scrise ÎNAINTE de implementare)

**Existente, adaptate la cele trei tipuri:**
- Preț corect pentru: vizitator, client standard, Fidel, VIP, Partener, produs exclus
- Produs cu promoție + grup `discount`: ambele variante de cumulare (`stacksWithSalePrice`)
- Cupon peste prețul de grup; cupon `notForDiscountedGroups` blocat pentru Fidel, VIP și Partener
- Rotunjire: coș cu 3 produse × cantitate 3, verificare că totalul din coș = totalul din comandă = totalul din factură
- Extragerea TVA din brut la cota standard din setări; testele păstrează și o a doua cotă, ca dovadă că cotele nu sunt hardcodate
- Snapshot: schimbi grupul clientului sau procentul grupului după plasarea comenzii → comanda veche nu se modifică
- Client fără grup atribuit → primește grupul implicit, nu crapă

**Noi, pentru `cost_plus`:**
- Formula: `costNet` 100,00 lei · adaos 12% · TVA 21% → 135,52 lei
- **Plafon:** prețul calculat > prețul public → se plătește prețul public; prețul calculat < prețul public → se plătește cel calculat
- Plafon față de **prețul promoțional** (promoția scade sub prețul de partener)
- Produs fără `costPrice` → preț public + apare în raportul „fără NIR"
- Produs sau categorie cu `excludeFromGroupDiscount` → preț public pentru Partener
- Schimbarea `costPrice` (în sus și în jos) → prețul partenerului urmează; comenzile vechi nu se schimbă
- Rotunjire pe linie la `cost_plus`: cantitate 7, rezultat exact cu fracțiune de ban → `lineTotal` rotunjit o singură dată
- Securitate: `costPrice` absent din răspunsurile API publice, din snapshot-ul de pe comandă și din loguri

**Pentru importul NIR:**
- Se ia cea mai recentă dată per cod; actualizare doar dacă data e mai nouă
- Același fișier de două ori → zero modificări, zero dubluri în istoric
- Coduri necunoscute raportate; rânduri invalide raportate
- Prețul scade față de importul anterior → se actualizează (nu se păstrează maximul)
