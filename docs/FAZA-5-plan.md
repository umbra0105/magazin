# Faza 5 (Stoc) — plan revizuit, pentru aprobare

**Stare:** doar planificare. Niciun cod, nicio migrație, nicio schimbare în baza de date. Nimic nu începe până nu aprobi
(sau nu corectezi) acest plan. Prima versiune: 2026-10-21; **revizuit pe 2026-10-21 după deciziile D2–D5 și faptele noi
despre SmartBill (D1) și „La comandă” (D6).**

Surse: `docs/06-todo-master.md` (Faza 5, 9, 13, 14, 15), `docs/04-backend-admin.md`, `docs/10-decizii-deschise.md`,
`docs/12-emag-marketplace.md`, `docs/15-specific-nisa-piscine.md`, `docs/09-preturi-si-parteneri.md`, regulile din
`CLAUDE.md`, starea reală din cod și fișierul tău WooCommerce din `local-data/`.

---

# 1. Decizii luate

| # | Decizie | Cine / când |
| --- | --- | --- |
| — | Gestiunea „ca în WooCommerce”: setare globală `inventory.manageStock` + bifă pe produs + bifă pe variantă (moștenește de la produs). `manageStock = false` → doar „în stoc / indisponibil / la comandă”, **ramură explicită în cod**, zero rezervări | specificație |
| — | Rezervarea începe la inițierea plății; **coșul nu rezervă nimic** | specificație + D4 |
| — | Modelul multi-depozit rămâne în bază; în interfață o singură locație | specificație + **D3** |
| — | La stoc 0: „indisponibil” + „anunță-mă când revine” | specificație |
| — | Test obligatoriu de concurență: 10 cereri deodată pe ultima bucată → una singură reușește | specificație |
| **D2** | Inventarul (SKU și cantitate) îl faci tu. **Până atunci produsele rămân „în stoc” fără cantitate (negestionate).** Importul WooCommerce le pune negestionate | tu |
| **D3** | O singură locație în interfață (magazinul fizic, magazinul online și depozitul sunt în același loc). Modelul multi-depozit rămâne în bază, comutatorul `multiWarehouse` oprit | tu |
| **D4** | Card: rezervare 15 minute. Ramburs: **scade imediat** la plasare. Transfer bancar: 3 zile lucrătoare, **setabil**. Coșul nu rezervă | tu |
| **D5** | **Fără stoc negativ**, garantat în baza de date. Diferențele se corectează printr-o ajustare cu motiv | tu |
| D1 (fapte) | Produsele au **gestiune activă în SmartBill**, iar **factura scade automat stocul** acolo. Se vinde și din magazinul fizic, facturat tot în SmartBill. **SmartBill este sursa cantității fizice**; magazinul online ține disponibilitatea pentru comenzile online și se aliniază periodic la SmartBill. Modelul exact: vezi **D1** mai jos | tu |
| D6 (fapt) | „La comandă” devine **stare reală** pe produs: comandat la furnizor după ce primim comanda, **termen estimat în zile**, fără limită de cantitate, fără rezervare. Stările vizibile: **În stoc / Stoc limitat / La comandă (termen X zile) / Indisponibil**. Pentru coșuri mixte, recomandarea ta este „livrare toată odată”. Detaliile: vezi **D6** mai jos | tu |

**Fapte din cod și din fișiere, relevante pentru D1/D6:**

- Azi toate produsele au `manageStock = true`, dar nu există nicio cantitate nicăieri. Importul WooCommerce ignoră stocul
  („stocul nu se importă (Faza 5)”).
- **Fișierul tău WooCommerce nu are cantități:** toate cele 8 produse au „În stoc?” = 1 și „Stoc” gol; „Precomenzile sunt
  permise?” = 0.
- **`Meta: _smartbill_sku` există în fișier, dar este GOL la toate cele 8 produse.** Deci **nu pot confirma din fișier** că
  SKU-ul din magazin este egal cu codul de produs din SmartBill. Cele 8 SKU-uri au forme diferite (numerice, alfanumerice, cu
  liniuță jos), ceea ce pare cod propriu, nu un cod generat de SmartBill. **Verificarea reală** se face cu un export SmartBill
  (vezi „Ce îmi trebuie”): raportul de import arată exact ce SKU-uri nu se potrivesc.
- Pe produs există deja: `manageStock`, `stockStatus` (`instock` / `outofstock` / `onbackorder`), `allowBackorder`,
  `expectedRestockDate`. Pe variantă: `manageStock` și `stockStatus` care suprascriu produsul. Pagina `/admin/stoc` e în meniu, dar
  goală. Permisiunile `inventory.read/write` există (Owner, Admin, Manager, Depozit).

---

# 2. Decizii rămase deschise pentru tine

## D1 — SmartBill este sursa cantității fizice: cum ținem și cum aliniem stocul

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

> **Decizia ta pe D1:** ☐ varianta A (recomandat) · ☐ B · ☐ C · ☐ D · ☐ alta. Plus: fereastra de siguranță (30 min?), tamponul
> implicit (0 / 1 buc.?), frecvența sincronizării până la API (zilnic?).

---

## D6 — „La comandă” ca stare reală pe produs

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

> **Decizia ta pe D6:** ☐ termen: varianta A (recomandat) / B / C · ☐ hibrid (da / nu) · ☐ coșuri mixte: toată odată (da) · ☐
> ramburs interzis la „la comandă” (da / nu) · valoarea implicită a termenului global (zile): ___ · prag „stoc limitat”: ___ buc.

---

## Alte decizii încă deschise (mai puțin urgente; renumerotate)

| # | Ce | Recomandare | Când trebuie |
| --- | --- | --- | --- |
| **D7** | **Praguri.** Prag „stoc mic” pentru alerte (intern) și prag „Stoc limitat” (afișat clientului) | Aceeași valoare implicită **2 bucăți**, suprascriere pe variantă. *Tu ce valori reale vrei?* | Înainte de punctul 8 |
| **D8** | **Istoric și motive de ajustare.** Istoric permanent, imuabil; motive fixe + text liber obligatoriu | *Vânzare în magazin · Recepție marfă · Retur · Inventariere (corecție) · Deteriorat · Pierdut/Furt · Alt motiv* (transferul doar cu multi-depozit) | Înainte de punctul 4 |
| **D9** | **Variante.** Stoc pe variantă; la produsul cu variante, lista arată suma; bifa se poate coborî pe variantă; coș cu variante gestionate + negestionate; produsele digitale nu au stoc | Confirm | Înainte de punctul 2 |
| **D10** | **Cine ajustează stocul.** `inventory.write`: Owner, Admin, Manager, Depozit; `inventory.read` la fel | Rămâne așa (Contabilul nu vede stocul acum) | Înainte de punctul 6 |
| **D11** | **Unități.** Doar bucăți întregi | Confirm (dacă vinzi vrac la metru/kg/litru, spune acum) | Înainte de punctul 1 |
| **D12** | **„Anunță-mă când revine”.** O trimitere, apoi ștergerea adresei (sau după 90 de zile); formularul vine în Faza 7; textul GDPR în Faza 18 | Confirm | Înainte de punctul 9 |
| **D13** | **Retururi.** Regula pe produsele cu SmartBill: **stornoul din SmartBill returnează stocul**; local nu se adaugă manual | Se detaliază în Faza 14 | Faza 14 |

---

# 3. Ce îmi trebuie de la tine

**Înainte de punctul 1 (schema):**
1. Deciziile **D1** și **D6** (casetele de mai sus), plus **D11** (unități).
2. **Numele locației/depozitului** care apare în aplicație (ex. „Depozit principal”).
3. **Răspunsurile contabilului** la cele 4 întrebări din D1 și la cele 2 din D6 (momentul facturii, ramburs).

**Înainte de punctul 10 (importul „stoc la zi”) — de preferat mai devreme, ca să verificăm potrivirea SKU:**
4. Un **export SmartBill de tip „stoc la zi”** (formatul pe care îl folosești, cu toate coloanele, chiar și 20–30 de rânduri).
   Fișierul real nu intră în repo, teste sau loguri, ca și `local-data/`.
5. Confirmarea că **SKU-ul din magazin = codul de produs din SmartBill** (sau lista excepțiilor).
6. Cine și la ce oră face sincronizarea zilnică până apare API-ul.

**Înainte de punctul 8:** pragurile (D7) și motivele (D8). **Mai târziu (Faza 13/15):** documentația API SmartBill (câmpurile de
gestiune la factură), citită înainte de implementare, cum cere `CLAUDE.md`.

---

# 4. Împărțirea în puncte (aceleași 12, ajustate)

Estimarea din plan e ~3 zile; cu D1/D6 și testele de concurență, realist **6–8 zile** de lucru efectiv, cu pauzele tale. Fiecare
punct: 🟢 ÎNCEP, teste care pică întâi, commit separat, ✅ GATA cu „👉 VERIFICĂ TU”. Concurența intră din punctele 2–3.

| # | Punct | Ce rezultă | 👉 Cum verifici tu (scurt) |
| --- | --- | --- | --- |
| 1 | **Schema și migrația** (singura migrație a fazei): `Warehouse` (depozitul implicit creat de seed), `InventoryItem` (cantitate **fizică** + data/ora „valabilă la”, **angajat**, **rezervat**, prag), `StockSnapshot` (fiecare poză: sursă, ora, fișier, utilizator, număr de rânduri), `StockMovement` (imuabil, cu **ora efectivă**, motiv, referință), `StockReservation` (stări: activă → confirmată/angajată → oglindită, sau eliberată/expirată; câmpuri pentru ora facturii), `BackInStockAlert`; pe produs `leadTimeDays` (termen implicit), pe brand `defaultLeadTimeDays`; CHECK-uri în bază (cantități ≥ 0, unic per variantă+depozit, comparații explicite cu `IS NULL`, test „una setată, una nulă”); setările `inventory.*` (modul sursă fizică: `app` / `smartbill`, minute rezervare = 15, zile lucrătoare transfer bancar = 3, fereastră de siguranță, ore până la avertismentul de poză veche, tampon, termen global, prag stoc limitat) | Tabele goale, depozit implicit | Prisma Studio: tabelele noi; încerci să modifici un rând din `StockMovement` → refuzat; coloanele noi pe produs/brand |
| 2 | **Disponibilitatea și stările** (modul pur, fără ecran): o singură funcție care întoarce **starea vizibilă** (În stoc / Stoc limitat / La comandă + termen / Indisponibil) pentru o variantă, pe **trei ramuri explicite**: (i) negestionat → doar lista `stockStatus`, zero atingere de inventar; (ii) „La comandă” → mereu comandabil, fără stoc, fără rezervare, termenul rezolvat produs → brand → global; (iii) gestionat → **Fizică − Angajat − Rezervat**, cu hibridul (D6.3). Digitalele mereu disponibile. Teste pe tabel de stări | Logica pură, testată | Script de probă (`npm.cmd run dev:stock-probe -- <SKU>`): pentru 4 produse alese de tine, afișează starea vizibilă și termenul |
| 3 | **Rezervare / eliberare / angajare / oglindire** (`reserve`, `release`, `commit`, `settle`): o singură comandă condiționată + blocare de rând + CHECK; idempotente; expirare și la citire; linii blocate în ordine fixă; regula D1.1 (angajat vs oglindit, cu fereastra de siguranță) și modul `app` (în care angajarea scade direct cantitatea). **Teste pe Postgres real:** 10 cereri/stoc 1; 100/stoc 10; webhook dublu; confirmare vs. expirare simultane; coș cu linii gestionate + negestionate + „la comandă”; **cursa poză vs. factură** (scenariile din D1.1, inclusiv „poza vine între confirmare și factură”) | Serviciul de bază | Script de probă: rezervi ultima bucată din două terminale simultan → una reușește, una „stoc insuficient” |
| 4 | **Ajustări cu ora efectivă** (`adjust`): motivele din D8 (inclusiv „Vânzare în magazin”), refuz sub 0, istoric; regula D1.4 (ajustarea cu ora după poză rămâne; cea dinainte e înlocuită de poză); invariant: cantitatea = poza + ajustările de după ea | Operațiile de depozit | Probă în script, apoi în admin (punctul 6) |
| 5 | **Joburi:** eliberarea rezervărilor expirate (la 5–10 min; corectitudinea nu depinde de job); transfer bancar cu expirare în zile lucrătoare; **verificarea „poza e prea veche”**; curățarea vechilor `BackInStockAlert` | Eliberare automată + alertă | Rezervare de probă cu expirare 1 minut → disponibilitatea revine singură |
| 6 | **Admin `/admin/stoc`:** pe variantă — **Fizică (valabilă la …) · Angajat · Rezervat · Disponibil**, bannerul „stoc verificat la …” (roșu dacă e prea vechi), căutare/filtre, „Ajustează” cu motiv și oră efectivă, istoricul pe variantă, drepturi `inventory.*`, audit pe orice scriere, dialoguri proprii în română | Ecranul principal | Browser: ajustezi cu motivul „Vânzare în magazin”, vezi cantitatea și rândul din istoric; Depozit poate, Editor/Suport nu |
| 7 | **Tabul Stoc din produs, brand și lista de produse:** selector de stare (În stoc / La comandă / Indisponibil) la negestionate, bifa „Gestionează stocul” (arată/ascunde cantitățile), bifa „La epuizare, se poate comanda” (hibrid), „Termen de livrare (zile)” pe produs și „Termen implicit” pe brand, mesaj dacă termenul lipsește; coloana „Stoc” din listă afișează starea vizibilă/cantitatea; câmpurile noi în export/import generic (Stare stoc, Termen livrare) | Editorul integrat | Browser: setezi un produs „La comandă (10 zile)” și un altul gestionat cu hibrid; vezi stările în listă; dezactivarea gestiunii **nu șterge** cantitățile |
| 8 | **Alerte:** stoc mic (prag implicit + pe variantă), lista „Stoc mic”, contor în panou, avertisment „poza SmartBill e veche” | Avertizări | Browser: cobori o cantitate sub prag → apare în listă și în contor; mutăm ora pozei înapoi → apare avertismentul |
| 9 | **„Anunță-mă când revine”** (server): cerere, trimitere o singură dată când disponibilul revine, ștergerea adresei | Partea de server | Probă: cerere de test, adaugi stoc → un singur email în Mailpit |
| 10 | **Import „stoc la zi” din SmartBill** (CSV/XLSX): șablon pe formatul exportului tău, câmpul „valabil la”, mapare, **verificare fără modificări** cu raportul din D1.3 (necunoscute în ambele sensuri, negative, diferențe), aplicare toată-sau-deloc, istoricul pozelor, audit; **CSV doar prin funcția comună (BOM + `sep=;`)**; `FileInput`; regula D2 în importul WooCommerce (negestionat + „în stoc”); gata să fie înlocuit de API (același serviciu `applySnapshot`) | Încărcarea cantităților | Browser + Excel: încarci exportul tău real, vezi raportul (zero necunoscute la produsele active), aplici; a doua rulare = „neschimbate” |
| 11 | **Multi-depozit în spatele comutatorului:** CRUD depozite, selector, transfer; cu comutatorul oprit nu se vede nimic din asta | Pregătire pentru creștere | Browser: oprit → nu apare; pornit (Prisma Studio) → apare și funcționează transferul |
| 12 | **Închiderea fazei:** E2E, test de concurență final în suită, acoperirea față de cerințe, `docs/FAZA-5-verificare-manuala.md`, **lista „înainte de lansare”** din D1.5 în TODO (Faza 13, 15, 22), PROGRESS, TODO, `docs/04`/`docs/15` | 🏁 | Ghidul tău de ~1 oră |

**Adăugiri propuse în TODO pentru fazele următoare** (le fac la punctul 12, cu aprobarea ta): **Faza 9** — afișarea termenului și a
stării în coș/plată, regula ramburs la „la comandă”, coșuri mixte; **Faza 13** — la emiterea facturii se notează ora ei pe comandă
(`settle`), citirea documentației API SmartBill despre gestiune, lista „comenzi fără factură”; **Faza 15** — înlocuirea importului
de fișier cu poza prin API; **Faza 22** — testul de realitate din D1.5.

---

# 5. Riscuri

| Risc | Ce se poate întâmpla | Măsura |
| --- | --- | --- |
| **Două comenzi pentru ultima bucată** | Se vinde de două ori | Rezervarea e **o singură comandă SQL condiționată** + CHECK; teste cu 10 și 100 de cereri deodată pe Postgres real, **la punctul 3** |
| **Scădere dublă (online + SmartBill)** | Disponibil prea mic (subvânzare) | Regula înainte/după poză (D1.1), testată pe scenariile cu ore; fereastra de siguranță alege varianta prudentă |
| **Poză veche / sincronizare uitată** | Supravânzare la produsele rare | Indicator „verificat la”, avertisment, tampon, procedură de supravânzare (D1.5) |
| **Ora pozei greșită** (introdusă manual) | Comenzi marcate oglindite prea devreme → supravânzare | Implicit ora fișierului; avertisment când ora introdusă e mult după fișier; fereastra de siguranță; ora și autorul rămân în istoric |
| **Cod SmartBill ≠ SKU** | Cantități neaplicate sau puse pe produs greșit | Raportul de import listează nepotrivirile în ambele sensuri; nimic nu se aplică pe baza unei potriviri aproximative; coloană „Cod SmartBill” doar dacă e nevoie |
| **Cantitate negativă în SmartBill** | Conflict cu regula D5 | Se aplică 0, cu avertisment în raport |
| **Confirmare vs. expirare simultane** | Stoc eliberat și vândut altcuiva, plată reușită | Stare explicită a rezervării, trecere o singură dată; expirare verificată și la citire; test dedicat |
| **Webhook de plată dublu** | Angajare dublă | Operații idempotente pe rezervare |
| **Coș cu mai multe produse** | Blocaj reciproc (deadlock) | Blocare mereu în aceeași ordine; test cu comenzi încrucișate |
| **Produs „la comandă” cumpărat în cantitate mare** | Furnizorul nu poate livra | Fără limită de cantitate (decizia ta), dar cu limită tehnică de siguranță pe linie (setabilă) și procedura D6 |
| **Partea din stoc rămâne blocată** în coșuri mixte | Stoc nevândut săptămâni | Se vede în „angajat”; opțiunea de livrare pe părți apare ulterior |
| **Comutarea bifei `manageStock`** ON→OFF→ON | Pierdere/reapariție de cantități | OFF nu șterge, ignoră; ON reia cu avertisment |
| **Toate produsele existente sunt „gestionate” fără cantități** | Ar apărea „epuizate” în vitrină | Regula D2: importul le pune negestionate; punct de verificare înainte de Faza 7 |
| **Istoricul crește** | Tabel mare | Index pe variantă + dată; paginat; nu se șterge; revizuire la Faza 20 |
| **Două evidențe (aplicație + SmartBill)** | Diferențe | SmartBill rămâne sursa; raport săptămânal de diferențe; aliniere la fiecare poză |
| **eMAG, mai târziu** | Stoc vândut și pe site, și pe eMAG | Aceeași funcție de disponibilitate, cu tampon (`docs/12`); în Faza 5 nu blocăm canalul |
| **Conexiuni la bază în sezon** (vârf 5–10×) | Cereri blocate | Operații scurte, o conexiune per operație; teste de încărcare în Faza 20 |
| **Spam „stoc mic” / „a revenit”** | Emailuri repetate | Trimitere o singură dată pe eveniment, marcată în bază |
| **GDPR la „Anunță-mă”** | Date personale păstrate | Doar emailul, o trimitere, ștergere; consimțământ în Faza 7/18 |

**Regulile de lucru pe care le respect și aici:** fără float (cantități întregi), logica în `packages/core`, scrieri de admin cu
audit, erori tipate cu cod stabil, mesaje în română, fără widget-uri native, CSV doar prin funcția comună, teste care pică
întâi, un commit per punct, verificare completă citită înainte de commit, push doar cu secvența obișnuită, nimic la dev serverul
tău fără să-ți spun.

---

# 6. Ce îți cer acum

1. **Aprobare** (sau corecturi) pe planul revizuit și pe cele 12 puncte.
2. **Deciziile D1 și D6** (casetele de decizie), plus **D11** (unități) și, dacă poți, D7–D13.
3. **Numele locației**, **răspunsurile contabilului** și, când poți, **exportul SmartBill „stoc la zi”**.

După aprobare, urmează 🟢 ÎNCEP pe punctul 1. Până atunci nu se atinge niciun fișier de cod.
