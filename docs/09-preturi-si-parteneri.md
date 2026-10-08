# 09 — Prețuri, grupuri de clienți și parteneri

## 0. Ce am înțeles din răspunsul tău

- **Un singur preț public**, afișat **cu TVA inclus**, identic pentru vizitator, client persoană fizică și client persoană juridică.
- **Excepție**: clienții marcați în sistem ca **„Partener"** sau **„Client fidel"** văd același preț **minus X%**.
- **Nimic nu se ascunde**: vizitatorul nelogat vede prețul normal, complet.

**Concluzia mea: nu ai nevoie de modul B2B.** Ai nevoie de *grupuri de clienți cu discount procentual*. E o funcționalitate de ~2-3 zile, nu de 10.

### Ce am tăiat din plan (și economia de timp)

| Tăiat | De ce nu-ți trebuie | Economie |
|---|---|---|
| Liste de prețuri per client | Ai un preț unic + procent | ~3 zile |
| Prețuri pe tranșe de cantitate | N-ai cerut | ~1 zi |
| Comutator „cu/fără TVA" | Prețul e mereu cu TVA | ~2 zile |
| Conturi de firmă cu utilizatori multipli și roluri | N-ai cerut | ~3 zile |
| Cereri de ofertă, aprobări interne | N-ai cerut | ~4 zile |
| Limită de credit, situație de creanțe | Doar dacă vrei plată la termen (întrebare deschisă) | ~3 zile |
| **Total** | | **~16 zile** |

Ce rămâne din partea „B2B": **facturarea pe firmă la checkout** (CUI, Reg. Com., adresă) — dar aceea e disponibilă oricui, nu ține de grupuri. E deja în planul de checkout.

---

## 1. Model de date (tot ce trebuie)

```
CustomerGroup
  id, name                    "Standard", "Partener", "Client fidel"
  slug
  discountPercent             0, 15, 5
  isDefault                   grupul în care intră automat clienții noi
  stacksWithSalePrice         bool — vezi §3
  freeShippingThreshold?      opțional, prag diferit de transport gratuit
  minOrderValue?              opțional
  color                       pentru badge în admin
  isActive

Customer
  + groupId                   FK către CustomerGroup

Product
  + excludeFromGroupDiscount  bool — produse la care nu se aplică discountul

Category
  + excludeFromGroupDiscount  bool — se propagă la produsele din categorie

Order
  + customerGroupId           snapshot
  + groupDiscountPercent      snapshot — procentul de la momentul comenzii
  + groupDiscountAmount       snapshot — suma
```

Cinci câmpuri noi și un tabel. Atât.

---

## 2. Cum se stochează prețul — decizia de convenție

**Recomandarea mea: stochează prețul BRUT (cu TVA inclus).**

De ce: e prețul pe care administratorul îl tastează în admin și pe care clientul îl vede. Dacă stochezi net și afișezi brut, ajungi la situația clasică în care admin-ul scrie 199 și pe site apare 199,01 din cauza rotunjirii. Cu preț brut, ce tastezi e ce se afișează, mereu.

```
price     = 19900          → 199,00 lei (cu TVA)
taxRate   = 21             → din TaxClass, configurabil
net       = round(19900 / 1.21)  = 16446  → 164,46 lei
tva       = 19900 - 16446        =  3454  →  34,54 lei
```

**Reguli obligatorii (pune-le în `CLAUDE.md`):**
- Toate sumele sunt `int` în bani, brut, cu TVA inclus.
- Rotunjirea se face **pe linie de comandă**, o singură dată. Totalul e suma liniilor rotunjite — niciodată invers.
- TVA-ul se extrage din brut pentru factură, nu se adaugă peste.
- Fiecare `OrderLine` stochează: `unitPrice` (brut), `taxRate`, `taxAmount`, `netAmount`, `lineTotal`. Toate ca snapshot.
- Verifică cu contabilul pe o comandă reală înainte de lansare.

---

## 3. Ordinea de calcul a prețului

```
1. price                          preț de listă, brut
2. → salePrice                    dacă există promoție publică activă
3. → discount de grup             preț × (1 − group.discountPercent / 100)
                                  se sare peste dacă produsul sau categoria
                                  are excludeFromGroupDiscount
4. → cupon                        aplicat peste rezultatul de mai sus
5. → total linie                  rotunjit
6. → extragere TVA                pentru factură
```

### ⚠️ Cazul care trebuie decis: produs cu promoție + client partener

Produs 200 lei, promoție publică −20% (160 lei), partener −15%.

| Variantă | Rezultat | Comentariu |
|---|---|---|
| **A. Nu se cumulează — se ia cel mai bun** | 160 lei | Cel mai sigur comercial. Partenerul nu primește discount peste promoție. |
| **B. Se cumulează** | 136 lei | Generos, dar poți vinde sub cost la promoții agresive. |
| **C. Setare pe grup** (`stacksWithSalePrice`) | tu alegi per grup | Flexibil, cost aproape zero de implementat. |

### ✅ DECIS: varianta C, cu implicit A
Câmpul `stacksWithSalePrice` există pe fiecare grup, **nebifat implicit**. Adică partenerul plătește 160 lei, nu 136, dacă nu bifezi explicit cumularea pe grupul respectiv.

### ✅ DECIS: cuponul se cumulează cu discountul de partener
Se aplică peste prețul de partener. **Dar** pe `Discount` există flag-ul `notForDiscountedGroups` — dacă îl bifezi, cuponul nu se aplică deloc clienților dintr-un grup cu discount. Îl folosești la campaniile mari.

---

## 4. Afișare în storefront

| Cine | Ce vede |
|---|---|
| Vizitator / client standard | `199,00 lei` |
| Partener logat (−15%) | `169,15 lei` · dedesubt: `Preț standard 199,00 lei` · badge **„Preț partener −15%"** |

- **În coș și checkout**: linie separată, `Reducere partener (−15%): −29,85 lei`. Clientul trebuie să vadă de unde vine discountul.
- **În factură**: reducerea apare explicit pe linie sau ca discount, nu ascunsă în preț. Contabilul îți va mulțumi.
- **Pe PLP**: același tratament pe carduri, altfel clientul vede un preț în listă și altul pe pagina produsului.
- **Badge-ul e important**: partenerul trebuie să *simtă* beneficiul, altfel nu știe că îl are.

### ⚠️ Notă legală (Omnibus)
Reducerea de partener e o **reducere personalizată de fidelitate**, nu un anunț public de reducere de preț. Nu intră sub obligația de a afișa cel mai mic preț din ultimele 30 de zile. **Dar**: nu o prezenta ca promoție publică („−15% doar azi!"). Etichetează-o clar ca preț de partener/fidelitate. Promoțiile publice (`salePrice`) rămân sub regula Omnibus și au nevoie de `PriceHistory`.

---

## 5. În panoul de administrare

**Setări → Grupuri de clienți**
- CRUD: nume, discount %, culoare de badge, grup implicit, prag transport gratuit opțional, valoare minimă de comandă opțională, bifa de cumulare cu promoții
- Grupul „Standard" cu 0% există din instalare și nu se poate șterge

**Clienți**
- Coloană „Grup" cu badge colorat + filtru după grup
- Dropdown de grup în fișa clientului
- **Atribuire în masă**: selectezi 20 de clienți → „Mută în grupul Partener"
- Istoric în audit log: cine a schimbat grupul și când

**Produse**
- Bifă „Exclude din discountul de grup" pe produs și pe categorie

**Rapoarte**
- Vânzări per grup de clienți
- Valoarea totală a discountului acordat, pe perioadă
- Top parteneri după valoarea comenzilor

### ✅ DECIS: atribuirea grupului se face MANUAL
Adminul mută clientul în grup, individual sau în masă. **Nu construim regulă automată de promovare** în Val 1. Dacă o vrei mai târziu: cron zilnic + regulă („peste X lei cheltuiți") + email de notificare ≈ 1 zi.

---

## 6. Teste obligatorii

- Preț corect pentru: vizitator, client standard, partener, partener pe produs exclus
- Produs cu promoție + partener → rezultatul așteptat pentru fiecare variantă de cumulare
- Cupon + discount de partener
- Rotunjire: coș cu 3 produse × cantitate 3, verificare că totalul din coș = totalul din comandă = totalul din factură
- Extragerea TVA din brut, la cote diferite (21% și 11%)
- Snapshot: schimbi grupul clientului după plasarea comenzii → comanda veche nu se modifică
- Client fără grup atribuit → primește grupul implicit, nu crapă
