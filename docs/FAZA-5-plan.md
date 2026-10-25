# Faza 5 (Stoc) — plan revizuit, pentru aprobare

**Stare:** doar planificare. Niciun cod, nicio migrație, nicio schimbare în baza de date. Nimic din punctul 1 nu începe până nu
aprobi planul revizuit. Versiuni: prima 2026-10-21; a doua după D2–D5, D1 și D6; a treia: D1 și D6 APROBATE, iar D11 se schimbă (unități
de măsură și cantități zecimale); **a patra (2026-10-21): D11 completat cu cerințele tale (pas de vânzare, prețul afișat, 6 exemple
reale) — vezi secțiunea 2, D11.**

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
| **D1** | **APROBAT: varianta A, „poză + angajat”.** SmartBill este sursa cantității fizice; aplicația ține „angajatul” (comenzi online încă neoglindite) și „rezervatul”; **regula: o bucată se scade o singură dată** (factură înainte de poză → oglindită; după poză → încă angajată). Soluția de trecere în Faza 5: **importul „stoc la zi” din SmartBill (punctul 12)**. **Condițiile „înainte de lansare” rămân în plan** (Anexa A, D1.5). Integrarea reală cu SmartBill rămâne în **Faza 13/15** | tu |
| **D2** | Inventarul (SKU și cantitate) îl faci tu. Până atunci produsele rămân „în stoc” fără cantitate (**negestionate**); importul WooCommerce le pune așa | tu |
| **D3** | O singură locație în interfață, numită **„Depozit principal”** (**redenumibilă**); magazinul fizic, cel online și depozitul sunt în același loc. Modelul multi-depozit rămâne în bază, comutatorul `multiWarehouse` oprit | tu |
| **D4** | Card: rezervare **15 minute**. Ramburs: scade **imediat** la plasare. Transfer bancar: **3 zile lucrătoare, setabil**. Coșul nu rezervă | tu |
| **D5** | **Fără stoc negativ**, garantat în baza de date (și cu cantități zecimale: vezi D11) | tu |
| **D6** | **APROBAT cum a fost recomandat:** patru stări vizibile (În stoc / Stoc limitat / La comandă cu termen / Indisponibil); termen în zile **pe produs, cu implicit din brand, apoi din setarea globală**; **hibrid** (produsul gestionat devine „La comandă” la epuizare) cu `allowBackorder` **oprit implicit**; coșuri mixte: **livrare toată odată**, livrarea pe părți ca opțiune ulterioară. Detalii: Anexa B | tu |
| **D11** | **SCHIMBAT: NU doar bucăți întregi.** Se vând produse la **metri liniari, metri pătrați, kilograme, litri** etc.; **cantitățile pot fi zecimale.** | tu |
| **D11 (a)** | **La fiecare produs alegi la ce se referă prețul afișat** (per ml, mp, kg, litru, buc …) | tu |
| **D11 (b)** | **Pasul de vânzare** se setează **pe produs** și, unde există variante, **pe fiecare variantă** | tu |
| **D11 (c)** | **Cantitatea comandată este mereu un multiplu EXACT al pasului; minimul implicit este un pas** | tu |
| **D11 (exemple)** | Cele 6 produse reale (țeavă PVC-U, liner, bisulfat de sodiu, furtun de dozare, mozaic, lemn de abachi) sunt **cazuri de test** pentru schemă și pentru verificarea ta manuală. Configurația propusă pentru fiecare: secțiunea 2, D11.1 | tu |

## Ce am găsit în codul actual despre unitatea de măsură (verificat)

| Loc | Ce există | Concluzie |
| --- | --- | --- |
| **Produs / variantă** (`schema.prisma`) | **Nimic.** Niciun câmp, enum sau tabel de unități. Prețul, stocul (viitor) și SKU-ul sunt pe variantă, implicit „pe bucată” | De la zero |
| **Atribute tehnice** (`Attribute.unit`) | Text liber (ex. `mm`, `kW`, `m³/h`), doar la atributele numerice, afișat lângă valoare și în filtre | **Altceva** (specificație tehnică, nu unitate de vânzare). Nu se refolosește |
| **Greutate / dimensiuni** (`weightGrams`, `lengthMm` …) | Numere întregi în grame / milimetri, pe variantă (implicit pentru **o unitate vândută**) | La cantități zecimale, greutatea liniei = greutate pe unitate × cantitate (Faza 12) |
| **Import / export generic** | Fără coloană de unitate; fără minim/pas | Se adaugă (punctul 9) |
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

## D11 — Unități, pas de vânzare și cantități zecimale exacte

Aceasta înlocuiește versiunea anterioară a lui D11 și absorbe cerințele tale (a)–(c). Pentru fiecare întrebare: **alternative,
recomandare, consecințe.** Nimic de aici nu e decis până nu alegi.

### D11.1 Cum devin cele 6 exemple ale tale (configurația propusă)

Cuvintele: **unitate** = ce măsoară prețul și stocul (ml, mp, kg …); **pas** = cantitatea minimă vândută și unitatea de creștere (comanzi
1, 2, 3 … pași); **bază de preț** = ce tastezi în câmpul de preț: *pe unitate* (lei/ml) sau *pe pas* (lei/sac).

| # | Produs | Unitate | Pas | Minim | Baza prețului (propusă) | Se poate comanda | Cum arătăm prețul | Stocul în aplicație |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **Țeavă PVC-U** | ml | **2,5 ml** | 1 pas = 2,5 ml | pe unitate (lei/ml) | 2,5 · 5 · 7,5 · 10 … ml | „X lei/ml”; la selector „2,5 ml = Y lei” | în ml |
| 2 | **Liner placare** | mp | **41,25 mp** (rola) | 1 pas = 41,25 mp | pe unitate (lei/mp), cum îl spui tu | 41,25 · 82,5 · 123,75 … mp | „X lei/mp · Rola de 41,25 mp ≈ Y lei” | în mp (conversie dacă SmartBill ține role) |
| 3 | **Bisulfat de sodiu** | kg | **25 kg** (sacul) | 1 pas = 25 kg | **pe pas** (lei/sac) — vezi mai jos | 25 · 50 · 75 … kg (1, 2, 3 saci) | „Y lei / sac de 25 kg” și, mai mic, „(X lei/kg)” | în kg |
| 4 | **Furtun de dozare** | ml | **1 ml** | 1 ml | pe unitate (lei/ml) | 1 · 2 · 3 … ml | „X lei/ml” | în ml |
| 5 | **Mozaic placare** | mp | **2,03 mp** (cutia) | 1 pas = 2,03 mp | pe unitate (lei/mp) | 2,03 · 4,06 · **6,09** · 8,12 … mp | „X lei/mp · Cutia de 2,03 mp ≈ Y lei” | în mp |
| 6 | **Lemn de abachi (saună)** | ml | **pe variantă:** 1,5 / 1,8 / 2,1 / 2,6 ml | 1 pas al variantei | pe unitate (lei/ml) | multipli ai pasului variantei | „X lei/ml”; pe variantă „bucata de 1,8 ml = Y lei” | în ml; **o variantă = un produs SmartBill?** (de confirmat) |

**Bisulfat de sodiu — cum arătăm prețul și ținem stocul (propunerea mea):** prețul se **introduce pe sac** (baza „pe pas”: 120,00 lei/sac,
exact, fără rotunjiri), iar aplicația calculează și arată **și** prețul pe kg („4,80 lei/kg”), ca să se poată compara. Stocul se ține în **kg**
(exact, cu rest posibil dacă se desface un sac), iar dacă SmartBill îl ține în saci, conversia 1 sac = 25 kg se face automat (D11.5).
*Alternative:* (i) preț pe kg, sacul afișat „≈ Y lei” — mai bine dacă vinzi și vrac la kg; (ii) ambele ca două variante (nu recomand: două
stocuri pentru același material).

### D11.2 Aritmetică și stocare cu zecimale EXACTE

Toate cantitățile sunt **numere întregi** într-o unitate foarte mică; nu există `float` nicăieri în drum (nici în calcul, nici în JSON, nici în
Excel). Exemple de verificat: **3 × 2,03 = 6,09 exact**; 2 × 41,25 = 82,5; 7 × 2,5 = 17,5.

| Variantă | Cum | Avantaje | Dezavantaje |
| --- | --- | --- | --- |
| A. Întreg în miimi (3 zecimale), `INT4` | 2,03 mp → 2030 | Simplu, același tip ca banii | Plafon ~2,1 milioane de unități; conversiile SmartBill (ex. 2,333 role × 41,25) pot depăși 3 zecimale |
| **B. Întreg în zecimi de miime (4 zecimale), `BIGINT` (RECOMANDAT)** | 2,03 mp → 20300; modul `Quantity` lucrează cu `bigint`; produsul preț × cantitate se face tot cu `bigint` (altfel depășește limita numerelor exacte din JavaScript: 1.000.000.000 bani × 100.000.000 = 10¹⁷) | „Suficiente zecimale” cu marjă pentru conversii; nicio depășire practică; exact | Un pic mai mult cod (`bigint` la graniță, șir în JSON); trebuie disciplină |
| C. `NUMERIC` + `Prisma.Decimal` | Zecimal exact în Postgres | Fără plafon | Bibliotecă zecimală în tot codul; riscul unei treceri accidentale prin `number` |
| D. `float` | — | — | **Exclus**: `0,1 + 0,2 ≠ 0,3` |

- **Maximum 4 zecimale** la pas, cantitate, stoc (un pas cu mai multe zecimale se refuză la configurare). Tu ai nevoie de 2 (41,25; 2,03) și 0–1 (25 kg; 2,5 ml); 4 dă marjă.
- **Garanția „fără stoc negativ”** rămâne: CHECK-uri `≥ 0` + rezervare dintr-o singură comandă SQL condiționată. Cu întregi exacte funcționează identic.
- **Teste obligatorii (numerice):** (1) multipli: pentru pași reali din lista ta și pași aleatori, `n × pas` este acceptat și `n × pas ± cea mai mică fracțiune` este
  refuzat; (2) comparație cu un calcul de referință cu fracții exacte; (3) **depășiri:** cantitate peste plafonul de stoc, linie peste `MAX_MONEY`, pas cu prea multe
  zecimale, cantitate zero sau negativă → erori tipate, nu rezultate ciudate; (4) rezervări concurente cu zecimale (10 × 0,3 pe 1,0 → exact 3, rămâne exact 0,1); (5) un test
  de arhitectură: nicio cantitate nu se manipulează ca `number` zecimal în afara modulului `Quantity`.

### D11.3 Disponibilitate în pași, restul și legătura cu rezervarea, angajatul și alertele

- **Disponibil în unitate** = Fizică − Angajat − Rezervat (ca până acum). **Disponibil în pași** = `parte întreagă (disponibil ÷ pas)`.
  Exemplu: liner, stoc 100 mp, pas 41,25 → **2 pași = 82,5 mp se pot comanda; rest 17,5 mp**.
- **Ce afișăm clientului pentru rest:** *nimic* — arătăm „În stoc” sau „Stoc limitat — mai sunt 2 role”, iar selectorul nu permite mai mult de 2. Restul **nu** se vede și nu se
  poate comanda (altfel cantitatea nu ar mai fi multiplu de pas).
- **Ce vezi tu în admin:** „Disponibil: 100 mp = 2 pași · **rest nevandabil 17,5 mp**”. Dacă restul e tot ce a mai rămas (0 pași), produsul devine „Indisponibil” (sau „La comandă”
  cu hibridul) și apare un avertisment „rest nevandabil”.
- *Alternativă (nu recomand acum):* o bifă „vinde și restul” care permite o singură vânzare a restului, ca excepție de la pas. Utilă la țeavă sau lemn, dar încalcă regula ta
  (c) și complică factura. Restul se rezolvă prin ajustare/inventariere.
- **Rezervarea și angajatul** lucrează **numai în multipli de pas** (o comandă online are mereu n × pas), deci și rezervările/angajatele sunt multipli de pas. Restul apare doar din stocul
  fizic (SmartBill, ajustări).
- **Pragurile** („stoc mic” intern, „stoc limitat” afișat) se exprimă **în pași** (implicit 2 pași), cu suprascriere pe variantă. La produse cu pasul 1 buc asta înseamnă 2 bucăți, ca
  înainte; la liner înseamnă 2 role, nu „10 mp” (care ar fi mai mic decât o rolă). *Alternativa:* prag în unitate (m, mp) — dă praguri fără sens când pasul e mare.
- „Anunță-mă când revine” = disponibil în pași ≥ minim (≥ 1 pas).

### D11.4 Afișarea prețului și a cantității

- **Prețul de referință** (alegerea ta (a)) este întotdeauna vizibil: „X lei / ml”, „X lei / mp”, „X lei / kg”, „X lei / l”, „X lei / buc”.
- **Prețul unui pas** (opțional, o bifă pe produs): „Rola de 41,25 mp = Y lei”, „Sacul de 25 kg = 120,00 lei”. Când baza prețului e „pe unitate” și pasul nu iese rotund în bani,
  se afișează cu **„≈”**, iar **totalul comenzii e cel din coș (calculat din prețul pe unitate × cantitate)**, nu un multiplu al lui „≈”.
- **Selectorul de cantitate** numără **pași**: „− 2 role +” și, lângă el, totalul exact: „82,5 mp”.
- Virgula zecimală și unitatea lângă cantitate peste tot („82,5 mp”, „2,5 ml”, „25 kg”); în editare, câmp text (nu `type="number"`), care primește virgulă sau punct și arată erori în română
  („Cantitatea trebuie să fie multiplu de 2,03 mp.”).

### D11.5 Rotunjirea liniei, TVA-ul inclus și factura SmartBill

Reguli care **nu se schimbă**: prețurile sunt brute (cu TVA), în bani; TVA-ul se extrage din brutul liniei; **o singură rotunjire pe linie**; totalul = suma liniilor.

| Variantă | Cum se calculează linia | Unde se potrivește | Consecințe |
| --- | --- | --- | --- |
| **R1. Baza „pe unitate” (RECOMANDAT pentru ml/mp/kg la liner, țeavă, furtun, mozaic, abachi)** | linia = rotunjire(preț pe unitate × cantitate totală), o singură dată. Ex.: 87,35 lei/mp × 82,5 mp = 7.206,375 → **7.206,38 lei** | Când prețul tău natural e „pe mp / pe ml” | Totalul poate diferi cu câțiva bani de „n × prețul unui pas afișat” (de aceea „≈”) |
| **R2. Baza „pe pas” (RECOMANDAT pentru sac, rolă, cutie cu preț pe bucată: bisulfat)** | linia = n × preț pe pas, **fără nicio rotunjire** | Când vinzi pe ambalaj | Exact; prețul pe unitate afișat e doar informativ („≈ 4,80 lei/kg”) |
| R3. Rotunjim întâi prețul pasului, apoi înmulțim | linia = n × rotunjire(preț pe unitate × pas) | Dacă vrei ca „n × prețul afișat” să fie mereu egal cu totalul | Se abate de la regula „o rotunjire pe linie” și de la prețul pe unitate; ai nevoie de acordul contabilului |

**Factura SmartBill — ce trebuie confirmat cu contabilul / în documentația API (Faza 13), nu presupun nimic:**
1. SmartBill rotunjește **pe linie** sau **pe total**? Pe ce bază (net × cantitate sau brut)? Dacă diferă de R1/R2, factura poate ieși cu **1 ban** diferit de suma încasată.
2. Câte **zecimale** acceptă **cantitatea** (2? 3? 4?) și **prețul unitar**.
3. La baza „pe pas” trimitem **cantitatea în pași** (ex. 2 saci) cu unitatea „sac”; la baza „pe unitate” trimitem cantitatea în unitate (ex. 82,5 mp). Acceptă contul tău ambele?
4. Cum e configurată rotunjirea documentelor în contul tău.
- **Plan:** o suită de **20 de cazuri numerice** (inclusiv cele 6 produse ale tale) comparată cu SmartBill în Faza 13, înainte de a emite o factură reală.

### D11.6 În ce unitate ținem stocul, față de SmartBill (conversie fără pierderi)

| Variantă | Cum | Avantaje | Dezavantaje |
| --- | --- | --- | --- |
| **S1. Stocul în unitatea de preț (ml/mp/kg), cu conversie configurabilă din SmartBill (RECOMANDAT)** | Pe fiecare variantă: *„SmartBill ține stocul în: (1) aceeași unitate · (2) pași (1 bucată SmartBill = 1 pas) · (3) alt raport”* + numele unității din SmartBill. Conversia se face cu numere întregi, la importul „stoc la zi” (și în Faza 13 la factură, invers) | Exact; acoperă toate cazurile tale: liner în role = „pași”, abachi în bucăți = „pași”, bisulfat în saci = „pași”, țeavă în ml = „aceeași unitate” | Un câmp în plus; trebuie știut ce folosește SmartBill |
| S2. Stocul în pași (nr. de role/saci) | Contor întreg | Foarte simplu când nu se desfac niciodată ambalaje | Nu poate reprezenta restul (rolă începută, kg desfăcute); nu se potrivește dacă SmartBill ține în unitate |
| S3. Stocul exact în unitatea SmartBill (oricare ar fi) | Nicio conversie | Fără câmp suplimentar | Disponibilitatea în pași devine incertă; fiecare produs cu altă logică |

- **Conversie fără pierderi:** factorul are cel mult 4 zecimale (ex. 41,25) și toate calculele sunt întregi. Dacă o cantitate SmartBill produce prin conversie mai mult de 4 zecimale (ex. 2,3333 role × 41,25),
  se **rotunjește în jos** (nu creează stoc inexistent) și apare în raport. La configurare se verifică ca **orice comandă valabilă să se convertească exact** către SmartBill; altfel produsul nu se salvează cu acea
  setare.
- **Ce aduci tu:** din exportul SmartBill „stoc la zi” și din întrebările către contabil: în ce unitate ține SmartBill fiecare din cele 6 produse (ml/mp/kg sau buc/rolă/sac/cutie) și cu câte zecimale.
- Importul „stoc la zi” verifică **unitatea**: dacă cea din fișier nu corespunde setării variantei, rândul apare în raport și nu se aplică.

### D11.7 Variante cu pas diferit (abachi: 1,5 / 1,8 / 2,1 / 2,6 ml) — fără duplicări

| Variantă | Cum | Avantaje | Dezavantaje |
| --- | --- | --- | --- |
| **V1. Un produs, 4 variante, pasul pe variantă, moștenit din produs (RECOMANDAT)** | Produsul are unitatea (ml), baza de preț și, opțional, un pas implicit; **fiecare variantă poate avea pasul ei** (gol = moștenește de la produs). Același mecanism ca `manageStock`: produs → variantă. Pasul efectiv = variantă ?? produs ?? 1 unitate | Fără duplicare de produs, descriere, imagini, SEO; stoc și SKU pe variantă; ușor de înțeles | Câmpul „Pas” apare ca coloană în tabelul de variante |
| V2. Patru produse separate | Fiecare cu pasul lui | Foarte simplu tehnic | Duplicare masivă, patru pagini pentru un singur lemn |
| V3. Pasul din valoarea opțiunii (Lungime = 1,8 ⇒ pas 1,8) | Automat din generator | Comod | Cuplaj ascuns între opțiune și pas; greu de corectat; **nu acum** (poate ca scurtătură în generator, mai târziu) |

**Import din WooCommerce și din CSV (virgula zecimală românească, regulile din `CLAUDE.md`):**
- WooCommerce **nu are** unitate sau pas; toate produsele importate devin „buc”, pas 1. Pentru variabile (ca abachi), importul WooCommerce creează variantele; **pasul îl setezi apoi**,
  într-un al doilea import generic **pe SKU de variantă** (sau în admin). *Alternativă:* mapare opțională „atributul X devine pas” în profilul WooCommerce — o lăsăm pentru mai târziu, ca să nu complicăm importul.
- Importul generic primește coloane noi: **„Unitate de măsură”**, **„Baza prețului”** (unitate / pas), **„Pas de vânzare”**, **„Minim (pași)”**, **„SmartBill: stocul e ținut în”** (+ numele unității). Un rând = un SKU (variantă): se actualizează variante existente
  după SKU; un SKU nou creează un produs nou cu o singură variantă (regula actuală). Crearea unui produs cu 4 variante rămâne pe profilul WooCommerce sau pe generatorul din admin.
- **Zecimale:** virgula zecimală românească (`2,03`) și punctul (`2.03`) se acceptă; celulele ambigue (`1.234`) se refuză cu explicație; **CSV doar prin funcția comună** (BOM + `sep=;`, antet în română, deschis cu dublu-click în Excel cu coloanele separate).
  **Excel poate transforma `2.03` în dată** — în șablon și export, valorile se scriu cu **virgulă**, iar **XLSX** (celule text pentru coduri, numere pentru cantități) rămâne formatul recomandat.

### D11.8 Cantitate minimă

Implicit **1 pas**. Câmpul „Minim (pași)” e opțional (ex. minim 2 role la liner). Cantitatea minimă în unitate = minim × pas. Fără cantitate maximă acum (doar limită tehnică pe linie).

### D11.9 Impactul asupra punctelor și noua estimare

- Punctul „Unități de măsură și cantități” din versiunea anterioară se **împarte în două**: **2 = Cantități exacte** (modulul `Quantity`, aritmetica `bigint`, testele numerice) și **3 = Unități, pas și configurare**
  (lista de unități, pas/bază de preț/minim pe produs și variantă, validarea, conversia SmartBill). Rezultat: **14 puncte** (în loc de 13).
- Se schimbă: **1** (schema: câmpurile de mai sus, `BIGINT`), **4** (disponibil în pași, rest), **5** (rezervări în multipli de pas + teste), **8** (admin stoc: pași și rest), **9** (editor: unitate, bază de preț, pas pe produs și variantă, afișarea
  prețului pe unitate și pe pas; import/export), **10** (praguri în pași), **12** (importul „stoc la zi” cu conversie).
- **Estimare: de la 8–10 zile la 9–11 zile** de lucru efectiv (+1 zi: aritmetica `bigint` și testele numerice, conversia SmartBill, pasul pe variantă).
- **Motorul de prețuri (Faza 8)** nu se construiește acum; primitivele exacte (preț × cantitate cu `bigint`, multiplu de pas) stau în `packages/shared`, iar **regula de rotunjire o aplică motorul unic de prețuri**, ca să nu existe calcule duplicate.

### Ce rămâne de decis de tine la D11

1. **Stocarea** (D11.2): A / **B (recomandat)** / C.
2. **Baza prețului pe produs** (D11.1/D11.5): confirmi propunerile din tabel (sac = pe pas; restul = pe unitate)? Mai ales **liner** și **mozaic**: pe unitate (cum le spui) cu „≈” la pas, sau pe pas.
3. **Rotunjirea** (D11.5): R1 + R2 (recomandat) sau R3.
4. **Restul nevandabil** (D11.3): ascuns clientului și vizibil în admin (recomandat) sau bifa „vinde și restul”.
5. **Praguri în pași** (D11.3): da (recomandat) / în unitate.
6. **Stocul față de SmartBill** (D11.6): S1 cu conversie (recomandat); **pentru fiecare din cele 6 produse: în ce unitate îl ține SmartBill?** (îl aduci din export).
7. **Variante cu pas diferit** (D11.7): V1 (recomandat).
8. **Contabil / SmartBill** (D11.5): rotunjire pe linie sau pe total, zecimale la cantitate și preț, unitatea trimisă la facturare.
9. **Lista inițială de unități** (buc, rolă, set, cutie, pachet = 0 zecimale; ml, mp, kg, l …) cu **numele din SmartBill**, și confirmarea că unitățile din lista ta de produse reale sunt toate în listă (ml, mp, kg, sac?, rolă?, cutie?).
10. Mai ai **alte cazuri speciale** (produs vândut și la bucată, și la metru; preț cu volum; unitate de afișare diferită de cea de stoc)? Spune acum.

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
| **D7** | **Praguri.** „Stoc mic” (intern) și „Stoc limitat” (afișat) | Aceeași valoare implicită **în pași** (2 pași), suprascriere pe variantă. *Valori reale?* | Înainte de punctul 10 |
| **D8** | **Istoric și motive de ajustare.** Istoric permanent, imuabil; motive fixe + text liber obligatoriu | *Vânzare în magazin · Recepție marfă · Retur · Inventariere (corecție) · Deteriorat · Pierdut/Furt · Alt motiv* | Înainte de punctul 6 |
| **D9** | **Variante.** Stoc pe variantă; la produsul cu variante, lista arată suma (doar dacă variantele au aceeași unitate; altfel nu se însumează); bifa se poate coborî pe variantă; coș cu variante gestionate + negestionate; produsele digitale nu au stoc | Confirm | Înainte de punctul 4 |
| **D10** | **Cine ajustează stocul.** `inventory.write`: Owner, Admin, Manager, Depozit; `inventory.read` la fel | Rămâne așa (Contabilul nu vede stocul acum) | Înainte de punctul 8 |
| **D12** | **„Anunță-mă când revine”.** O trimitere, apoi ștergerea adresei (sau după 90 de zile); formularul în Faza 7; textul GDPR în Faza 18 | Confirm | Înainte de punctul 11 |
| **D13** | **Retururi.** Pe produsele cu SmartBill, **stornoul din SmartBill returnează stocul**; local nu se adaugă manual | Se detaliază în Faza 14 | Faza 14 |

---

# 3. Ce îmi trebuie de la tine

**Înainte de punctul 1 (schema):**
1. Alegerile **D11** (lista „Ce rămâne de decis”, punctele 1–10).
2. Pentru **fiecare din cele 6 produse**: unitatea în care îl ține **SmartBill**, cu câte zecimale, și numele unității în SmartBill (din exportul „stoc la zi” sau o captură).
3. **Lista unităților de măsură din SmartBill** și cum le numești în facturi.
4. **Răspunsurile contabilului:** cele 4 întrebări din D1, cele 2 din D6 (momentul facturii, ramburs) și cele 4 din D11.5 (rotunjire, zecimale, unitatea trimisă).
5. Parametrii din tabelul „Parametri rămași” (pot fi aproximativi, se pot schimba din setări).

**Înainte de punctul 12 (importul „stoc la zi”) — de preferat mai devreme, ca să verificăm potrivirea SKU și unitatea:**
6. Un **export SmartBill de tip „stoc la zi”** (formatul tău real, cu toate coloanele, chiar și 20–30 de rânduri; **cu cele 6 produse ale tale**, ca să vedem cum arată cantitățile).
   Fișierul real nu intră în repo, teste sau loguri, ca și `local-data/`.
7. Confirmarea că **SKU-ul din magazin = codul de produs din SmartBill** (sau lista excepțiilor). `_smartbill_sku` din WooCommerce e gol.
8. Cine și la ce oră face sincronizarea zilnică până apare API-ul.

**Înainte de punctul 10:** pragurile (D7, în pași). **Înainte de punctul 6:** motivele (D8). **Mai târziu (Faza 13/15):** documentația API SmartBill (gestiune la factură, unități, zecimale,
rotunjire), citită înainte de implementare, cum cere `CLAUDE.md`.

---

# 4. Împărțirea în puncte (14, cu punctele noi 2 și 3)

Estimare nouă: **9–11 zile** de lucru efectiv (față de ~3 în planul inițial; 6–8, apoi 8–10 în versiunile anterioare), cu pauzele tale de confirmare.
Fiecare punct: 🟢 ÎNCEP, teste care pică întâi, commit separat, ✅ GATA cu „👉 VERIFICĂ TU”. Concurența intră din punctele 4–5.

| # | Punct | Ce rezultă | 👉 Cum verifici tu (scurt) |
| --- | --- | --- | --- |
| 1 | **Schema și migrația** (singura migrație a fazei): `MeasureUnit`; pe **produs** `measureUnitId`, `priceBasis` (unitate / pas), `saleStep`, `minSteps`; pe **variantă** aceleași, nule = moștenește; pe variantă conversia SmartBill (mod: aceeași unitate / pași / raport + nume unitate); `Warehouse` („Depozit principal”, redenumibil, creat de seed); `InventoryItem` (fizic + „valabil la”, angajat, rezervat, prag în pași), `StockSnapshot`, `StockMovement` (imuabil, ora efectivă, motiv), `StockReservation`, `BackInStockAlert`; `Product.leadTimeDays`, `Brand.defaultLeadTimeDays`; **toate cantitățile `BIGINT` în zecimi de miime (4 zecimale)**; CHECK-uri (≥ 0, unic per variantă+depozit, `IS NULL` explicit + test „una setată, una nulă”); setările `inventory.*` | Tabele goale, depozit și unități de bază | Prisma Studio: tabelele noi, „Depozit principal”, lista de unități; un rând din `StockMovement` nu se poate modifica |
| 2 | **NOU — Cantități exacte:** modulul `Quantity` în `packages/shared` (`bigint`, citire/formatare cu virgulă, **multiplu de pas**, **număr de pași**, adunare/scădere, plafoane), primitiva exactă **preț × cantitate** cu `bigint` (fără regula de rotunjire, care aparține motorului de prețuri), erori tipate; **teste numerice:** cele 6 produse ale tale (3 × 2,03 = 6,09; 2 × 41,25 = 82,5 …), multipli/nemultipli, comparație cu calcul de referință, depășiri; test de arhitectură „nicio cantitate ca număr zecimal” | Aritmetica sigură | Script de probă: tastezi o cantitate și un pas, vezi „valid / invalid” și numărul de pași |
| 3 | **NOU — Unități, pas și configurare:** pagina **„Unități de măsură”** (listă, creare, editare, dezactivare, nume SmartBill, zecimale); în editorul de produs: unitate, baza prețului, pas, minim; **pasul pe fiecare variantă** (coloană în tabel, moștenire din produs); validarea „orice comandă valabilă se convertește exact către SmartBill”; mesaje în română | Configurarea produselor | Browser: creezi cele 6 produse-model; la abachi pui pasul 1,5 / 1,8 / 2,1 / 2,6 pe variante; încerci pas cu 5 zecimale → refuzat |
| 4 | **Disponibilitatea și stările** (modul pur): starea vizibilă pe **trei ramuri explicite** — (i) negestionat, (ii) „La comandă” (termen produs → brand → global), (iii) gestionat: **Fizică − Angajat − Rezervat**, **disponibil în pași**, **rest nevandabil**, hibrid. Digitalele mereu disponibile. Teste pe tabel de stări (inclusiv „100 mp, pas 41,25 → 2 pași, rest 17,5”) | Logica pură, testată | Script de probă: starea vizibilă, pașii și restul pentru cele 6 produse |
| 5 | **Rezervare / eliberare / angajare / oglindire** în multipli de pas: o singură comandă condiționată + blocare de rând + CHECK; idempotente; expirare și la citire; linii în ordine fixă; regula D1 (angajat vs oglindit); modul `app`. **Teste pe Postgres real:** 10 cereri/stoc 1; 100/stoc 10; **10 × 0,3 pe 1,0 → exact 3**; **liner: 5 cereri de 1 pas pe stoc 100 mp → exact 2**; webhook dublu; confirmare vs. expirare; coș cu linii gestionate + negestionate + „la comandă”; cursa poză vs. factură | Serviciul de bază | Script de probă: rezervi ultimul pas din două terminale deodată → una reușește |
| 6 | **Ajustări cu ora efectivă** (precizia unității, pasul nu se aplică la ajustări fizice, motivele D8, „Vânzare în magazin”, refuz sub 0, regula „poza înlocuiește ajustările dinainte”) | Operațiile de depozit | Probă în script, apoi în admin (punctul 8) |
| 7 | **Joburi:** eliberarea rezervărilor expirate; transfer bancar cu expirare în zile lucrătoare; verificarea „poza e prea veche”; curățarea vechilor `BackInStockAlert` | Eliberare automată + alertă | Rezervare de probă cu expirare 1 minut → disponibilitatea revine singură |
| 8 | **Admin `/admin/produse/stoc` (tabul Stoc din Produse; până la 8b era `/admin/stoc`):** pe variantă — **Fizică (valabilă la …) · Angajat · Rezervat · Disponibil (în unitate și în pași) · Rest nevandabil**, unitatea lângă cantitate, bannerul „stoc verificat la …”, „Ajustează” cu motiv și oră efectivă, istoric, drepturi `inventory.*`, audit, dialoguri proprii în română | Ecranul principal | Browser: ajustezi cu motivul „Vânzare în magazin”, vezi „100 mp = 2 pași · rest 17,5 mp”; Depozit poate, Editor/Suport nu |
| 9 | **Tabul Stoc din produs, brand, listă; afișarea prețului; import/export de produse:** selector de stare la negestionate, bifa „Gestionează stocul”, hibridul, termen pe produs / implicit pe brand, **prețul pe unitate și, opțional, pe pas** (cu „≈” când e cazul), coloana „Stoc” cu starea/cantitatea și unitatea; **coloane noi în import/export:** Unitate de măsură, Baza prețului, Pas de vânzare, Minim (pași), conversia SmartBill, Stare stoc, Termen livrare (virgula zecimală, regulile CSV) | Editorul integrat | Browser: bisulfat „120,00 lei / sac de 25 kg (4,80 lei/kg)”; liner „X lei/mp · Rola de 41,25 mp ≈ Y lei”; export în Excel: coloanele noi apar separate |
| 10 | **Alerte:** stoc mic (prag **în pași**, implicit 2, suprascriere pe variantă), lista „Stoc mic”, avertisment „rest nevandabil”, contor în panou, „poza SmartBill e veche” | Avertizări | Browser: cobori sub prag → listă + contor; mutăm ora pozei înapoi → avertisment |
| 11 | **„Anunță-mă când revine”** (server): cerere, trimitere o singură dată (disponibil ≥ 1 pas), ștergerea adresei | Partea de server | Probă: cerere de test, adaugi stoc → un singur email în Mailpit |
| 12 | **Import „stoc la zi” din SmartBill:** șablon, „valabil la”, separator zecimal explicit, **conversie SmartBill → unitatea noastră** (rotunjire în jos + avertisment), verificare fără modificări cu raportul (necunoscute în ambele sensuri, **unitate diferită**, negative, rotunjiri, diferențe), aplicare toată-sau-deloc, istoricul pozelor, audit; CSV doar prin funcția comună; `FileInput`; regula D2 în importul WooCommerce (negestionat, „în stoc”, „buc”) | Încărcarea cantităților | Browser + Excel: încarci exportul tău real cu cele 6 produse; raportul arată conversiile; a doua rulare = „neschimbate” |
| 13 | **Multi-depozit în spatele comutatorului:** CRUD depozite, selector, transfer; oprit = invizibil | Pregătire pentru creștere | Browser: oprit → nu apare; pornit (Prisma Studio) → apare și transferul funcționează |
| 14 | **Închiderea fazei:** E2E, testul de concurență final în suită, acoperirea față de cerințe, `docs/FAZA-5-verificare-manuala.md` (cu **cele 6 produse ale tale ca scenarii**), **lista „înainte de lansare”** în TODO, PROGRESS, TODO, `docs/04`/`docs/15` | 🏁 | Ghidul tău de ~1–1,5 ore |

**Etapele punctului 9 (decis de utilizator):** (9b adaugă și: importurile creează produse negestionate, explicit; un fișier exportat cu un simbol de unitate ambiguu folosește codul unității) 9a = migrația `Product.saleStepLabel`, tabul «Stoc» din editor, «Denumirea pasului», termenul implicit pe brand și coloana «Stoc» din listă; 9b = afișarea prețului pe unitate și pe pas, coloana «Preț» din listă, previzualizarea din tabul Prețuri și coloanele noi de import/export.

**Navigarea (blocul 8b, decis de utilizator):** punctele 9–13 construiesc ecranele noi direct în structura cu taburi: meniul are o singură intrare «Produse», iar ecranele (inclusiv cele noi, ex. «Stoc mic» de la punctul 10 sau «Depozite» de la 13) sunt taburi sub `/admin/produse/…`, cu drepturile fiecărui ecran; convenția e în `CLAUDE.md` și `docs/04-backend-admin.md`.

**Cele 6 produse ale tale ca verificare manuală (punctele 3, 9, 12 și 14):** creezi fiecare cu configurația din D11.1 și verifici: cantitățile permise (ex. mozaic: 2,03 · 4,06 · 6,09), refuzul
unei cantități invalide cu mesaj în română, prețul afișat pe unitate și pe pas, disponibilitatea în pași și restul (liner 100 mp → 2 pași, rest 17,5 mp), abachi cu 4 pași diferiți.

**Adăugiri propuse în TODO pentru fazele următoare** (le fac la punctul 14, cu aprobarea ta): **Faza 8** — motorul de prețuri primește cantitatea ca `bigint`, aplică R1/R2 și o singură rotunjire pe linie; **Faza 9** — termen și stare în coș/plată,
selector în pași și validarea pasului la adăugare și plasare, ramburs la „la comandă”, coșuri mixte; **Faza 12** — greutatea liniei = greutate pe unitate × cantitate; **Faza 13** — ora facturii pe comandă (`settle`),
unitățile, zecimalele și rotunjirea SmartBill, cele 20 de cazuri numerice, lista „comenzi fără factură”; **Faza 15** — poza prin API în locul fișierului; **Faza 22** — testul de realitate din D1.5.

---

# 5. Riscuri

| Risc | Ce se poate întâmpla | Măsura |
| --- | --- | --- |
| **Două comenzi pentru ultima bucată / ultimii metri** | Se vinde de două ori | O singură comandă SQL condiționată + CHECK; teste cu 10 și 100 de cereri, inclusiv cu zecimale, **la punctul 5** |
| **Rotunjiri cu zecimale / pierdere de precizie** | 0,1 + 0,2 ≠ 0,3; 3 × 2,03 ≠ 6,09; depășirea numerelor exacte din JavaScript la preț × cantitate | Numere întregi `bigint` (zecimi de miime), modul `Quantity` unic, teste cu cele 6 produse și cu depășiri, test de arhitectură |
| **Cantitate care nu e multiplu de pas** (cerere manipulată, coș vechi) | Comandă imposibil de livrat | Validare la server la adăugare, modificare, plasare și rezervare; mesaj în română |
| **Rest nevandabil** (17,5 mp din 100 mp) | Material blocat, produs „epuizat” deși există | Rest vizibil în admin, avertisment, ajustare/inventariere; fără bifă „vinde restul” acum |
| **Conversie SmartBill cu pierderi** (role ↔ mp, bucăți ↔ ml) | Cantități puse greșit sau stoc inexistent | Factor cu cel mult 4 zecimale, calcule întregi, rotunjire în jos + avertisment, verificare la configurare că orice comandă valabilă se convertește exact |
| **Total încasat ≠ total factură SmartBill** (1 ban; mai ales la baza „pe unitate”) | Factură care nu corespunde plății | Baza „pe pas” (fără rotunjire) pentru ambalaje; întrebări către contabil; 20 de cazuri numerice în Faza 13 |
| **Prețul pasului afișat ≠ total** (cu „≈”) | Neînțelegere a clientului | „≈” și totalul calculat în coș; alternativa R3, cu acordul contabilului |
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

1. **Aprobare** (sau corecturi) pe planul revizuit: cele **14 puncte** și estimarea **9–11 zile**.
2. **Alegerile D11** (lista „Ce rămâne de decis”, punctele 1–10), în special: stocarea `BIGINT` cu 4 zecimale, baza prețului la liner/mozaic/bisulfat, rotunjirea R1+R2, restul nevandabil, pragurile în pași.
3. **Pentru cele 6 produse:** unitatea în care le ține SmartBill (din export) și numele unităților din SmartBill; răspunsurile contabilului (inclusiv rotunjirea și zecimalele).
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

