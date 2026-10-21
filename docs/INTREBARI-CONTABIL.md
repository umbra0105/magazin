# Întrebări pentru contabil — stoc, unități de măsură, cantități cu zecimale

**Stare:** de trimis · **Actualizat:** 2026-10-21 · **Timp de completat:** ~15 minute (11 întrebări)

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

**11. Transportul la retur parțial.** La storno parțial pentru produse, transportul plătit de client se returnează, se păstrează sau depinde de motiv?

Răspuns:
