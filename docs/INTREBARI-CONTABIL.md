# Întrebări pentru contabil — stoc, unități de măsură, cantități zecimale și facturare

**Stare:** de trimis · **Întocmit:** 2026-10-21 · **Pentru:** contabilul magazinului (și, la întrebările despre SmartBill, persoana care administrează contul SmartBill)

Magazinul online vinde echipamente și materiale pentru piscine, cu TVA 21% inclus în prețul afișat. Facturile le emite SmartBill. Pregătim
partea de **stoc**, iar unele produse se vând la metri, metri pătrați, kilograme sau în ambalaje (rolă, sac, cutie), nu doar la bucată.
De răspunsurile de mai jos depinde cum calculăm totalurile și ce trimitem către SmartBill, ca **suma încasată de la client să fie
exact suma de pe factură**.

**Cum răspunzi:** scrie sub fiecare întrebare, în spațiul „Răspuns”. Dacă nu știi, scrie „nu știu” sau „verific cu SmartBill”; e un
răspuns bun. Unde apare un exemplu cu cifre, cifrele sunt inventate, doar ca să se înțeleagă întrebarea.

**Cuvinte folosite:** *gestiune* = locul în care SmartBill ține stocul (depozit, magazin) · *unitate de măsură* = „buc”, „ml”, „mp”, „kg” …
· *linie de factură* = un rând de pe factură (produs, cantitate, preț) · *preț brut* = prețul cu TVA inclus, cel afișat clientului.

---

## A. Stocul în SmartBill

Planul nostru: **SmartBill rămâne sursa stocului real** (el știe și vânzările din magazinul fizic). Magazinul online citește periodic stocul
din SmartBill, iar între două citiri scade din stocul disponibil doar comenzile online încă nefacturate.

**A1. Gestiunile.** Magazinul fizic, vânzările online și depozitul sunt într-o **singură gestiune** în SmartBill, sau sunt mai multe
gestiuni (de exemplu „Magazin” și „Depozit”)? Dacă sunt mai multe, cum se numesc?

Răspuns:

**A2. Factura din magazinul online scade stocul.** Când magazinul online emite automat o factură în SmartBill, poate fi legată de o
**anumită gestiune**, astfel încât produsele facturate să scadă din acea gestiune? (Dacă nu știi, la ce secțiune din SmartBill se verifică?)

Răspuns:

**A3. Stoc negativ.** Ce se întâmplă în SmartBill dacă se facturează un produs care are stoc 0 (sau mai puțin decât cantitatea
facturată): factura se emite și stocul devine negativ, sau SmartBill refuză factura? Se poate alege acest comportament din setări?

Răspuns:

**A4. Raportul „stoc la zi”.** Ne trebuie un raport/export din SmartBill cu stocul curent al fiecărui produs (de preferat Excel sau CSV).
(a) Cum se numește raportul și cum se obține? (b) Ce coloane are (cod produs, denumire, gestiune, unitate de măsură, cantitate …)?
(c) Apare **data și ora** la care a fost generat? (d) Pentru produsele vândute la metru/kg, cantitatea apare cu zecimale?
*Ideal:* trimite-ne un exemplu real cu 20–30 de rânduri, care să conțină și produsele din tabelul de la B1.

Răspuns:

**A5. Codul produsului.** Codul de produs din SmartBill (cel din coloana „cod”) este același cu **SKU-ul** pe care îl folosim în magazinul
online? Dacă există produse la care diferă, le putem lista?

Răspuns:

---

## B. Unități de măsură și cantități cu zecimale

Unele produse nu se vând la bucată. Exemple reale din magazin:

| # | Produs | Se vinde în | Cantități posibile |
|---|---|---|---|
| 1 | Țeavă PVC-U | ml, doar în multipli de 2,5 ml | 2,5 · 5 · 7,5 · 10 … ml |
| 2 | Liner de placare | mp, doar rola întreagă de 41,25 mp | 41,25 · 82,5 · 123,75 … mp |
| 3 | Bisulfat de sodiu | kg, doar sacul de 25 kg (preț pe sac) | 25 · 50 · 75 … kg |
| 4 | Furtun de dozare | ml | 1 · 2 · 3 … ml |
| 5 | Mozaic de placare | mp, doar cutia de 2,03 mp | 2,03 · 4,06 · 6,09 · 8,12 … mp |
| 6 | Lemn de abachi (saună) | ml, bucăți de 1,5 / 1,8 / 2,1 / 2,6 ml | multipli ai lungimii alese |

**B1. Cum ține SmartBill stocul acestor produse?** Pentru fiecare din cele 6 produse (sau pentru produsele cu SKU-urile pe care ți le dăm):
în ce **unitate de măsură** este stocul în SmartBill (ml / mp / kg sau buc / rolă / sac / cutie) și cu **câte zecimale** poate fi ținută
cantitatea? Exemplu: liner stocat „2 role” sau „82,5 mp”?

| Produs | Unitatea în SmartBill | Zecimale la cantitate |
|---|---|---|
| Țeavă PVC-U | | |
| Liner de placare | | |
| Bisulfat de sodiu | | |
| Furtun de dozare | | |
| Mozaic de placare | | |
| Lemn de abachi | | |

**B2. Lista unităților de măsură din SmartBill.** Care sunt unitățile definite în cont și cum apar scrise pe factură (de exemplu „buc”, „ml”,
„mp”, „kg”, „l”, „set”, „sac”, „rolă”, „cutie”)? Putem adăuga unități noi (sac, rolă, cutie) dacă lipsesc?

Răspuns:

**B3. Câte zecimale acceptă SmartBill** pe o linie de factură: (a) la **cantitate** (de exemplu 6,09 mp sau 82,5 mp: câte zecimale
maxim?) și (b) la **prețul unitar** (de exemplu 123,45 lei/mp: câte zecimale?).

Răspuns:

**B4. Rotunjirea pe linie sau pe total.** La o linie cu cantitate zecimală, SmartBill calculează valoarea liniei = cantitate × preț unitar
și o **rotunjește pe fiecare linie** sau rotunjește doar **totalul facturii**? Se pornește de la prețul **fără TVA** (net × cantitate, apoi
se adaugă TVA) sau de la prețul **cu TVA** (brut × cantitate, apoi se extrage TVA)? Cum e configurată rotunjirea documentelor în contul nostru?

*Exemplu:* clientul cumpără 3 cutii de mozaic = 6,09 mp, la 123,45 lei/mp **cu TVA**.
- Calcul pe cantitatea totală: 123,45 × 6,09 = 751,8105 → **751,81 lei** (net 621,33 + TVA 130,48).
- Dacă s-ar rotunji întâi prețul unei cutii: 123,45 × 2,03 = 250,6035 → 250,60; × 3 = **751,80 lei**. Diferență: 1 ban.

Magazinul calculează ca în primul caz (o singură rotunjire pe linie, pe cantitatea totală). Vrem să fim siguri că **factura SmartBill iese
exact 751,81**. Ce ne recomandați dacă SmartBill face altfel?

Răspuns:

**B5. Ce trimitem pe factură la produsele vândute pe ambalaj.** Pentru un sac de bisulfat de 25 kg cu prețul **120,00 lei pe sac**, clientul
cumpără 2 saci (240,00 lei). Pe factură trebuie să apară **„2 sac × 120,00”** sau **„50 kg × 4,80 lei/kg”**? Prima variantă dă totalul
exact; a doua ar cere un preț pe kg cu mai multe zecimale. Contul nostru acceptă ambele (unitatea „sac” ca unitate de vânzare)? Care e
varianta corectă contabil?

Răspuns:

**B6. Același produs în două unități.** Dacă un produs se ține în stoc în kg, dar se vinde în saci de 25 kg (sau se ține în role și se
vinde în mp), SmartBill poate descărca gestiunea corect (2 saci facturați = 50 kg scăzuți)? Sau trebuie ținut stocul în aceeași unitate în
care se facturează?

Răspuns:

**B7. Rest rămas dintr-un ambalaj.** Dacă dintr-o rolă de 41,25 mp se taie și se vinde pe loc în magazinul fizic o parte (restul nu se
mai poate vinde online, pentru că online se vinde doar rola întreagă), cum se înregistrează în SmartBill diferența (scădere din stoc,
transformare în alt articol, alt document)? Doar ca să înțelegem cum apar astfel de diferențe în raportul „stoc la zi”.

Răspuns:

---

## C. Produse „la comandă” (aduse special de la furnizor)

Planificăm o stare „La comandă” pentru produse care nu sunt în stoc, dar pot fi aduse în câteva zile (cu termen de livrare afișat).
Clientul le poate comanda și plăti înainte să existe în stoc.

**C1. Când se emite factura** pentru o astfel de comandă: **la plata comenzii** (cum am stabilit la card), **la expedierea produsului**
sau altfel? Contează dacă factura se emite înainte ca produsul să intre în gestiune (se poate factura un produs care nu e încă în stoc,
fără stoc negativ)?

Răspuns:

**C2. Ramburs la produse „la comandă”.** Dacă clientul refuză colețul la livrare (produs adus special), cum se tratează contabil
(storno, costuri de transport suportate de magazin, produs rămas în stoc)? Din punct de vedere contabil, recomandați să **nu** permitem
ramburs pentru produsele „la comandă” (doar plată în avans)?

Răspuns:

**C3. Comandă cu produse în stoc și produse „la comandă”.** Dacă o comandă conține și produse din stoc, și produse „la comandă”, și
trimitem totul odată (când sosește ultimul produs), se emite **o singură factură** pentru toată comanda? La ce dată?

Răspuns:

**C4. Furnizorul nu mai poate livra.** Dacă după comandă și plată furnizorul nu mai poate livra produsul, ce document emitem pentru
partea anulată (storno parțial, ca la retur parțial) și cum se returnează banii?

Răspuns:

---

## D. Întrebări rămase deschise din etape anterioare (se vor folosi mai târziu, nu blochează stocul)

Le repetăm aici ca să trimitem totul într-un singur mesaj. Detaliile sunt în `docs/10-decizii-deschise.md`, Partea III.

**D1. Vouchere cadou.** Răspunsul primit a fost „reducere din comandă”. Distingem două lucruri: **voucher cumpărat** de un client (plată
anticipată, datorie până la utilizare) și **cod de reducere gratuit** (promoție). Pentru cel cumpărat, pe factura finală apare ca **metodă
de plată** (nu reduce baza de TVA). E corect? Ce termen minim de valabilitate se aplică și cum se tratează soldul neutilizat la expirare?

Răspuns:

**D2. TVA pe puncte de loialitate.** Un client cumpără produse de 100 lei și plătește 10 lei cu puncte de loialitate. TVA se calculează pe
**100 lei** sau pe **90 lei**? Cum arată factura (reducerea ca linie separată)?

Răspuns:

**D3. Transportul la retur parțial.** La un retur parțial, cu storno parțial pentru produse, ce se întâmplă cu **transportul** plătit de
client (se returnează, se păstrează, depinde de motiv)?

Răspuns:

---

## Rezumat (pentru contabil)

Cele mai importante, dacă nu ai timp pentru toate: **A2, A3, A4, B1, B3, B4, B5, C1.** Cu răspunsurile la ele putem construi corect
calculul totalurilor și importul stocului.
