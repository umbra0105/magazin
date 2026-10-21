# Faza 5 (Stoc) — plan revizuit, pentru aprobare

**Stare:** doar planificare. Niciun cod, nicio migrație, nicio schimbare în baza de date. Nimic din punctul 1 nu începe până nu
aprobi planul revizuit. Versiuni: prima 2026-10-21; a doua după D2–D5, D1 și D6; **a treia (2026-10-21): D1 și D6 APROBATE, iar
D11 se schimbă — unități de măsură și cantități zecimale.**

Surse: `docs/06-todo-master.md` (Faza 5, 8, 9, 12, 13, 15), `docs/04-backend-admin.md`, `docs/09-preturi-si-parteneri.md`,
`docs/10-decizii-deschise.md`, `docs/12-emag-marketplace.md`, `docs/15-specific-nisa-piscine.md`, regulile din `CLAUDE.md`, starea
reală din cod (schema Prisma, import/export, mesaje) și fișierul tău WooCommerce din `local-data/`.

---

# 1. Decizii luate

| # | Decizie | Cine / când |
| --- | --- | --- |
| — | Gestiunea „ca în WooCommerce”: setare globală `inventory.manageStock` + bifă pe produs + bifă pe variantă (moștenește de la produs). `manageStock = false` → doar „în stoc / indisponibil / la comandă”, **ramură explicită în cod**, zero rezervări | specificație |
| — | Rezervarea începe la inițierea plății; **coșul nu rezervă nimic** | specificație + D4 |
| — | La stoc 0: „indisponibil” + „anunță-mă când revine” | specificație |
| — | Test obligatoriu de concurență: 10 cereri deodată pe ultima bucată → una singură reușește | specificație |
| **D1** | **APROBAT: varianta A, „poză + angajat”.** SmartBill este sursa cantității fizice; aplicația ține „angajatul” (comenzi online încă neoglindite) și „rezervatul”; **regula: o bucată se scade o singură dată** (factură înainte de poză → oglindită; după poză → încă angajată). Soluția de trecere în Faza 5: **importul „stoc la zi” din SmartBill (punctul 11)**. **Condițiile „înainte de lansare” rămân în plan** (Anexa A, D1.5). Integrarea reală cu SmartBill rămâne în **Faza 13/15** | tu |
| **D2** | Inventarul (SKU și cantitate) îl faci tu. Până atunci produsele rămân „în stoc” fără cantitate (**negestionate**); importul WooCommerce le pune așa | tu |
| **D3** | O singură locație în interfață, numită **„Depozit principal”** (**redenumibilă**); magazinul fizic, cel online și depozitul sunt în același loc. Modelul multi-depozit rămâne în bază, comutatorul `multiWarehouse` oprit | tu |
| **D4** | Card: rezervare **15 minute**. Ramburs: scade **imediat** la plasare. Transfer bancar: **3 zile lucrătoare, setabil**. Coșul nu rezervă | tu |
| **D5** | **Fără stoc negativ**, garantat în baza de date (și cu cantități zecimale: vezi D11) | tu |
| **D6** | **APROBAT cum a fost recomandat:** patru stări vizibile (În stoc / Stoc limitat / La comandă cu termen / Indisponibil); termen în zile **pe produs, cu implicit din brand, apoi din setarea globală**; **hibrid** (produsul gestionat devine „La comandă” la epuizare) cu `allowBackorder` **oprit implicit**; coșuri mixte: **livrare toată odată**, livrarea pe părți ca opțiune ulterioară. Detalii: Anexa B | tu |
| **D11** | **SCHIMBAT: NU doar bucăți întregi.** Se vând produse la **metri liniari, metri pătrați, kilograme, litri** etc.; **cantitățile pot fi zecimale.** Proiectarea completă și alternativele: secțiunea 2 (D11) | tu |

## Ce am găsit în codul actual despre unitatea de măsură (verificat)

| Loc | Ce există | Concluzie |
| --- | --- | --- |
| **Produs / variantă** (`schema.prisma`) | **Nimic.** Niciun câmp, enum sau tabel de unități. Prețul, stocul (viitor) și SKU-ul sunt pe variantă, implicit „pe bucată” | De la zero |
| **Atribute tehnice** (`Attribute.unit`) | Text liber (ex. `mm`, `kW`, `m³/h`), doar la atributele numerice, afișat lângă valoare și în filtre | **Altceva** (specificație tehnică, nu unitate de vânzare). Nu se refolosește |
| **Greutate / dimensiuni** (`weightGrams`, `lengthMm` …) | Numere întregi în grame / milimetri, pe variantă (implicit pentru **o unitate vândută**) | La cantități zecimale, greutatea liniei = greutate pe unitate × cantitate (Faza 12) |
| **Import / export generic** | Fără coloană de unitate; fără minim/pas | Se adaugă (punctul 8) |
| **Import WooCommerce** | „Unități” din formular = kg/g și cm/mm/m, **doar pentru conversia greutății și dimensiunilor** | Nu e unitate de vânzare |
| **Fișierul tău WooCommerce** | Nicio coloană de unitate de vânzare. Există `Meta: woodmart_price_unit_of_measure` (eticheta de unitate din tema veche), **goală la toate cele 8 produse**; nu există minim/pas | Toate cele 8 se importă „buc” |
| **Mesaje în română** | „Unitate de măsură” apare doar la atribute | — |
| **Motorul de prețuri** (Faza 8) | Încă nescris | Va primi cantitatea ca număr zecimal (miimi), cu **o singură rotunjire pe linie** (regula din `CLAUDE.md`) |

**Alte fapte din cod și din fișiere, relevante:**

- Azi toate produsele au `manageStock = true`, dar nu există nicio cantitate. Importul WooCommerce ignoră stocul („stocul nu se
  importă (Faza 5)”). Toate cele 8 produse au „În stoc?” = 1, „Stoc” gol, „Precomenzile sunt permise?” = 0.
- `Meta: _smartbill_sku` este **gol la cele 8 produse**: potrivirea SKU = cod SmartBill se verifică doar cu un export SmartBill.
- Pe produs există `manageStock`, `stockStatus` (`instock` / `outofstock` / `onbackorder`), `allowBackorder`, `expectedRestockDate`;
  pe variantă `manageStock` și `stockStatus`. Permisiunile `inventory.read/write` există (Owner, Admin, Manager, Depozit).

---

# 2. Decizii rămase deschise pentru tine

## D11 — Unități de măsură și cantități zecimale

Răspunsurile la (a)–(i) din cerere. Pentru fiecare: alternative, **recomandare** și consecințe. Nimic de aici nu e decis până nu
alegi.

### (a) Unitățile: listă configurabilă, cu precizie zecimală

| Variantă | Cum arată | Avantaje | Dezavantaje |
| --- | --- | --- | --- |
| **A. Tabel „Unități de măsură”, configurabil din admin (RECOMANDAT)** | Fiecare unitate are: cod stabil, denumire, simbol afișat, **precizie (0–3 zecimale)**, **numele din SmartBill**, pas implicit, prag de stoc mic implicit, activă. Seed inițial: **buc, m, mp, kg, l, rolă, set, cutie, pachet** (editabil). O unitate folosită nu se șterge, doar se dezactivează | Respectă „nimic hardcodat” (alt client, alte unități); precizia stă lângă unitate; mapare SmartBill într-un singur loc | O pagină de administrare în plus (mică, ca „Atribute”) |
| B. Enum fix în cod | O listă scrisă în program | Cel mai simplu | Contrazice regula #1 a proiectului; orice unitate nouă cere modificarea codului |
| C. Text liber pe variantă | Scrii „m” sau „metri” | Flexibil | Fără precizie, fără validare, fără mapare SmartBill; „m”, „ml”, „metru” devin trei lucruri diferite |

- **Unde stă unitatea:** pe **variantă** (obligatorie, implicit „buc”). Motiv: stocul, prețul, SKU-ul și produsul SmartBill sunt pe
  variantă, iar „rolă” și „metru” pot fi variante diferite ale aceluiași produs. Editorul de produs o copiază la variantele noi.
- **Precizia propusă** (de confirmat cu exemplele tale): buc, rolă, set, cutie, pachet = 0; m, mp = 2; kg, l = 3.
- Toate cantitățile folosesc **cel mult 3 zecimale** (vezi (b)).

### (b) Tipul și precizia cantităților în bază; „fără stoc negativ” cu zecimale

| Variantă | Cum | Avantaje | Dezavantaje |
| --- | --- | --- | --- |
| **B1. Număr întreg în miimi (RECOMANDAT)** — `2,350 m` se stochează `2350`; un modul `Quantity` în `packages/shared` (analog lui `Money`) citește/afișează după precizia unității | Aritmetică exactă, fără biblioteci; aceeași regulă ca la bani („niciodată float”); **actualizarea condiționată dintr-o singură comandă SQL** rămâne la fel; CHECK `≥ 0` simplu | Limită practică: ~2.147.483 de unități (la 3 zecimale); mult peste orice stoc realist; dacă ai nevoie de mai mult, trecem pe BIGINT |
| B2. `NUMERIC(12,3)` în Postgres + `Prisma.Decimal` în JS | Exact, fără limită practică | Bibliotecă de numere zecimale în tot codul; riscul ca o valoare să treacă accidental prin `number` (float); comparațiile și sumele cer disciplină |
| B3. `float` | **NU**: `0,1 + 0,2 ≠ 0,3`; ar permite stoc „puțin negativ” din rotunjiri | — |

- **Garanția „fără negativ”:** CHECK-uri în bază (`fizic ≥ 0`, `angajat ≥ 0`, `rezervat ≥ 0`), plus rezervarea ca **o singură comandă
  condiționată** („scade doar dacă disponibilul ≥ cantitatea cerută”). Funcționează identic cu zecimale, pentru că toate calculele sunt
  pe numere întregi exacte. **Test:** 10 cereri deodată de 0,3 pe stoc 1,0 → exact 3 reușesc, rămâne exact 0,1; cantitate peste precizia
  unității (de ex. 0,001 m cu precizie 2) → refuzată cu mesaj.
- **Ce NU poate garanta baza singură:** precizia după unitate (depinde de unitatea variantei) — o garantează serviciul și un test de
  arhitectură; în bază rămân garantate „întreg” și „≥ 0”.

### (c) Cantitate minimă de comandă și pas

- Pe **variantă**: `cantitate minimă` (implicit 1 unitate) și `pas` (implicit 1 unitate). **Regula** (ca în WooCommerce): cantitatea e
  validă dacă este ≥ minim **și** (cantitate − minim) este multiplu de pas. Exemple: furtun, m: minim 1, pas 0,5 → 1; 1,5; 2 …; rolă:
  minim 1, pas 1; sare, kg: minim 1, pas 1.
- Pasul nu poate fi mai fin decât precizia unității (la m cu 2 zecimale: pas ≥ 0,01).
- **Unde se validează:** la adăugarea în coș, la modificarea cantității, la plasarea comenzii (server, de la zero) și la rezervare.
  Mesaj în română: „Cantitatea minimă este 5 m, în pași de 0,5 m.” În Faza 5 construim câmpurile, validarea și testele; coșul și
  checkout-ul o apelează în Faza 8/9.
- **Consecință pentru stoc („rest sub minim”):** dacă mai ai 0,4 m și minimul e 1 m, produsul apare **Indisponibil** (sau „La comandă”
  cu hibrid) deși fizic există material; adminul vede „rest nevandabil: 0,4 m”. Disponibilul vândut e cea mai mare cantitate **validă**
  ≤ disponibil.
- *Alternativă:* minim/pas pe produs, nu pe variantă — mai puține câmpuri, dar rola și metrul nu pot avea reguli diferite.
  **Recomand variantă.**
- Nu includem acum: cantitate maximă pe comandă (rămâne o limită tehnică de siguranță pe linie, setabilă).

### (d) Prețul pe unitate și rotunjirea (legătura cu TVA-ul inclus și cu factura SmartBill)

- **Prețul variantei = prețul unei unități de vânzare**, brut cu TVA, în bani (ex. 12,50 lei/m = 1250). **Linia = preț × cantitate,
  rotunjit o singură dată la bani (jumătate în sus)**; totalul = suma liniilor; TVA-ul liniei se extrage din brutul liniei (regulile
  din `CLAUDE.md`, neschimbate). Exemplu: 12,50 lei/m × 2,35 m = 29,375 → **29,38 lei**.
- Reducerile (grup, cupon) se aplică pe linia **nerotunjită** și se rotunjește o singură dată; la cantități întregi rezultatul rămâne
  identic cu cel de azi. Motorul de prețuri (Faza 8) va primi cantitatea în miimi.
- Nu permitem prețuri cu mai mult de 2 zecimale pe unitate (ex. 0,125 lei/m). Dacă ai astfel de produse, spune: alternativa e „preț
  pentru 100 m”, nu acum.
- **Factura SmartBill — de confirmat cu contabilul și în documentația API (Faza 13):**
  1. SmartBill rotunjește **pe linie** sau **pe total**? Pe ce bază (preț net × cantitate sau brut)? Dacă diferă de regula noastră, totalul facturii poate ieși cu **1 ban** diferit de suma încasată.
  2. Câte zecimale acceptă **cantitatea** în SmartBill (2? 3?) și cum se numește câmpul de **unitate** în facturi.
  3. Cum e configurată în contul tău rotunjirea documentelor.
  - Variante de aliniere (se alege după răspuns): (i) trimitem preț unitar brut + cantitate și verificăm pe 20 de cazuri numerice (recomandat, testat în Faza 13); (ii) ajustăm prețul unitar trimis (nu recomand: pierde claritatea); (iii) acceptăm diferența de 1 ban (numai cu acordul contabilului).
- *Afișare legală:* pentru produse preambalate vândute la greutate/volum poate fi obligatorie afișarea **prețului pe unitatea de referință**
  (lei/kg, lei/l); **de verificat cu avocatul**. Modelul permite ulterior un câmp „cantitate de referință” fără schimbări majore.
- **Transport:** greutatea variantei este pe unitate vândută; la 2,35 m greutatea liniei = greutate pe unitate × cantitate (se notează
  pentru Faza 12).

### (e) Produs vândut și ca rolă întreagă, și la metru

| Variantă | Cum | Când se potrivește | Dezavantaje |
| --- | --- | --- | --- |
| E1. Două variante cu stocuri separate (rolă / metru) | Fiecare cu SKU și stoc propriu | Când în SmartBill sunt **două produse** diferite | Dacă materialul fizic e același, îl numeri de două ori |
| **E2. O singură variantă în metri + scurtătură „ambalaj” (RECOMANDAT când e un singur produs în SmartBill)** | Stocul în metri; butonul „Rolă întreagă = 25 m” setează cantitatea | Prețul pe metru e același și SmartBill are un singur produs în m | Nu poate avea alt preț pe rolă |
| E3. Conversie automată între variante | Rola scade 25 m din stocul în metri | — | Complex și ambiguu; **nu acum** |

- **Regula simplă:** modelăm exact ca în SmartBill — **un SKU = un produs SmartBill = o unitate.** Dacă în SmartBill sunt două produse,
  sunt două variante; dacă e unul în metri, e o variantă în metri. Scurtătura „ambalaj” (mărimea ambalajului) vine cu vitrina (Faza 7);
  în Faza 5 există minimul și pasul.

### (f) Afișare, import și export

- **Afișare:** virgulă zecimală; unitatea lângă cantitate („128,5 m”, „2 rolă”); prețul „12,50 lei / m”; zecimalele afișate = cele
  necesare, cel mult precizia unității; în editare, câmp text (nu `type="number"`), acceptă virgulă sau punct, mesaje în română
  („Cantitatea poate avea cel mult 2 zecimale pentru m.”).
- **Import/export de produse:** coloane noi: **„Unitate de măsură”** (denumire sau simbol din listă; necunoscută = eroare cu lista
  valorilor), **„Cantitate minimă”**, **„Pas de cantitate”**. Exportul are aceleași coloane ca importul.
- **Import „stoc la zi”:** cantitatea se citește cu **separator zecimal ales explicit** (virgulă / punct, detectat din fișier); celulele
  ambigue (`1.234`) se refuză cu explicație; separatorul de mii se acceptă doar dacă e neechivoc (`1.234,50`). Cantitatea peste precizia
  unității se **rotunjește în jos** (nu creează stoc inexistent), cu avertisment în raport.
- **Reguli CSV existente (`CLAUDE.md`):** doar prin funcția comună (BOM UTF-8 + `sep=;`), antet în română; la deschidere cu dublu-click în
  Excel, coloanele sunt separate. Cantitățile zecimale se scriu cu **virgulă**; **atenție:** Excel poate transforma un text de tip `1.5` într-o
  dată; pentru fișiere cu cantități recomand **XLSX** (cantități ca numere, coduri ca text), iar în CSV virgula.
- **WooCommerce:** nu are unitate de vânzare; toate produsele importate devin „buc”. Dacă `woodmart_price_unit_of_measure` e completat,
  îl citim ca **etichetă** și îl potrivim cu lista (altfel „buc”). Unitățile, minimul și pasul le setezi apoi în admin sau cu importul generic.

### (g) Maparea la unitățile SmartBill

- Câmpul **„nume în SmartBill”** pe fiecare unitate (text exact, ex. `buc`, `mp`, `ml`). Îl folosim (1) la facturi (Faza 13) ca unitate a liniei și (2)
  la importul „stoc la zi”: dacă unitatea din fișier ≠ unitatea variantei, rândul apare în raport („SmartBill: kg · magazin: buc”) și **nu se
  aplică**.
- Lista unităților din SmartBill diferă de la un cont la altul; **îmi trebuie lista ta** (export sau captură). Nu pot afirma din memorie cum
  validează API-ul numele unităților: se citește în Faza 13.

### (h) Impactul asupra rezervării, angajatului și alertelor

- Rezervarea, angajatul și oglindirea (Anexa A) lucrează la fel, pe cantități în miimi; condiția „disponibil ≥ cantitate” e aceeași.
- **Praguri** (stoc mic, stoc limitat, tampon): în unitatea variantei, cu valoare implicită luată din unitate (ex. buc 2, m 10) și
  suprascriere pe variantă. Alertele compară cu pragul; „rest sub minim” apare ca avertisment separat.
- „Anunță-mă când revine”: revenirea înseamnă disponibil ≥ **cantitatea minimă**.
- Poza SmartBill cu mai multe zecimale decât unitatea → rotunjire în jos + avertisment (niciodată supravânzare).
- Teste de concurență cu zecimale (vezi (b)) și un test de arhitectură: nicio cantitate nu se manipulează ca `number` zecimal în afara modulului `Quantity`.

### (i) Impactul asupra punctelor și noua estimare

- **Punct nou „2. Unități de măsură și cantități”** (modulul `Quantity`, lista de unități cu pagina de administrare, validarea minim/pas),
  deci **13 puncte** în loc de 12 (păstrez fiecare punct mic). Alternativa: îl comasez în punctul 1 (punct mare, mai greu de verificat).
- Se schimbă: **1** (schema), **3** (stările: „rest sub minim”), **4** (rezervare cu zecimale + teste), **5** (ajustări cu precizie),
  **7** (admin stoc: unități), **8** (editor: unitate/minim/pas + import/export), **9** (praguri în unitate), **11** (importul „stoc la zi”).
- **Estimare: de la 6–8 zile la 8–10 zile** de lucru efectiv (+1,5–2 zile: modulul `Quantity`, lista de unități, validarea și testele
  numerice).

### Ce rămâne de decis de tine la D11

1. Alegerile: **(a) A / B / C · (b) B1 / B2 · (c) minim și pas pe variantă (da / pe produs) · (e) regula „un SKU = un produs SmartBill”
   (da / nu)** · comasarea punctului 2 în 1 (da / nu).
2. **Lista inițială de unități**, cu precizia fiecăreia și numele din SmartBill (propunerea mea: buc, rolă, set, cutie, pachet = 0; m, mp = 2;
   kg, l = 3).
3. **Cele 5–10 exemple reale de produse** (tabelul de mai jos), ca să validăm schema.
4. **Contabil/SmartBill:** rotunjire pe linie sau pe total, zecimalele cantității, numele unităților, rotunjirea documentelor.
5. Prețuri cu mai mult de 2 zecimale pe unitate: există? Produse preambalate la greutate/volum: avem nevoie de „preț pe unitate de referință”?

**Tabel pentru exemplele tale** (completează 5–10 rânduri; câteva sunt scrise cu titlu de model, înlocuiește-le cu produse reale):

| Produs real | SKU / cod SmartBill | Unitate | Precizie | Minim | Pas | Preț pe unitate (cu TVA) | Se vinde și ca ambalaj? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| *(model)* Furtun piscină | | m | 2 | 1 | 0,5 | 12,50 | rolă 25 m |
| *(model)* Folie liner | | mp | 2 | 1 | 0,5 | | |
| *(model)* Clor granule | | kg | 3 | 1 | 1 | | |
| *(model)* Soluție pH | | l | 3 | 1 | 1 | | |
| *(model)* Pompă | | buc | 0 | 1 | 1 | | |

## Parametri rămași din D1 și D6 (aprobate; doar cifrele)

| Parametru | Propunere | Tu |
| --- | --- | --- |
| Fereastra de siguranță în jurul orei pozei (D1) | 30 de minute | ___ |
| Tampon de siguranță implicit pentru stoc mic (D1) | 0 sau 1 unitate (în unitatea variantei) | ___ |
| Frecvența sincronizării până la API (D1) | zilnică, la o oră fixă; cine o face | ___ |
| Avertisment „poza e veche” după (D1) | 24 de ore | ___ |
| Termen global implicit „La comandă” (D6) | 14 zile | ___ |
| Prag „Stoc limitat” afișat clientului (D6) | același cu „stoc mic” | ___ |
| Ramburs interzis dacă în coș e un produs „La comandă” (D6; se decide în Faza 9) | da | ___ |
| Cele 4 întrebări către contabil (D1) și 2 (D6: momentul facturii, ramburs) + rotunjirea (D11) | — | ___ |

## Alte decizii mai puțin urgente

| # | Ce | Recomandare | Când trebuie |
| --- | --- | --- | --- |
| **D7** | **Praguri.** „Stoc mic” (intern) și „Stoc limitat” (afișat) | Aceeași valoare implicită **pe unitate** (buc 2, m 10 etc.), suprascriere pe variantă. *Valori reale?* | Înainte de punctul 9 |
| **D8** | **Istoric și motive de ajustare.** Istoric permanent, imuabil; motive fixe + text liber obligatoriu | *Vânzare în magazin · Recepție marfă · Retur · Inventariere (corecție) · Deteriorat · Pierdut/Furt · Alt motiv* | Înainte de punctul 5 |
| **D9** | **Variante.** Stoc pe variantă; la produsul cu variante, lista arată suma (doar dacă variantele au aceeași unitate; altfel nu se însumează); bifa se poate coborî pe variantă; coș cu variante gestionate + negestionate; produsele digitale nu au stoc | Confirm | Înainte de punctul 3 |
| **D10** | **Cine ajustează stocul.** `inventory.write`: Owner, Admin, Manager, Depozit; `inventory.read` la fel | Rămâne așa (Contabilul nu vede stocul acum) | Înainte de punctul 7 |
| **D12** | **„Anunță-mă când revine”.** O trimitere, apoi ștergerea adresei (sau după 90 de zile); formularul în Faza 7; textul GDPR în Faza 18 | Confirm | Înainte de punctul 10 |
| **D13** | **Retururi.** Pe produsele cu SmartBill, **stornoul din SmartBill returnează stocul**; local nu se adaugă manual | Se detaliază în Faza 14 | Faza 14 |

---

# 3. Ce îmi trebuie de la tine

**Înainte de punctul 1 (schema):**
1. Alegerile **D11** (casetele de mai sus) și lista inițială de unități cu precizie.
2. **5–10 exemple reale de produse** (tabelul din D11): unitate, minim, pas, preț pe unitate.
3. **Lista unităților de măsură din SmartBill** (export sau captură) și cum le numești în facturi.
4. **Răspunsurile contabilului:** cele 4 întrebări din D1, cele 2 din D6 și cele despre **rotunjire / zecimalele cantității** din D11.
5. Parametrii din tabelul „Parametri rămași” (pot fi aproximativi, se pot schimba din setări).

**Înainte de punctul 11 (importul „stoc la zi”) — de preferat mai devreme, ca să verificăm potrivirea SKU:**
6. Un **export SmartBill de tip „stoc la zi”** (formatul tău real, cu toate coloanele, chiar și 20–30 de rânduri; cu cantități zecimale dacă
   există). Fișierul real nu intră în repo, teste sau loguri, ca și `local-data/`.
7. Confirmarea că **SKU-ul din magazin = codul de produs din SmartBill** (sau lista excepțiilor). `_smartbill_sku` din WooCommerce e gol.
8. Cine și la ce oră face sincronizarea zilnică până apare API-ul.

**Înainte de punctul 9:** pragurile (D7). **Înainte de punctul 5:** motivele (D8). **Mai târziu (Faza 13/15):** documentația API SmartBill
(gestiune la factură, unități, rotunjire), citită înainte de implementare, cum cere `CLAUDE.md`.

---

# 4. Împărțirea în puncte (13, cu punctul nou 2)

Estimare nouă: **8–10 zile** de lucru efectiv (față de ~3 în planul inițial și 6–8 în a doua versiune), cu pauzele tale de confirmare.
Fiecare punct: 🟢 ÎNCEP, teste care pică întâi, commit separat, ✅ GATA cu „👉 VERIFICĂ TU”. Concurența intră din punctele 3–4.

| # | Punct | Ce rezultă | 👉 Cum verifici tu (scurt) |
| --- | --- | --- | --- |
| 1 | **Schema și migrația** (singura migrație a fazei): `MeasureUnit` (unități), pe variantă `measureUnitId`, `quantityMin`, `quantityStep` (în miimi); `Warehouse` („Depozit principal”, redenumibil, creat de seed); `InventoryItem` (cantitate **fizică** + „valabilă la”, **angajat**, **rezervat**, prag; toate în **miimi, întregi**); `StockSnapshot`; `StockMovement` (imuabil, ora efectivă, motiv, referință); `StockReservation` (activă → angajată → oglindită / eliberată / expirată; ora facturii); `BackInStockAlert`; `Product.leadTimeDays`, `Brand.defaultLeadTimeDays`; CHECK-uri (`≥ 0`, unic per variantă+depozit, `IS NULL` explicit + test „una setată, una nulă”); setările `inventory.*` (modul sursă fizică `app`/`smartbill`, 15 min, 3 zile lucrătoare, fereastră de siguranță, avertisment poză veche, tampon, termen global, prag stoc limitat) | Tabele goale, depozit și unități de bază | Prisma Studio: tabelele noi, „Depozit principal”, lista de unități; un rând din `StockMovement` nu se poate modifica |
| 2 | **NOU — Unități de măsură și cantități:** modulul `Quantity` în `packages/shared` (citire/formatare/validare după precizie, fără `number` zecimal), pagina **„Unități de măsură”** în admin (listă, creare, editare, dezactivare, nume SmartBill, precizie), validarea minim/pas (`validateOrderQuantity`), mesaje în română, testul de arhitectură „nicio cantitate ca număr zecimal în afara modulului” | Unitățile funcționează izolat | Browser: creezi „m” cu 2 zecimale; încerci precizie 4 → refuzat; unitate folosită nu se șterge, doar se dezactivează |
| 3 | **Disponibilitatea și stările** (modul pur): o funcție care întoarce starea vizibilă pe **trei ramuri explicite** — (i) negestionat (doar `stockStatus`), (ii) „La comandă” (comandabil, fără stoc/rezervare, termen produs → brand → global), (iii) gestionat (**Fizică − Angajat − Rezervat**, **cea mai mare cantitate validă** ≤ disponibil, „rest sub minim”, hibrid). Digitalele mereu disponibile. Teste pe tabel de stări, cu cantități zecimale | Logica pură, testată | Script de probă (`npm.cmd run dev:stock-probe -- <SKU>`): starea vizibilă și termenul pentru 4 produse alese de tine |
| 4 | **Rezervare / eliberare / angajare / oglindire** cu cantități zecimale: o singură comandă condiționată + blocare de rând + CHECK; idempotente; expirare și la citire; linii în ordine fixă; regula D1 (angajat vs oglindit, cu fereastra de siguranță); modul `app`. **Teste pe Postgres real:** 10 cereri/stoc 1; 100/stoc 10; **10 × 0,3 pe 1,0 → exact 3**; webhook dublu; confirmare vs. expirare; coș cu linii gestionate + negestionate + „la comandă”; **cursa poză vs. factură** | Serviciul de bază | Script de probă: rezervi ultima bucată din două terminale deodată → una reușește |
| 5 | **Ajustări cu ora efectivă** (precizia unității, motivele D8, „Vânzare în magazin”, refuz sub 0, regula „poza înlocuiește ajustările dinainte, rămân cele de după”) | Operațiile de depozit | Probă în script, apoi în admin (punctul 7) |
| 6 | **Joburi:** eliberarea rezervărilor expirate; transfer bancar cu expirare în zile lucrătoare; verificarea „poza e prea veche”; curățarea vechilor `BackInStockAlert` | Eliberare automată + alertă | Rezervare de probă cu expirare 1 minut → disponibilitatea revine singură |
| 7 | **Admin `/admin/stoc`:** pe variantă — **Fizică (valabilă la …) · Angajat · Rezervat · Disponibil**, **cu unitatea lângă cantitate**, bannerul „stoc verificat la …”, „Ajustează” cu motiv și oră efectivă, istoric pe variantă, drepturi `inventory.*`, audit, dialoguri proprii în română | Ecranul principal | Browser: ajustezi 2,5 m cu motiv „Vânzare în magazin”, vezi „128,5 m”, rândul din istoric; Depozit poate, Editor/Suport nu |
| 8 | **Tabul Stoc din produs, brand, listă; import/export de produse:** selector de stare la negestionate, bifa „Gestionează stocul”, hibridul, **unitate / minim / pas** pe variantă, „Termen de livrare (zile)” pe produs și „Termen implicit” pe brand, coloana „Stoc” cu starea/cantitatea și unitatea; **coloane noi în import/export:** Unitate de măsură, Cantitate minimă, Pas, Stare stoc, Termen livrare | Editorul integrat | Browser: setezi „Furtun” în m, minim 1, pas 0,5; „La comandă (10 zile)” la altul; exporți în Excel: coloanele noi apar separate |
| 9 | **Alerte:** stoc mic (prag în unitate, implicit din unitate, suprascriere pe variantă), lista „Stoc mic”, avertisment „rest sub minim”, contor în panou, „poza SmartBill e veche” | Avertizări | Browser: cobori o cantitate sub prag → listă + contor; mutăm ora pozei înapoi → avertisment |
| 10 | **„Anunță-mă când revine”** (server): cerere, trimitere o singură dată (disponibil ≥ minim), ștergerea adresei | Partea de server | Probă: cerere de test, adaugi stoc → un singur email în Mailpit |
| 11 | **Import „stoc la zi” din SmartBill:** șablon, câmpul „valabil la”, separator zecimal explicit, verificare fără modificări cu raportul (necunoscute în ambele sensuri, **unitate diferită**, negative, rotunjiri, diferențe), aplicare toată-sau-deloc, istoricul pozelor, audit; CSV doar prin funcția comună (BOM + `sep=;`); `FileInput`; regula D2 în importul WooCommerce (negestionat, „în stoc”, „buc”; eticheta de unitate dacă există) | Încărcarea cantităților | Browser + Excel: încarci exportul tău real, vezi raportul (zero necunoscute la produsele active), aplici; a doua rulare = „neschimbate” |
| 12 | **Multi-depozit în spatele comutatorului:** CRUD depozite, selector, transfer; oprit = invizibil | Pregătire pentru creștere | Browser: oprit → nu apare; pornit (Prisma Studio) → apare și transferul funcționează |
| 13 | **Închiderea fazei:** E2E, test de concurență final în suită, acoperirea față de cerințe, `docs/FAZA-5-verificare-manuala.md`, **lista „înainte de lansare”** (Anexa A, D1.5) în TODO (Faza 13, 15, 22), PROGRESS, TODO, `docs/04`/`docs/15` | 🏁 | Ghidul tău de ~1 oră |

**Adăugiri propuse în TODO pentru fazele următoare** (le fac la punctul 13, cu aprobarea ta): **Faza 8** — motorul de prețuri primește
cantitate zecimală (miimi), cu o singură rotunjire pe linie; **Faza 9** — termen și stare în coș/plată, cantitate minimă/pas la
adăugare și plasare, ramburs la „la comandă”, coșuri mixte; **Faza 12** — greutatea liniei = greutate pe unitate × cantitate; **Faza 13** —
ora facturii pe comandă (`settle`), unitățile și rotunjirea SmartBill, 20 de cazuri numerice, lista „comenzi fără factură”; **Faza 15** —
poza prin API în locul fișierului; **Faza 22** — testul de realitate din D1.5.

---

# 5. Riscuri

| Risc | Ce se poate întâmpla | Măsura |
| --- | --- | --- |
| **Două comenzi pentru ultima bucată / ultimii metri** | Se vinde de două ori | O singură comandă SQL condiționată + CHECK; teste cu 10 și 100 de cereri, inclusiv cu zecimale, **la punctul 4** |
| **Rotunjiri cu zecimale** | 0,1 + 0,2 ≠ 0,3; stoc „puțin negativ” | Numere întregi în miimi (nu float); modul `Quantity` unic; test de arhitectură |
| **Precizie greșită după unitate** (0,001 m cu precizie 2) | Cantități imposibil de livrat | Validare în serviciu + mesaj; import rotunjește în jos cu avertisment |
| **Total încasat ≠ total factură SmartBill** (diferență de 1 ban) | Factură care nu corespunde plății | Întrebări către contabil; 20 de cazuri numerice în Faza 13; regula unică de rotunjire pe linie |
| **Unitate diferită între magazin și SmartBill** | Cantități aplicate pe produs cu altă unitate | Verificarea unității la import; rândul nu se aplică; raport |
| **Rest sub minim** | Material care nu se mai poate vinde | Avertisment în admin; ajustare/inventariere |
| **Scădere dublă (online + SmartBill)** | Subvânzare temporară | Regula înainte/după poză (Anexa A), testată pe ore; fereastra de siguranță prudentă |
| **Poză veche / sincronizare uitată** | Supravânzare la produsele rare | Indicator „verificat la”, avertisment, tampon, procedură de supravânzare |
| **Ora pozei greșită** | Comenzi marcate oglindite prea devreme | Implicit ora fișierului; avertisment; fereastra de siguranță; autor și oră în istoric |
| **Cod SmartBill ≠ SKU** | Cantități neaplicate sau pe produs greșit | Raportul listează nepotrivirile; nu se aplică potriviri aproximative; coloană „Cod SmartBill” doar dacă e nevoie |
| **Cantitate negativă în SmartBill** | Conflict cu D5 | Se aplică 0, cu avertisment |
| **Confirmare vs. expirare simultane** | Stoc eliberat și vândut altcuiva, plată reușită | Stare explicită a rezervării, trecere o singură dată; expirare și la citire |
| **Webhook de plată dublu** | Angajare dublă | Operații idempotente |
| **Coș cu mai multe produse** | Blocaj reciproc (deadlock) | Blocare în ordine fixă; test cu comenzi încrucișate |
| **Produs „la comandă” cumpărat în cantitate foarte mare** | Furnizorul nu poate livra | Fără limită de cantitate (decizia ta), dar limită tehnică de siguranță pe linie (setabilă) |
| **Partea din stoc rămâne blocată** în coșuri mixte | Stoc nevândut săptămâni | Se vede în „angajat”; livrarea pe părți ulterior |
| **Comutarea bifei `manageStock`** | Pierdere/reapariție de cantități | OFF nu șterge; ON reia cu avertisment |
| **Greutatea liniei la cantități zecimale** | Transport calculat greșit | Notă pentru Faza 12 (greutate pe unitate × cantitate) |
| **Excel strică cantitățile zecimale în CSV** (`1.5` → dată) | Cantități greșite la import | Virgulă în CSV, XLSX recomandat, separator ales explicit, celule ambigue refuzate |
| **Istoricul crește** | Tabel mare | Index pe variantă + dată; paginat; nu se șterge |
| **Două evidențe (aplicație + SmartBill)** | Diferențe | SmartBill rămâne sursa; raport săptămânal de diferențe |
| **eMAG, mai târziu** | Stoc vândut și pe site, și pe eMAG | Aceeași funcție de disponibilitate, cu tampon (`docs/12`) |
| **Conexiuni la bază în sezon** (vârf 5–10×) | Cereri blocate | Operații scurte; teste de încărcare în Faza 20 |
| **Spam „stoc mic” / „a revenit”** | Emailuri repetate | O singură trimitere pe eveniment, marcată în bază |
| **GDPR la „Anunță-mă”** | Date personale păstrate | Doar emailul, o trimitere, ștergere; consimțământ în Faza 7/18 |

**Regulile de lucru pe care le respect și aici:** fără float, logica în `packages/core`, scrieri de admin cu audit, erori tipate cu cod
stabil, mesaje în română, fără widget-uri native, CSV doar prin funcția comună, teste care pică întâi, un commit per punct, verificare
completă citită înainte de commit, push doar cu secvența obișnuită, nimic la dev serverul tău fără să-ți spun.

---

# 6. Ce îți cer acum

1. **Aprobare** (sau corecturi) pe planul revizuit: cele **13 puncte** și estimarea **8–10 zile**.
2. **Alegerile D11** (a, b, c, e), comasarea punctului 2 (da / nu), **lista de unități** și **5–10 exemple reale**.
3. **Numele din SmartBill ale unităților**, răspunsurile contabilului (inclusiv rotunjirea) și, când poți, exportul „stoc la zi”.
4. Cifrele din „Parametri rămași” (pot fi aproximative).

După aprobare, urmează 🟢 ÎNCEP pe punctul 1. Până atunci nu se atinge niciun fișier de cod.

---

# Anexe (aprobate): D1 și D6, detalii de proiectare

## Anexa A — D1 (APROBAT: varianta A, „poză + angajat”): detalii de proiectare

### D1.0 Trei cuvinte, pe înțelesul tuturor

Exemplu: în SmartBill ai **5** bucăți dintr-o pompă. Un client comandă online **1** (plătește cu cardul), iar o persoană cumpără **1**
din magazinul fizic.

| Cuvânt | Ce înseamnă | În exemplu |
| --- | --- | --- |
| **Cantitate fizică** | Cât arată SmartBill că ai în gestiune. **Vine din SmartBill**, nu o inventăm noi. Aplicația păstrează „ultima poză” a ei și **data și ora la care e valabilă** | 5 (la ora pozei) |
| **Angajat** | Bucăți din **comenzi online confirmate, dar încă neoglindite** în cantitatea fizică, adică factura lor nu apare încă în „poza” din SmartBill. Rămân angajate până când poza următoare le conține | 1 (clientul online) |
| **Rezervat** | Bucăți ținute pentru o plată **în curs** (card: 15 minute; transfer bancar: 3 zile lucrătoare). Dacă plata nu vine, se eliberează | 0 (după plată devine „angajat”) |
| **Disponibil** | Ce poate cumpăra următorul client online. **Disponibil = Fizică − Angajat − Rezervat** (niciodată sub 0) | 5 − 1 − 0 = **4** |

Vânzarea din magazinul fizic **scade cantitatea fizică în SmartBill**, deci apare în aplicație abia la următoarea sincronizare.

### D1.1 Cum evităm scăderea dublă (ordinea evenimentelor)

Pericolul: comanda online este scăzută o dată de aplicație (ca „angajat”) și a doua oară de SmartBill (când se emite factura).
Regula de aur: **o bucată se scade o singură dată, din locul în care se află la momentul „pozei”**:

- Comandă confirmată, **factura încă nu e în poza SmartBill** → bucata este **angajată** în aplicație (scăzută o dată, local).
- Comandă a cărei factură **este deja în poza SmartBill** → bucata este deja scăzută în cantitatea fizică, deci **încetează să mai
  fie angajată** (altfel s-ar scădea a doua oară).
- Decizia pentru fiecare comandă se ia **comparând ora emiterii facturii cu ora „pozei”**: factură emisă **înainte** de poză →
  deja oglindită; **după** poză → încă angajată.

Cursa dintre sincronizare și scăderea locală, pe ore (exemplu, 1 bucată):

```
09:00  Poză SmartBill: fizică = 5                              disponibil = 5
10:00  Client online confirmă 1 buc.                           angajat = 1 → disponibil = 4
10:01  Se emite factura în SmartBill (SmartBill: 4)            (aplicația încă pe poza de la 09:00: corect, 5 − 1)
11:00  Vânzare în magazin, 1 buc. (SmartBill: 3)               (aplicația încă nu știe: disponibil rămâne 4 ← abatere)
12:00  Poză nouă: fizică = 3. Factura online (10:01) e înainte de 12:00
       → comanda încetează să fie angajată                     fizică = 3, angajat = 0 → disponibil = 3  ✔
       (fără regula „înainte/după poză” ar fi fost 3 − 1 = 2: scădere dublă)
```

Cazuri limită și ce facem:

| Situație | Ce se întâmplă | Efect | Măsură |
| --- | --- | --- | --- |
| **Factura se emite exact în jurul orei pozei** (diferențe de ceas, export doar cu data) | Nu știm sigur dacă poza o conține | Alegem varianta prudentă: bucata rămâne angajată o vreme („fereastră de siguranță”, setabilă, implicit 30 de minute) | Cel mult o **subvânzare** temporară (apare mai puțin stoc decât există), niciodată supravânzare; se corectează la poza următoare |
| **Factura online eșuează** (SmartBill nu răspunde) | Comanda rămâne confirmată, fără factură | Rămâne **angajată** → stocul nu e vândut a doua oară | Lista „comenzi confirmate fără factură de mai mult de X minute”, alertă (apare cu Faza 13) |
| **Sincronizarea întârzie** (nu s-a făcut poza de 2 zile) | Vânzările din magazin nu sunt cunoscute | Aplicația **supraestimează** disponibilul → risc de supravânzare la produsele rare | Eticheta „stoc verificat la …” în admin; avertisment după X ore (setabil); **tampon de siguranță** (D1.4); motivul „vânzare în magazin” (D1.3) |
| **Sincronizarea eșuează la mijloc** | Poza nouă nu se aplică | Rămâne poza veche, fără modificări parțiale (totul sau nimic) | Raport de eroare; se reia |
| **Anulare / retur după factură** | În SmartBill se face storno și bucata revine în stoc | Dacă poza următoare e după storno, vede deja bucata înapoi | Local nu adăugăm nimic (altfel s-ar număra dublu); eliberăm doar „angajatul” dacă comanda nu fusese încă oglindită |
| **Comandă facturată manual în SmartBill, în afara aplicației** | Aplicația nu află de factură | Rămâne angajată la nesfârșit (prudent) | Lista „angajat vechi” + marcare manuală „oglindit”; se rezolvă și când vine integrarea |

### D1.2 Alternativele pentru modelul de stoc (nu decid eu)

| Variantă | Cum funcționează | Avantaje | Dezavantaje / risc |
| --- | --- | --- | --- |
| **A. „Poză + angajat” (RECOMANDAT)** | SmartBill dă cantitatea fizică (poză periodică); aplicația scade doar comenzile online neoglindite; regula înainte/după poză din D1.1 | Se **autocorectează** la fiecare poză; nu stricăm nimic dacă o poză lipsește; același serviciu merge cu importul de fișier acum și cu API-ul SmartBill mai târziu | Depinde de ora exactă a facturii vs ora pozei (de aceea fereastra de siguranță); între poze nu vede vânzările din magazin |
| **B. „Aplicația scade local, SmartBill doar verifică”** | Aplicația ține propria cantitate și o scade la fiecare comandă; SmartBill se compară ocazional | Simplu de înțeles | Cantitatea se îndepărtează de realitate (vânzările din magazin nu o ating); la compararea cu SmartBill nu putem distinge „vânzare în magazin” de „scădere dublă” fără legătură pe document. **Nu recomand** |
| **C. „Facturile online nu scad stocul în SmartBill”** | Facturăm online fără gestiune și scădem stocul în alt fel (aviz, bon) | Elimină scăderea dublă din rădăcină | Schimbă modul în care lucrează contabilul; stocul din SmartBill nu mai e corect. **Doar dacă contabilul cere** |
| **D. „Citim stocul din SmartBill în timp real”** (după integrarea API) | La fiecare afișare/comandă întrebăm SmartBill | Fără abateri de timp | Depinde de disponibilitatea și limitele API-ului; nu permite rezervarea de 15 minute; încetinește vitrina. Posibil **mai târziu** ca sincronizare frecventă (la 5–15 minute), fără să schimbe modelul A |

**Recomandarea mea: varianta A** acum, iar în Faza 13/15, același mecanism alimentat de API (poză la câteva minute), nu din fișier.

### D1.3 Soluția de trecere pentru Faza 5 (înainte să existe integrarea SmartBill)

1. **Import „stoc la zi” din exportul SmartBill** (CSV/XLSX), ca măsură de trecere, cu **SKU-ul magazinului = codul de produs din
   SmartBill** (decizia ta). Șablon și mapare de coloane (cod produs, gestiune, cantitate); **câmp obligatoriu „valabil la (data și
   ora)”** (implicit ora generării fișierului, dacă exportul o conține; altfel o scrii tu).
2. **Raport înainte de aplicare** (fără modificări): rânduri potrivite pe SKU · cod din SmartBill care nu există în catalog · produs
   gestionat din catalog care lipsește din fișier (opțiune: „rămâne neschimbat” sau „setează 0”, implicit neschimbat) · cantități
   negative în SmartBill (se aplică 0, cu avertisment) · diferențe față de poza anterioară.
3. **Dacă unele coduri diferă** între catalog și SmartBill: opțiune de coloană „Cod SmartBill” pe variantă, doar pentru cele
   nepotrivite. *Recomand să nu o adăugăm decât dacă raportul arată nepotriviri.*
4. **Fișierul tău WooCommerce** nu poate confirma potrivirea (`_smartbill_sku` gol). Când ai un export SmartBill, comparăm cele
   8 SKU-uri din primul pas (verificare de 5 minute).
5. Poza se aplică **toată sau deloc**; fiecare poză se păstrează (data, utilizator, fișier, număr de rânduri) pentru istoric.
6. Regula D1.1 (angajat vs oglindit) se implementează în **modelul de date** din Faza 5, dar abia Faza 9 (comenzi) și Faza 13
   (facturi) o alimentează cu comenzi reale; în Faza 5 o testăm cu comenzi simulate.

### D1.4 Motivul de ajustare „Vânzare în magazin” (perioada fără sincronizare)

- Ajustare manuală cu motivul **„Vânzare în magazin”** (și „Recepție”, „Corecție”, „Deteriorat”, „Pierdut/Furt” etc.), cu **ora
  efectivă** (implicit acum).
- **Se păstrează doar cât timp poza din SmartBill e mai veche** decât ora efectivă: când vine o poză nouă, valoarea din SmartBill
  o **înlocuiește** (pentru că SmartBill conține deja vânzarea), iar ajustările cu ora **după** poză rămân aplicate. Astfel
  aceeași vânzare nu se scade de două ori.
- *Risc:* dacă notezi „vânzare în magazin” **după** o poză, dar vânzarea s-a făcut **înainte** de poză, se scade de două ori până la
  poza următoare (subvânzare temporară, nu supravânzare). De aceea câmpul „ora efectivă” se poate corecta.
- *Alternativa:* nu permitem ajustări locale pe produsele cu SmartBill (doar poza). Mai sigur, dar fără protecție între poze.
  **Recomand ajustările cu ora efectivă.**

### D1.5 Ce trebuie neapărat să existe înainte de lansare, ca stocul să nu se îndepărteze de realitate

1. **Sincronizare regulată:** minim **zilnică** (la o oră fixă) până apare integrarea API; ținta e la câteva minute. Cineva e
   responsabil de ea (tu / contabilul) și există o listă de verificare.
2. **Indicator de „prospețime”:** în admin se vede mereu „stoc verificat la …” și un avertisment roșu după X ore (setabil);
   la lansare, o alertă pe email/panou când poza e prea veche.
3. **SKU = cod SmartBill, 100% verificat** cu raportul de import (zero necunoscute la produsele active).
4. **Tampon de siguranță** pentru produsele cu stoc mic (setare, de exemplu 1 bucată ținută în rezervă): reduce riscul de
   supravânzare între poze. *De decis: valoarea implicită.*
5. **Procedură de supravânzare** (se va întâmpla cândva): contactezi clientul, oferi „la comandă” (D6) sau anulezi cu rambursare.
6. **Comenzile confirmate fără factură** se văd într-o listă (de la Faza 13), altfel rămân angajate la nesfârșit.
7. **Inventariere fizică** periodică (cel puțin la început de sezon, februarie) și un **raport săptămânal de diferențe** între
   aplicație și SmartBill.
8. **Retururile și anulările** se fac prin storno în SmartBill (nu se adaugă stoc local manual).
9. **Test de realitate înainte de lansare:** numărăm fizic 20 de produse și comparăm cu aplicația.

**Întrebări către contabil** (pentru D1): (1) există o singură gestiune pentru magazinul fizic și online, sau mai multe? (2)
factura emisă prin API poate fi legată de o anumită gestiune, ca să scadă din ea? (3) ce se întâmplă în SmartBill dacă stocul
ajunge negativ (permis/blocat)? (4) cum arată exportul „stoc la zi” (coloane, are ora generării?).


---

## Anexa B — D6 (APROBAT cum a fost recomandat): detalii de proiectare

### D6.1 Ce stări vede clientul și de unde vin

| Stare vizibilă | Când apare | Se poate cumpăra? | Cantitate / rezervare |
| --- | --- | --- | --- |
| **În stoc** | Produs gestionat cu disponibil peste pragul „stoc limitat”; sau produs negestionat setat „în stoc” | Da | Gestionat: rezervare la plată. Negestionat: fără |
| **Stoc limitat** | Produs gestionat cu disponibil între 1 și pragul „stoc limitat” (se poate afișa „mai sunt N”) | Da | Ca „În stoc” |
| **La comandă (termen X zile)** | Produsul e setat „La comandă”; sau (dacă alegi varianta hibrid) produsul gestionat a ajuns la 0 | Da, **fără limită de cantitate** | **Fără rezervare, fără stoc** |
| **Indisponibil** | Gestionat cu disponibil 0 (fără hibrid), sau negestionat setat „indisponibil” | Nu (+ „anunță-mă când revine”) | — |

Nu mai există o stare „precomandă” separată: „La comandă” o înlocuiește.

### D6.2 Termenul estimat: de unde se ia (alternative)

| Variantă | Cum | Avantaje | Dezavantaje |
| --- | --- | --- | --- |
| **A. Pe produs, cu valoare implicită din brand, apoi din setare globală (RECOMANDAT)** | Câmp „Termen de livrare (zile)” pe produs; dacă e gol, se ia „Termen implicit” al **brandului**; dacă și acela e gol, setarea globală | Simplu; majoritatea furnizorilor coincid cu un brand; fără tabel nou | Dacă același brand are furnizori diferiți, termenul se corectează pe produs |
| **B. Tabel de furnizori** | Entitate „Furnizor” cu termen, legată de produse | Cel mai exact, util la comenzi către furnizor | Construiește un modul nou (CRUD, import, legături); nu e necesar în Faza 5 |
| **C. Doar global** | Un termen pentru toate | Foarte simplu | Prea grosier |

*Recomand A* (furnizorul poate veni mai târziu fără să stricăm nimic). Un produs „La comandă” **nu poate fi activat** dacă termenul
nu rezultă nicăieri (mesaj în română).

### D6.3 Produsul gestionat care se epuizează: hibrid sau nu?

- **Hibrid (RECOMANDAT):** produs gestionat; cât are stoc se vinde din stoc; la 0 devine automat **„La comandă (X zile)”** dacă
  bifa „La epuizare, se poate comanda” (există deja în schemă ca `allowBackorder`) este pornită; altfel devine „Indisponibil”.
  *Avantaj:* nu comuți manual între stări. *Risc:* un client poate comanda ceva ce furnizorul nu mai are; de aceea bifa e **oprită
  implicit**, o pornești pe produsele cu aprovizionare sigură.
- **Fără hibrid:** „La comandă” doar pentru produse negestionate, comutate de tine. Mai puțin automat.

### D6.4 Coșuri mixte (din stoc + „la comandă”): consecințele livrării toată odată vs. pe părți

| Aspect | **Toată odată (recomandarea ta)** | **Pe părți (opțiune ulterioară)** |
| --- | --- | --- |
| **Termen afișat** | În coș și la plată: termenul cel mai lung dintre linii, cu produsul care îl cauzează („Livrare estimată în 14 zile — Pompa X e la comandă”); în emailul de confirmare la fel | Două termene (unul pe parte) |
| **Transport** | Calculat **o singură dată**, pe toate liniile fizice (greutate volumetrică sau reală, clase de livrare); un singur AWB | Două expedieri → două costuri; cine plătește a doua expediere? **Trebuie o regulă** (de obicei gratuită sau prag) |
| **Rezervarea părții din stoc** | Partea din stoc este **angajată** (sau rezervată 15 min până la plată) și **rămâne blocată** până la expediere, deci până la X zile pentru un client care așteaptă restul. Stocul real e vândut, deci nu se vinde a doua oară | Partea din stoc pleacă imediat; nu rămâne blocată |
| **Factura** | Un document pentru toată comanda; momentul emiterii (la plată / la expediere) îl confirmă contabilul (vezi întrebarea de mai jos) | Facturi parțiale sau una singură |
| **Retur / anulare** | Clientul poate anula înainte de expediere (rambursare integrală) | Mai multe cazuri (parte livrată, parte nu) |
| **Experiența clientului** | Așteaptă cel mai lent produs, dar primește o singură livrare | Primește repede ce există |
| **Complexitate** | Mică: `fulfillmentStatus` rămâne simplu | Mare: stare parțială, două AWB-uri, două costuri |

*Recomand: „toată odată” acum.* Modelul comenzii (care are deja `fulfillmentStatus` separat) **nu se blochează** pentru
livrarea pe părți mai târziu.

**Întrebări deschise legate de D6** (de decis până la Faza 9, nu blochează Faza 5):
1. **Ramburs la produse „la comandă”?** Riscul: clientul refuză un produs adus special de la furnizor. *Propun:* ramburs interzis
   (sau avans) dacă în coș există linii „la comandă”.
2. **Când se emite factura** pentru liniile „la comandă”: la plată (regula actuală pentru card) sau la expediere? **Întrebare pentru
   contabil.**
3. **Termenul legal de livrare:** în dreptul consumatorului, termenul general este de cel mult 30 de zile dacă nu s-a convenit
   altfel; **de confirmat cu avocatul** textele afișate la plată (termenul trebuie comunicat înainte de comandă).
4. **Dacă furnizorul nu mai poate livra** după comandă: anulare parțială cu rambursare/storno parțial (reguli deja stabilite pentru
   retur parțial).

