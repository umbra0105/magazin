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

---

## 8. Plățile online cu card (adăugată în Faza 10)

**8.1. Mesajul către client la rambursarea automată.** Când o plată cu cardul ajunge după expirarea rezervării și produsele nu mai sunt
în stoc, comanda se anulează, iar plata se rambursează automat. Pe pagina comenzii și în urmărire scriem acum: «Plata a ajuns după
expirarea rezervării, iar produsele nu mai sunt în stoc. Comanda a fost anulată, iar suma plătită va fi returnată.» (cu Netopia, unde
rambursarea poate cere o acțiune manuală, nu scriem niciodată «rambursat» până nu e confirmat). Formularea e corectă juridic? Trebuie
menționat un termen în care banii ajung înapoi la client (depinde de bancă) și un contact?

Răspuns:

**8.2. Ce păstrăm de la procesator și cât timp.** Păstrăm pe plată: referința procesatorului, suma și moneda confirmate, ultimele 4 cifre
ale cardului (doar dacă le trimite procesatorul) și starea; NU păstrăm niciodată numărul cardului, CVV sau alte date de card. Evenimentele
primite (notificările) păstrează doar câmpurile verificate, nu corpul complet; cele respinse păstrează doar motivul și un hash al corpului.
Este în regulă ultimele 4 cifre ca dată personală? Cât timp păstrăm plățile, evenimentele și notificările respinse (acum fără ștergere
automată; propunere: plățile cât timp comenzile, 10 ani fiscal; evenimentele și respingerile 12 luni)?

Răspuns:

**8.3. Procesatorii în politica de confidențialitate.** Netopia și EuPlătesc devin împuterniciți/operatori asociați pentru plățile cu
card. Ce trebuie scris în politica de confidențialitate (identitate, scop, temei, destinatari, transfer în afara UE dacă e cazul) și avem
nevoie de contracte separate de prelucrare cu fiecare?

Răspuns:

**8.4. Textul legal al reîncercării plății.** Când o plată cu cardul eșuează, comanda rămâne în așteptare 24 de ore (setabil) și clientul
poate reîncerca plata dintr-un link; stocul se rezervă din nou doar dacă mai există. După 24 de ore comanda se anulează automat. Trebuie
să spunem clientului, înainte de plată, termenul de 24 de ore și faptul că produsele nu sunt rezervate între încercări? Unde (checkout,
pagina de eșec, email)?

Răspuns:

---

## 9. Emailurile comenzilor (adăugată în Faza 11)

Emailul de confirmare conține acum informațiile precontractuale (identitatea comerciantului din setări, produsele, prețul total cu TVA și
costul livrării, plata, livrarea și termenul, dreptul de retragere, formularul-model, garanția, reclamațiile și linkurile ANPC / SAL / SOL, dacă
sunt setate). Formulările de mai jos sunt PRUDENTE și provizorii; nu citează niciun temei legal. Textele stau în `packages/emails/src/catalog.ts`.

**9.1. Dreptul de retragere și produsele «La comandă».** În email scriem: «Ai dreptul să te retragi din contract, fără să dai vreun motiv, în
14 zile de la primirea produselor» și, la comenzile cu produse «La comandă», că acestea sunt o excepție, cu «condițiile comunicate înainte de
comandă». Atenție la legătura cu 1.6: nu afirmăm că produsele doar aduse de la furnizor nu se pot returna. Care e formularea corectă a excepției
(doar produsele făcute după specificațiile clientului), și ce trebuie să spunem despre produsele aduse doar la comandă?

Răspuns:

**9.2. Formularul-model de retragere în email.** Includem, ca text, modelul de formular (către comerciant, produsele, datele comenzii, numele și
adresa consumatorului, semnătura și data). E suficient în corpul emailului sau trebuie atașat ca document / link către o pagină?

Răspuns:

**9.3. Garanția legală.** Scriem doar că produsele beneficiază de garanția legală de conformitate, «a cărei durată și condiții sunt cele prevăzute de
lege», fără durată. Trebuie menționată durata (și, la produsele cu garanție comercială suplimentară, diferența)?

Răspuns:

**9.4. Reclamații, ANPC, SAL și SOL.** Punem datele de contact ale magazinului pentru reclamații și, dacă sunt setate, linkurile ANPC, SAL și SOL.
Sunt suficiente aceste informații în email, sau trebuie și un text explicit despre procedura de reclamație și termenele de răspuns?

Răspuns:

**9.5. Anularea unei comenzi plătite și rambursarea.** Când admin-ul anulează o comandă plătită, comanda NU se rambursează automat: emailul spune
«te anunțăm printr-un email separat când rambursarea este confirmată» și nu promite o sumă sau un termen; emailul de rambursare spune «banii ajung în
contul tău în funcție de banca ta». Sunt formulările corecte? Trebuie un termen maxim de returnare a banilor (de exemplu 14 zile)?

Răspuns:

**9.6. Păstrarea emailurilor trimise.** Păstrăm pe comandă doar starea trimiterii (șablon, destinatar, moment, stare), nu corpul emailului. Cât timp
păstrăm aceste rânduri (conțin adresa clientului)? Este suficient să dovedim trimiterea cu starea și momentul, sau trebuie păstrat și textul trimis?

Răspuns:

## 10. Oferta de plată cu link (adăugată în Faza 11)

**10.1. Consimțământul la plata din link.** Clientul primește un link personal către o ofertă pregătită de magazin; pe pagină vede produsele, livrarea și totalul, bifează acordul (aceeași formulare provizorie ca la checkout: «Am citit și sunt de acord cu Termenii și condițiile și cu Politica de confidențialitate») și plătește cu cardul. Comanda se creează abia la plată, iar acordul, textul lui și versiunea se salvează pe comandă. Este suficientă această bifă pentru un contract încheiat la distanță, fiindcă oferta a fost pregătită la cererea clientului? Trebuie arătate pe pagina ofertei informațiile precontractuale complete (identitatea comerciantului, dreptul de retragere, termenul de livrare) înainte de bifă? Unele produse din piscine sunt făcute la comandă: se aplică excepția de la dreptul de retragere?

Răspuns:

**10.2. Valabilitatea ofertei și prețul.** Oferta e valabilă implicit 72 de ore; dacă prețul, transportul, TVA-ul sau stocul se schimbă înainte de plată, oferta devine «învechită» și nu se mai poate plăti (magazinul creează una nouă). Este corect ca magazinul să nu fie obligat la prețul din ofertă după schimbare? Ce mențiune trebuie să apară pe pagina ofertei și în email despre această regulă?

Răspuns:

**10.3. Linkul personal.** Linkul conține un jeton secret și este valabil până la expirare; oricine îl deține poate plăti oferta, dar nu o poate modifica. Emailul cu link se păstrează o singură dată (nu se păstrează jetonul, doar amprenta lui). Este nevoie de o mențiune de confidențialitate suplimentară?

Răspuns:
