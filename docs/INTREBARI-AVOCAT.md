# Întrebări pentru avocat — termene de livrare, prețul redus, date personale, stoc

**Stare:** de trimis · **Întocmit:** 2026-10-21 · **Pentru:** avocatul care revizuiește textele legale ale magazinului

Magazin online din România (B2C, persoane fizice și firme), echipamente și materiale pentru piscine, plată prin card, ramburs și transfer
bancar, plus produse digitale (tutoriale video). Vânzare doar în România. Întrebările vin din ce construim acum și din ce urmează.
Unde apare **(adăugată de Claude)**, întrebarea nu era în planul inițial: a apărut din analiza de față și trebuie confirmată că e relevantă.

## Ce știm deja de la proprietar (nu mai trebuie întrebat)

- Se vând produse în **ml, mp, kg, litri și bucăți**, cu **pas de vânzare**: se comandă doar multipli ai ambalajului (rolă de liner de 41,25 mp,
  cutie de mozaic de 2,03 mp, sac de bisulfat de 25 kg, țeavă în multipli de 2,5 ml, lemn în bucăți de 1,5 / 1,8 / 2,1 / 2,6 ml). **Nu se taie
  la cerere** în magazinul online.
- Se vând și produse **comandate la furnizor după comandă** („la comandă”), cu termen de livrare afișat; în comenzi mixte, livrarea se face
  **toată odată**.
- Facturile le emite SmartBill; magazinul fizic, cel online și depozitul sunt în aceeași locație.

**Cum răspunzi:** scrie sub fiecare întrebare, în „Răspuns”. „Nu e nevoie” sau „depinde de …” sunt răspunsuri bune.

---

## 1. Termenul de livrare pentru produsele „la comandă” și pentru comenzile cu mai multe produse

Unele produse sunt în stoc, altele „la comandă” (le aducem de la furnizor într-un număr de zile afișat pe pagina produsului, de exemplu
14 zile). Clientul le poate comanda și plăti înainte să existe în stoc. Dacă într-o comandă sunt și produse din stoc, și produse „la comandă”,
livrăm **toată comanda odată**, la termenul produsului cel mai lent.

**1.1.** Termenul general de livrare este de cel mult **30 de zile** de la comandă, dacă nu s-a convenit altfel. Este suficient să afișăm
termenul estimat (de exemplu „livrare în 14 zile”) pe pagina produsului, în coș, la plată și în emailul de confirmare? Ce formulare
ne recomandați (termen „estimat” sau „maxim”)?

Răspuns:

**1.2.** Dacă un produs „la comandă” are un termen mai mare de 30 de zile (de exemplu 45 de zile), ce trebuie să facem ca să fie valid
(acord expres al clientului, bifă separată, mențiune în emailul de confirmare)?

Răspuns:

**1.3.** Dacă **furnizorul nu mai poate livra** produsul după ce clientul a plătit, ce procedură de informare și rambursare trebuie să
urmăm (termen de returnare a banilor, cine suportă costurile, ce se scrie în termeni)? Putem anula doar partea nelivrabilă dintr-o comandă
cu mai multe produse?

Răspuns:

**1.4.** Poate clientul **anula** comanda cu produse „la comandă” înainte de expediere, cu rambursare integrală, fără să invocăm dreptul de
retragere de 14 zile? Ce spunem în termeni?

Răspuns:

**1.5. Ramburs la produse „la comandă”.** Dacă produsul a fost adus special și clientul refuză colețul la livrare, există restricții legale
sau recomandări (de exemplu cerem plata în avans pentru aceste produse)? *(Decizia de produs se ia la construirea comenzilor.)*

Răspuns:

**1.6. Ce afirmăm (și ce NU) despre returnarea produselor „la comandă” (adăugată în Faza 9).** Magazinul NU scrie pe site «nu se pot returna» pentru produsele aduse de la furnizor și nu blochează nimic pe această bază. Excepția de la dreptul de retragere de 14 zile este pentru bunuri **făcute după specificațiile clientului** (sau personalizate), nu automat pentru cele pe care le comandăm noi de la furnizor pentru că nu sunt în stoc. Confirmați că un produs standard, doar adus la comandă, rămâne returnabil în 14 zile? Ce textul recomandați (la produs, la plată, în termeni)? *(Returnările se construiesc în Faza 14.)*

Răspuns:

---

## 2. Prețul redus și „cel mai mic preț din ultimele 30 de zile” (Omnibus)

Când afișăm un preț redus, legea cere să arătăm **cel mai mic preț practicat în ultimele 30 de zile** înainte de reducere. Magazinul își
păstrează istoricul prețurilor, dar produsele migrate din magazinul vechi (WooCommerce) **nu au istoric** de 30 de zile.

**2.1.** Ce trebuie afișat exact: doar prețul de referință („cel mai mic preț din ultimele 30 de zile”), sau și procentul reducerii?
Cum trebuie formulat și unde pe pagină?

Răspuns:

**2.2.** Pentru ce tipuri de reduceri se aplică: promoții cu preț redus pe produs, reduceri programate (cu dată de început și de sfârșit),
cupoane de reducere, reducerea pentru client fidel/VIP (5% / 7%) și prețul pentru parteneri?

Răspuns:

**2.3.** Pentru **produsele migrate din magazinul vechi**, de la ce dată curge perioada de 30 de zile? Putem lansa reduceri imediat cu
prețul de la migrare ca referință, sau trebuie să așteptăm 30 de zile de la lansare sau să folosim prețurile din istoricul vechi (pe care
le avem doar parțial)?

Răspuns:

**2.4.** Dacă prețul unui produs scade de mai multe ori într-o lună, care e prețul de referință? Dacă produsul nu a fost vândut deloc
30 de zile, ce afișăm?

Răspuns:

*Notă pentru dezvoltare: fără răspunsul la această secțiune, afișarea reducerilor în magazin nu se lansează.*

---

## 3. Date personale (GDPR)

**3.1. Jurnalul de audit.** Aplicația ține un jurnal de acțiuni din administrare (cine a modificat ce, când). Jurnalul conține **adresa de
email** a persoanei care a făcut acțiunea și **nu poate fi șters** (protecție tehnică împotriva falsificării). (a) Pe ce temei legal îl
păstrăm? (b) Cât timp? (c) Ce răspundem la o cerere de ștergere a datelor din partea unui fost angajat/colaborator? (d) Se poate rezolva
prin anonimizarea adresei după un termen? (e) Ce scriem în politica de confidențialitate?

Răspuns:

**3.2. „Anunță-mă când revine în stoc”.** Pe pagina unui produs epuizat, clientul își poate lăsa adresa de email și primește **un singur
email** când produsul revine; apoi adresa se șterge din sistem (sau după 90 de zile, dacă produsul nu revine). (a) E suficient acest
mecanism? (b) Ce text de consimțământ/informare afișăm lângă câmp? (c) Termenul de 90 de zile e ales de noi: e acceptabil? (d) Emailul
de notificare e comunicare de serviciu sau de marketing (cere consimțământ separat)?

Răspuns:

**3.3. Adresele de livrare și datele comenzilor** sunt păstrate pentru obligații fiscale și contabile. Ce termene de păstrare și ce
proceduri de anonimizare la ștergerea contului ne recomandați? *(Se tratează la construirea contului de client; întrebarea e pusă acum
ca să fie pregătit răspunsul.)*

Răspuns:

**3.4. Cookie-ul coșului de oaspete (adăugată în Faza 8).** Coșul unui vizitator neautentificat se păstrează cu un cookie propriu
(valoare aleatorie, `httpOnly`, `SameSite=Lax`, `Secure` în producție, valabilitate setabilă din admin; în baza de date stă doar
amprenta lui, nu valoarea). Îl tratăm ca **strict necesar** (fără el coșul nu funcționează): nu cere consimțământ și apare în
categoria «necesar» din consimțământ, nu ca alegere. **Cookie-ul coșului de oaspete e tehnic necesar: de confirmat formularea din
politica de cookie-uri** (durata, scopul, dacă trebuie menționat separat de cookie-ul de consimțământ).

Răspuns:

---

## 4. Vânzarea la metru, pe suprafață și în ambalaje (adăugată de Claude)

Vindem și produse la **metru liniar, metru pătrat sau kilogram**, în cantități care sunt multipli ai unui ambalaj (rolă de liner de
41,25 mp, cutie de mozaic de 2,03 mp, țeavă în multipli de 2,5 ml). Online se vinde doar ambalajul sau multiplii lui (pas de vânzare); nu se taie la cerere.

**4.1.** Dreptul de retragere de 14 zile se aplică normal acestor produse (rolă întreagă, cutie întreagă, sac sigilat)? Ce se întâmplă cu
un produs deschis sau tăiat de client?

Răspuns:

**4.2.** Dacă în viitor vindem și **produse tăiate/confecționate la cerere** (de exemplu liner sau țeavă la dimensiune), se aplică excepția
de la dreptul de retragere pentru produse realizate conform specificațiilor clientului? Ce mențiune trebuie afișată înainte de comandă?

Răspuns:

*Legătură (Faza 9): vezi și 1.6. Nu afirmăm pe site că produsele „la comandă” nu se returnează; excepția se aplică doar produselor realizate după specificațiile clientului.*

**4.3.** Pentru produsele chimice (de exemplu bisulfat de sodiu) există obligații de informare, de limitare a livrării sau de
etichetare pe care trebuie să le reflectăm în magazin (fișă de securitate, avertismente, restricții de vânzare la distanță)?

Răspuns:

---

## 5. Texte legale și licențe (se vor folosi înaintea lansării)

**5.1. Textele legale generate** (termeni și condiții, politica de confidențialitate, politica de cookie-uri, politica de retur,
informații precontractuale). Instalatorul generează șabloane precompletate cu datele firmei. Putem trimite șabloanele spre revizuire
când sunt gata?

Răspuns:

**5.2. Bifa de renunțare la dreptul de retragere pentru conținut digital** (tutoriale video livrate imediat): este separată de acceptarea
termenilor, nepre-bifată, obligatorie, salvată pe comandă. Textul propus este: „Solicit livrarea imediată a conținutului digital și confirm
că îmi pierd dreptul de retragere de 14 zile după începerea livrării.” Este suficient?

Răspuns:

**5.3. Licențele componentelor software.** Produsul se distribuie către clienți (instalare în magazinul lor). Fișierul
`THIRD-PARTY-NOTICES.md` listează dependențele; câteva au licențe cu cerințe speciale (LGPL pentru biblioteca de procesare a imaginilor,
CC-BY-4.0 pentru o bază de date de compatibilitate, FSL-1.1-Apache-2.0 pentru o unealtă de build). Putem trimite fișierul spre
verificare înainte de prima vânzare?

Răspuns:

---

## 6. Formularul «Anunță-mă când revine» (adăugată în Faza 7)

Formularul public cere o adresă de email și trimite UN singur mesaj când produsul revine în stoc; adresa se șterge după trimitere (sau după
perioada de păstrare din setări, 90 de zile implicit). Textele de acum sunt PROVIZORII (decizia utilizatorului, 2026-11-16):
bifa «Sunt de acord să primesc un singur email când produsul revine în stoc.» (obligatorie, nebifată) și, sub formular, «Adresa ta de email
este folosită doar pentru această notificare și se șterge după trimitere.»

**6.1.** Care este formularea finală a consimțământului și a informării (temei legal, scop, durata păstrării, drepturile persoanei, operatorul)?
Este suficientă o bifă plus o frază și un link către politica de confidențialitate, sau trebuie o informare mai lungă?

Răspuns:

**6.2.** Este corect să ștergem adresa imediat după trimitere, fără să păstrăm dovada consimțământului? Dacă trebuie păstrată dovada (data și
textul acceptat), cât timp și unde?

Răspuns:

---

## 7. Plasarea comenzii (adăugată în Faza 9)

**7.1. Textul butonului final.** Azi butonul este «Plasează comanda». Legea cere ca butonul de finalizare să indice clar obligația de plată (de exemplu «Comandă cu obligație de plată»)? Ce formulare recomandați pentru comenzile cu ramburs și pentru cele cu transfer bancar (unde plata se face după plasare)? Textul stă într-un singur mesaj, ușor de schimbat.

Răspuns:

**7.2. Adresa IP și user-agent pe comandă.** În Faza 9 NU salvăm adresa IP și user-agent-ul clientului pe comandă. Sunt necesare ca dovadă a consimțământului la Termeni sau la bifa legală? Dacă da, cât timp se păstrează și ce scriem în politica de confidențialitate?

Răspuns:

**7.3. Formularea consimțământului pentru Termeni.** Bifa obligatorie, nepre-bifată: «Am citit și sunt de acord cu Termenii și condițiile» (cu legături către pagini). Salvăm pe comandă textul exact, versiunea și momentul. Este suficient? Ce alte acorduri trebuie bifate separat la comandă (politica de confidențialitate, informații precontractuale)? *(Paginile legale reale vin în Faza 16; până atunci legăturile duc la pagini provizorii, noindex, marcate «în curs de redactare».)*

Răspuns:
