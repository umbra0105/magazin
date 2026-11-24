# Întrebări pentru contabil — stoc, unități de măsură, cantități cu zecimale

**Stare:** de trimis · **Actualizat:** 2026-10-21 · **11 întrebări**

Magazinul online vinde echipamente și materiale pentru piscine, cu TVA 21% inclus în preț. Facturile le emite SmartBill. Unele produse
se vând la metri, metri pătrați, kilograme, litri sau în ambalaje (rolă, sac, cutie). Vrem ca **suma încasată de la client să fie exact
suma de pe factură**. Răspunde sub fiecare întrebare; „nu știu” sau „verific în SmartBill” sunt răspunsuri bune. Cifrele din exemple sunt
inventate.

## Ce știm deja de la proprietar (nu mai trebuie întrebat)

- Produsele au **gestiune activă în SmartBill**.
- Când se emite factura, **stocul scade automat în SmartBill**.
- Magazinul fizic, magazinul online și depozitul sunt **în aceeași locație** (o singură gestiune pentru stocul din magazin).
- Se vând produse în **ml, mp, kg, litri și bucăți**, cu **pas de vânzare** (se comandă doar multipli ai ambalajului). Exemple reale:

  | Produs | Se vinde în | Cantități posibile |
  |---|---|---|
  | Țeavă PVC-U | ml, multipli de 2,5 | 2,5 · 5 · 7,5 … ml |
  | Liner de placare | mp, rola de 41,25 | 41,25 · 82,5 … mp |
  | Bisulfat de sodiu | kg, sacul de 25 (preț pe sac) | 25 · 50 … kg |
  | Furtun de dozare | ml | 1 · 2 · 3 … ml |
  | Mozaic de placare | mp, cutia de 2,03 | 2,03 · 4,06 · 6,09 … mp |
  | Lemn de abachi | ml, bucăți de 1,5 / 1,8 / 2,1 / 2,6 | multipli ai lungimii alese |

- Se vând și produse **comandate la furnizor după comandă** („la comandă”, cu termen de livrare afișat).
- Răspunsuri mai vechi (`docs/10`): un retur parțial se stornează parțial; seria și numărul facturii le dă SmartBill; e-Factura o transmite SmartBill.

Ce aduce proprietarul (nu e pentru contabil): raportul „stoc la zi” din SmartBill (cu cele 6 produse) și verificarea că SKU-ul din magazin
este același cu codul de produs din SmartBill.

## Răspunsuri primite

**2026-10-28** (de la proprietar și contabil; întrebările de mai jos rămân cu `Răspuns:` gol până le rezumă contabilul în scris):

- **Întrebarea 1 (stoc negativ):** SmartBill REFUZĂ factura la stoc 0 dacă bifa «descărcare gestiune» e activă. Factura se poate emite FĂRĂ descărcare de gestiune.
- **Întrebarea 3 (zecimale):** SmartBill folosește 2 zecimale la cantitate, cu rotunjire la cea mai apropiată cifră (2,348 devine 2,35).
- **Întrebarea 5 (produse pe ambalaj):** la kilograme se facturează în kg; sacul se facturează ca bucată.
- **Întrebarea 7 (momentul facturii la «La comandă»):** produsele «La comandă» se facturează la plată dacă au fost plătite, iar la expediere dacă se plătesc la livrare (ramburs).
- **Întrebarea 4 (rotunjirea) — răspuns primit de la utilizator, nu de la contabil în scris, 2026-11-17:** SmartBill preia exact suma comenzilor din website, fără rotunjire proprie, și acceptă 2 zecimale. Regula magazinului rămâne «o singură rotunjire pe linie, la 2 zecimale, în magazin» (R1 pe unitate / R2 pe pas); Faza 8 nu așteaptă alt răspuns. **De confirmat în sandbox-ul SmartBill (Faza 13): o diferență de 1 ban acolo = 🛑.**
- **Stare după Faza 13 (2026-11-22), ce s-a implementat din fiecare întrebare:**
  - **3, 5, 7 (zecimale, unități, «La comandă»):** implementate. Factura refuză cantitățile cu mai mult de 2 zecimale (și ecranul Facturare avertizează pașii care le produc), kg se facturează în kg, sacul ca bucată, «La comandă» la plată sau (la ramburs) la expediere.
  - **1, 8 (factura fără descărcare):** implementat: o factură cu un produs negestionat sau «La comandă» se emite întreagă FĂRĂ descărcare de gestiune și nu se socotește «oglindită».
  - **4 (rotunjirea):** regula din magazin (o rotunjire pe linie, TVA = suma TVA-urilor pe linii) e verificată pe 20 de cazuri numerice, cu furnizorul simulat care respinge orice diferență; **confirmarea în SmartBill rămâne PASUL SEPARAT al utilizatorului** (`docs/FACTURARE-VERIFICARE-ROTUNJIRE.md`), iar LIVE e blocat până atunci.
  - 🟡 **12 (TVA la transport și la taxa de ramburs):** regula provizorie din magazin (sume cu TVA inclus, TVA extras din brut cu `tax.standardRate`, linii separate pe factură; transportul paletizat la fel). **De confirmat cu contabilul înainte de lansare.**
  - 🟡 **11 (transportul la retur parțial):** storno parțial doar pe produse; transportul NU se stornează automat.
  - **13 (card confirmat după reîncercare):** o singură factură pe comandă (unicitate pe comandă și tip), emisă când plata reușită se confirmă; data facturii e ziua emiterii.
  - 🟡 **14 (rambursare parțială):** o rambursare parțială de bani nu emite niciun document; stornoul parțial se cere explicit, pe produse. De decis cu contabilul.
**2026-11-23** (de la contabil, transmise de proprietar):

- **Întrebarea 16 (TVA la stornourile în bucăți):** ACCEPTAT. Diferența de 1 ban de TVA pe linie se reglează manual în contabilitate; facturile nu trebuie să aibă diferențe de BRUT (totalul stornourilor = totalul facturii, exact). Rămâne regula din mini-faza `storno-total`: TVA-ul fiecărui storno din brutul lui, brutul restului exact.
- **Întrebarea 11 (transportul la retur parțial):** depinde de motivul returului: la defecte, transportul returului e suportat de magazin; la alte motive, de cumpărător. Se tratează individual, fără regulă strictă; pot exista excepții. Sistemul actual rămâne: stornoul parțial doar pe produse, iar transportul se adaugă manual de admin, cu motiv, până la transportul plătit.
- **Întrebarea 14 (rambursare parțială):** se emite STORNO PARȚIAL pe factură. Azi o rambursare parțială de bani din ecranul plăților (Faza 10) NU stornează nimic: se face în mini-faza «storno la rambursare parțială» (`docs/06`), înainte de activarea LIVE a SmartBill, nu în Faza 14b.
- Consecințele pentru cod sunt trecute în TODO, Faza 13 (factura fără descărcare pentru «La comandă» sau fără stoc; cel mult 2 zecimale pe factură). Nu sunt rezolvate încă.

---

## Pentru contabil

### Stoc

**1. Stoc negativ.** Dacă se facturează un produs cu stoc 0 (sau mai mic decât cantitatea facturată), SmartBill emite factura și stocul
devine negativ, sau o refuză? Se poate alege din setări?

Răspuns:

### Unități și zecimale în SmartBill

**2. Unitatea și zecimalele stocului.** Pentru cele 6 produse de mai sus: în ce unitate este ținut stocul în SmartBill și cu câte zecimale?
Exemplu: liner stocat „2 role” sau „82,5 mp”. Putem adăuga în cont unitățile care lipsesc (sac, rolă, cutie)? Dacă stocul e în kg, dar se
vinde în saci de 25 kg, SmartBill descarcă corect gestiunea (2 saci facturați = 50 kg)?

| Produs | Unitatea în SmartBill | Zecimale la cantitate |
|---|---|---|
| Țeavă PVC-U | | |
| Liner de placare | | |
| Bisulfat de sodiu | | |
| Furtun de dozare | | |
| Mozaic de placare | | |
| Lemn de abachi | | |

Răspuns (unități lipsă / descărcare):

**3. Zecimale pe factură.** Câte zecimale acceptă SmartBill pe o linie: la **cantitate** (ex. 6,09 mp) și la **prețul unitar** (ex. 123,45 lei/mp)?

Răspuns:

**4. Rotunjirea.** La o linie cu cantitate zecimală, SmartBill rotunjește **pe fiecare linie** sau doar **totalul facturii**? Pornește de la
prețul **fără TVA** (net × cantitate, apoi TVA) sau **cu TVA** (brut × cantitate, apoi se extrage TVA)? Cum e configurată rotunjirea
documentelor în cont?

*Exemplu:* 3 cutii de mozaic = 6,09 mp la 123,45 lei/mp cu TVA. Calculat pe cantitatea totală: 123,45 × 6,09 = 751,8105 → **751,81 lei**
(net 621,33 + TVA 130,48). Dacă s-ar rotunji întâi prețul unei cutii: 250,60 × 3 = **751,80 lei** (1 ban diferență). Magazinul calculează
ca în primul caz; factura trebuie să iasă exact 751,81. Ce recomandați dacă SmartBill face altfel?

Răspuns:

**5. Produse pe ambalaj.** Un sac de 25 kg costă **120,00 lei pe sac**; clientul cumpără 2 (240,00 lei). Pe factură trebuie **„2 sac × 120,00”**
sau **„50 kg × 4,80 lei/kg”**? Prima dă totalul exact. Care e varianta corectă contabil și o acceptă contul nostru?

Răspuns:

**6. Rest rămas dintr-un ambalaj.** Dacă dintr-o rolă se taie și se vinde în magazinul fizic o parte (online se vinde doar rola întreagă),
cum se înregistrează diferența în SmartBill (scădere, transformare în alt articol, alt document)?

Răspuns:

### Produse „la comandă”

**7. Când se emite factura** pentru o comandă cu produse „la comandă”: la plată, la expediere sau altfel? Se poate factura un produs care
nu e încă în stoc, fără stoc negativ? Dacă o comandă are și produse din stoc, și produse „la comandă”, trimise toate odată, se emite o
singură factură, la ce dată?

Răspuns:

**8. Ramburs.** Dacă clientul refuză colețul cu un produs adus special, cum se tratează contabil (storno, transport suportat de magazin)?
Recomandați să nu permitem ramburs la produsele „la comandă”?

Răspuns:

---

## Mai târziu (nu blochează stocul)

**9. Vouchere cadou.** Un voucher **cumpărat** (plată anticipată) apare pe factura finală ca **metodă de plată**, nu reduce baza de TVA. E
corect? Ce termen minim de valabilitate se aplică și ce se întâmplă cu soldul neutilizat la expirare? (răspunsul anterior: „reducere din comandă”)

Răspuns:

**10. Puncte de loialitate.** Produse de 100 lei, 10 lei plătiți cu puncte: TVA se calculează pe 100 sau pe 90 lei? Reducerea apare ca linie separată?

Răspuns:

**12. TVA la transport și la taxa de ramburs (adăugată în Faza 9).** Transportul și taxa de ramburs sunt sume cu TVA inclus, ca prețurile produselor: TVA-ul se extrage din ele cu aceeași cotă (`tax.standardRate`, 21%), ca la linii. Provizoriu, așa le tratăm. E corect? Taxa de ramburs apare pe factură ca linie separată (serviciu) sau e inclusă în transport? Cota TVA a transportului urmează cota produselor sau e mereu cea standard?

Răspuns:

**11. Transportul la retur parțial.** La storno parțial pentru produse, transportul plătit de client se returnează, se păstrează sau depinde de motiv?

Răspuns (2026-11-23, contabil): depinde de motivul returului. La defecte, transportul returului e suportat de magazin; la alte motive, de cumpărător. Se tratează individual, fără regulă strictă; pot exista excepții. (Sistemul actual, cu transportul adăugat manual de admin, rămâne.)

**13. Momentul facturii la plata cu cardul confirmată după reîncercare (adăugată în Faza 10).** Cardul: factura se emite la plata confirmată
(Faza 13). Dacă prima încercare a eșuat și clientul a plătit la a doua (sau a treia), factura se emite o singură dată, la confirmarea plății
care a reușit, pe aceeași comandă? Data facturii e data confirmării plății, nu data plasării comenzii?

Răspuns:

**14. Rambursare parțială: ce document se emite (adăugată în Faza 10).** Rambursarea parțială a unei plăți cu cardul (de exemplu un produs
deteriorat, sau o diferență) cere storno parțial al facturii, notă de credit sau doar rambursarea banilor fără alt document? Cum se tratează
transportul în rambursările care nu sunt retururi? (Rambursarea din Faza 10 face doar banii; documentul fiscal vine în Faza 13.)

Răspuns (2026-11-23, contabil): se emite STORNO PARȚIAL pe factură. (Implementarea: mini-faza «storno la rambursare parțială», înainte de LIVE.)

**15. Comisionul procesatorului (adăugată în Faza 10).** Procesatorii rețin un comision din fiecare încasare, iar la rambursare comisionul
poate să nu se returneze. Cum se înregistrează: cheltuială lunară pe baza extrasului procesatorului, sau pe fiecare tranzacție? Avem nevoie
în aplicație de câmpuri pentru comision (suma netă virată) sau reconcilierea se face din extrasul procesatorului?

Răspuns:

**16. TVA la un storno total după stornouri parțiale în bucăți (adăugată în mini-faza `storno-total`, legată de #14).** Când o factură e stornată în mai multe documente (retururi parțiale, apoi stornoul restului), fiecare document storno are TVA-ul extras din brutul LUI (cum îl calculează și SmartBill), iar brutul tuturor stornourilor este totalul facturii, exact. Din cauza rotunjirii, suma TVA a stornourilor poate diferi cu 1 ban pe linie de TVA-ul liniei originale (exemplu: linie de 4 × 123,45 = 493,80 lei, TVA 85,70; retur de o bucată, TVA 21,43, apoi restul de 3 bucăți, 370,35 lei, TVA 64,28; suma TVA a stornourilor 85,71). Este acceptabilă o diferență de cel mult 1 ban pe linie, sau SmartBill / contabilul cer altă regulă (de exemplu TVA-ul ultimului storno «prin diferență», ceea ce SmartBill nu permite prin API, fiindcă își calculează singur TVA-ul din brut)? Același lucru la o linie cu cantitate zecimală, unde restul se trimite «1 × brutul rămas» ca documentul să nu difere cu 1 ban de ce a încasat magazinul.

Răspuns (2026-11-23, contabil): acceptat. Diferența de 1 ban de TVA pe linie se reglează manual în contabilitate; facturile nu trebuie să aibă diferențe de brut.
