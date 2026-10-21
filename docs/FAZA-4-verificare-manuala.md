# Faza 4 — verificare manuală cap-coadă (Catalog)

Ghid pentru cine verifică Faza 4 **fără să fie programator**. Îl parcurgi singur, în 1–2 ore, cu browserul,
Prisma Studio și Excel. Nu ai nevoie să înțelegi codul: faci ce scrie la „Faci”, compari cu „Vezi” și, dacă vezi
altceva, citești „Dacă nu” și notezi în tabelul de la sfârșit.

Cum citești un pas:

- **Faci** = ce apeși sau scrii.
- **Vezi** = ce trebuie să apară. Textele între ghilimele sunt exact cele din aplicație.
- **Dacă nu** = ce înseamnă dacă vezi altceva (și, la mulți pași, dacă e o problemă sau doar o regulă).

Regulă generală pentru **toată** verificarea: orice mesaj în engleză, orice text tehnic (de exemplu „Error”,
„TypeError”, „Prisma”, „500”, „undefined”, „[object Object]”) sau o pagină albă este o **problemă**, chiar dacă
pasul „a mers”. Notează-l.

Parolele le alegi tu la rulare. Nu le scrie în fișiere, în acest ghid sau într-un mesaj.

---

## Ce NU se poate verifica manual acum (sari peste, nu sunt defecte)

Ca să nu pierzi timp, iată ce lipsește sau ce nu are încă interfață. Pașii de mai jos nu le cer.

| Ce | De ce îl sari |
| --- | --- |
| Pagina **Setări** din admin | E încă un loc gol („Secțiune în construire”). Setările de care avem nevoie (lista de domenii pentru imagini, flag-ul pentru fișe explodate) le schimbi din **Prisma Studio**, la pașii de pregătire. Limitele de autentificare (câte încercări, câte minute) nu au deloc interfață: nu le poți modifica din browser și nu le testăm. |
| **Magazinul public** (vitrina) | Nu există încă (Faza 7). „Doar produsele Active apar în magazin” nu se poate vedea; vezi doar starea în admin. |
| **Jurnalul de audit** din meniu | Pagina e „în construire”. Auditul îl citești direct în Prisma Studio, tabela `AuditLog`. |
| **Cantitățile de stoc** | Vin în Faza 5. Tabul „Stoc” al produsului are doar „Disponibilitate” (în stoc / epuizat / la comandă). |
| **Descrierea cu text îmbogățit** (bold, tabele, imagini în descriere) | E planificată înainte de Faza 6 (punctul 15c). Acum descrierea e **text simplu**; HTML-ul din WooCommerce se reduce la text la import (e normal). |
| **Butonul „Oprește importul întrerupt”** | Capacitatea există pe server (după reparațiile de securitate), dar butonul din interfață nu a fost adăugat. Nu poți opri un import blocat din browser. |
| **Ștergerea unei categorii care are mapări către canale (eMAG)** | Mapările către canale nu au încă interfață, deci refuzul nu se poate provoca manual. A fost verificat doar prin teste automate. |
| **Câmpurile de dată-oră ale promoției** (`Promoția începe` / `se termină`) | Folosesc câmpul nativ al browserului, în limba browserului (datorie cunoscută, pentru Faza 17/18). Nu e un defect nou. |
| **Blocarea unui cont din alt calculator / de la alt IP** | Pe calculatorul tău aplicația nu cunoaște adresa clientului (setarea `trustedProxyHops` este 0), deci nu poți simula doi atacatori diferiți. Se testează automat (teste cu Redis real). La pasul 16.4 vezi ce se poate vedea local. |
| **Apăsarea lui „Mută mai sus / mai jos” de către doi administratori deodată** | Cu un singur om nu apare. Poziția se calculează pe lista de pe ecran; e o limitare cunoscută (urmează în Faza 7), nu o problemă a verificării. |

---

## 0. Pregătirea

### 0.1 Serviciile

1. Docker Desktop pornit. În rădăcina proiectului (PowerShell):

   ```powershell
   docker compose -f docker/docker-compose.dev.yml up -d
   ```

   **Vezi:** `docker compose -f docker/docker-compose.dev.yml ps` arată postgres, redis, minio, mailpit „healthy”.
   **Dacă nu:** pornește Docker Desktop și repetă.

2. **Repornește serverul de dezvoltare o dată, acum.** După reparațiile de securitate din ultima etapă, partea de
   fundal (importul mare, descărcarea imaginilor, curățarea conturilor) se încarcă doar la pornire. Oprește
   fereastra în care rulează `dev:web` (Ctrl+C) și pornește din nou:

   ```powershell
   npm.cmd run dev:web
   ```

   **Vezi:** <http://localhost:3000/api/health> răspunde cu starea „ok” pentru baza de date și Redis.
   **Dacă nu:** Docker nu e pornit sau `.env` lipsește.

3. Pentru emailurile de verificare ale conturilor de test (pasul 0.4), într-un al doilea terminal, o singură dată:

   ```powershell
   npm.cmd run dev:mail
   ```

   Mesajele se văd apoi în <http://localhost:8025> (Mailpit).

4. Biblioteca de imagini are nevoie de stocare: `npm.cmd run storage:init` (nu strică dacă e deja făcut).

### 0.2 Datele de test (produse fictive)

1. Creează ~30 de produse „Demo”, cu variante, branduri, categorii, prețuri de achiziție și imagini generate:

   ```powershell
   npm.cmd run dev:seed-products
   ```

   **Vezi:** o linie de felul „Create: … produse fictive, 3 branduri, … categorii, … imagini.” Dacă le ai deja: „Produsele
   fictive există deja…”, e în regulă.
   **Dacă nu:** copiază mesajul de eroare în raport (secțiunea „Cum raportezi o problemă”).

2. **La sfârșit** (secțiunea 17) le ștergi cu:

   ```powershell
   npm.cmd run dev:seed-products -- --remove
   ```

   Comanda șterge doar ce a creat ea (adresă care începe cu `demo-`), nu produsele tale.

### 0.3 Contul Owner

Ai deja un cont Owner din fazele anterioare. Dacă nu: `npm.cmd run admin:create` (te întreabă emailul, numele și
parola; parola nu se vede la tastare, cel puțin 12 caractere).

Autentifică-te pe <http://localhost:3000/autentificare> cu Owner-ul. Păstrează fereastra aceasta pentru
secțiunile 1–15. Pentru conturile de test ai nevoie de o **fereastră privată** (sau alt browser) ca să nu te
deconectezi.

### 0.4 Conturile pentru testul de roluri (se fac o singură dată, ~10 minute)

Ai nevoie de trei conturi: **Editor**, **Suport** și **Manager**. Se creează ca niște clienți, apoi li se dă rolul din
Prisma Studio.

1. În fereastra privată: <http://localhost:3000/inregistrare>. Creează contul cu emailul `editor.test@example.test`,
   un nume (de exemplu „Editor Test”) și o parolă aleasă de tine, de cel puțin 12 caractere. Repetă pentru
   `suport.test@example.test` și `manager.test@example.test`. Poți folosi aceeași parolă la toate trei; ține-o minte.
2. **Vezi:** mesajul „Verifică-ți emailul”. Deschide <http://localhost:8025>, mesajul „Confirmă adresa de email”
   pentru fiecare cont, urmează linkul și apasă butonul. **Vezi:** „Email verificat”.
   **Dacă nu apare niciun email:** nu rulează `dev:mail` (pasul 0.1.3).
3. Pornește Prisma Studio (nu închide fereastra; oprește-o cu Ctrl+C la final):

   ```powershell
   npm.cmd run db:studio
   ```

   Se deschide în browser (de obicei <http://localhost:5555>).
4. Pentru fiecare cont, de trei ori:
   1. Tabela **User** → găsește rândul cu emailul contului → copiază valoarea din coloana `id`.
   2. Tabela **Role** → găsește rândul cu `key` = `editor` (apoi `support`, apoi `manager`) → copiază `id`.
   3. Tabela **UserRole** → „Add record” → lipește `userId` și `roleId` → „Save 1 change”.

   Asocieri: `editor.test` → `editor`; `suport.test` → `support`; `manager.test` → `manager`.
   **Vezi:** în `UserRole` apar 3 rânduri noi.
   **Dacă nu:** verifică să nu fi lipit `id`-urile invers (userId în loc de roleId).

   (În unele versiuni Prisma Studio numele de tabele apar cu litere mici și underscore, de exemplu `user_role`.)

### 0.5 Fișiere de care ai nevoie la îndemână

- Fișierul tău WooCommerce real: `local-data/woocommerce-export.csv` (din rădăcina proiectului).
- Un PDF mic oarecare (un manual, o factură veche) și un fișier text redenumit `fals.pdf` (creează un Notepad,
  scrie „test”, salvează ca `fals.pdf`).
- O imagine JPG/PNG de pe calculator.
- Excel instalat (pentru CSV și XLSX).

### 0.6 Două setări din Prisma Studio (fără interfață în admin)

**(a) Lista de domenii pentru imaginile din import** (o folosești la secțiunea 14):

1. Prisma Studio → tabela **Setting**. Dacă nu există rândul cu `key` = `imageImport.allowedHosts`, „Add record”:
   `key` = `imageImport.allowedHosts`, `group` = `imageImport`, `value` = `["piscineshop.ro"]` (cu paranteze
   pătrate și ghilimele duble), Save.
2. **Vezi:** rândul apare în tabelă. Setarea se citește imediat, fără restart.

**(b) Fișele explodate** (secțiunea 9) sunt oprite implicit:

1. Prisma Studio → tabela **FeatureFlag** → rândul cu `key` = `partsDiagrams` → bifează `enabled` = true → Save.
   Dacă rândul lipsește: „Add record”, `key` = `partsDiagrams`, `enabled` = true.
2. **Atenție:** flag-urile se rețin până la 5 minute. Dacă meniul „Fișe explodate” nu apare imediat, continuă cu alte
   secțiuni și revino.

---

## 1. Lista de produse: căutare, filtre, sortare, paginare

Deschide <http://localhost:3000/admin/produse> (Owner).

1.1 **Faci:** privește pagina. **Vezi:** titlul „Produse”, butoanele „Import produse” și „Produs nou”, butonul
„Exportă…”, selectorul de vedere „Produse / Coș de gunoi”, câmpul „Caută produse”, filtre (Categorie, Brand, Stare,
Clasă de livrare, Stoc, Sortare, Pe pagină) și un tabel cu imagine, produs, SKU, preț, stare, stoc, livrare, brand,
modificat. **Dacă nu:** dacă lista e goală („Nu există încă niciun produs”), nu ai rulat pasul 0.2.

1.2 **Faci:** scrie `Demo 01` în „Caută produse” și apasă „Caută”. **Vezi:** doar produsul (sau produsele) cu acest
nume. Încearcă apoi un SKU, `DEMO-003`. **Vezi:** produsul cu acel SKU. **Dacă nu:** căutarea ar trebui să găsească după
titlu, SKU, EAN sau cod producător.

1.3 **Faci:** apasă „Resetează filtrele”, alege Stare = „Ciornă”. **Vezi:** doar produse cu starea „Ciornă”.
Schimbă la „Arhivat”, apoi la „Toate”. **Dacă nu:** numărătoarea de sus („N produse”) trebuie să se schimbe cu filtrul.

1.4 **Faci:** alege Sortare = „Titlu A–Z”, apoi „Titlu Z–A”, apoi „Cele mai recente”. **Vezi:** ordinea se schimbă.
Alege „Pe pagină” = 25 și treci pe „Pagina următoare”. **Vezi:** „Pagina 2 din …” cu restul produselor.

1.5 **Faci:** filtrează după un Brand (de exemplu „Demo Hayward”), apoi după o Categorie. **Vezi:** doar produsele
care respectă ambele filtre. O căutare fără rezultat arată „Niciun produs nu corespunde căutării sau filtrelor.”

---

## 2. Produs nou, prețuri cu TVA, variante

2.1 **Faci:** „Produs nou”. Completează: Titlu `Pompă test 1`, SKU `TEST-001`, Preț `121`, alege un Brand, o Categorie
și Clasă de livrare „Standard”. Apasă „Creează produsul”. **Vezi:** ajungi în editorul produsului cu mesajul „Produsul a
fost creat. Completează restul datelor în taburile de mai jos.” și taburile General, Prețuri, Stoc, Categorii, Media,
SEO, Variante, Atribute, Asociate, Documente, Conformitate.
**Dacă nu:** dacă primești o eroare în engleză sau tehnică, notează-o.

2.2 **Faci:** tabul „Prețuri”. **Vezi:** „TVA: 21% (din setările magazinului)”, câmpul „Preț (lei, cu TVA)” cu `121,00`
și sub el **„Fără TVA (21%): 100,00 lei”**. Prețul introdus este exact ce vede clientul; TVA-ul se scoate din el.
**Dacă nu:** dacă „Fără TVA” nu este 100,00, calculul TVA e greșit: problemă.

2.3 **Faci:** la „Preț redus” scrie `150` și salvează. **Vezi:** eroarea „Prețul redus nu poate depăși prețul întreg.”
Schimbă la `99,50`, salvează. **Vezi:** „Modificările au fost salvate.” **Dacă nu:** orice altă formă a mesajului,
în engleză sau tehnică, e problemă.

2.4 **Faci:** în „Preț (lei, cu TVA)” scrie `abc` și salvează. **Vezi:** „Introdu o sumă validă, cu cel mult 2 zecimale
(ex. 199,50).” Rescrie `121`.

2.5 **Faci:** schimbă ceva (de exemplu Titlul) și apasă pe alt tab, apoi încearcă să ieși din pagină (săgeata
înapoi a browserului). **Vezi:** fereastra „Modificări nesalvate” cu „Rămân pe pagină” / „Ies fără să salvez”. Alege
„Rămân pe pagină”, apoi salvează.

2.6 **SKU duplicat.** **Faci:** „Produs nou”, alt titlu, dar același SKU `TEST-001`. **Vezi:** eroare în română despre
SKU folosit („Codul SKU e deja folosit de altă variantă.”). Nu se creează al doilea produs.

2.7 **Variante.** Deschide `Pompă test 1`, tabul „Variante”. **Faci:** în „Generator de variante”: „Numele opțiunii”
`Culoare`, „Valori” `Alb, Albastru`, „Preț pentru variantele noi” `121`. Apasă „Previzualizează”. **Vezi:** planul:
„2 variante noi” și, dacă există, „1 variantă fără opțiuni rămâne neatinsă”. Apasă „Creează variantele noi”.
**Vezi:** „Am creat 2 variante.” și în tabel rânduri cu SKU-uri generate. **Dacă nu:** generatorul nu trebuie să șteargă
nimic existent.

2.8 **Faci:** la o variantă apasă „Editează varianta …”, schimbă prețul, „Salvează varianta”. **Vezi:** „Varianta … a
fost salvată.”

2.9 **Faci:** șterge una dintre variantele noi („Șterge varianta …” → „Șterge varianta”). **Vezi:** „Varianta … a
fost ștearsă.” **Încearcă apoi** să ștergi toate variantele până rămâne una; la ultima: „Nu poți șterge ultima
variantă: un produs are nevoie de cel puțin una.”

2.10 **Faci:** tabul „Prețuri” al produsului cu variante. **Vezi:** un mesaj că prețurile se editează pe variante, cu
valorile doar pentru citire.

---

## 3. Prețul de achiziție (vizibil doar pentru rolurile permise)

Cu Owner-ul, produsul `Pompă test 1`, tabul „Prețuri”.

3.1 **Vezi:** secțiunea „Preț de achiziție (NIR, fără TVA)” cu explicația că nu apare în magazin, feed-uri sau
exporturi. **Dacă nu:** dacă Owner-ul nu o vede, e problemă.

3.2 **Faci:** „Preț de achiziție (lei, fără TVA)” = `80`, „Data intrării (NIR)” = data de azi, „Salvează prețul de
achiziție”. **Vezi:** „Prețul de achiziție a fost salvat.” și în „Istoric intrări” un rând nou (Data, Preț, Sursa „Manual”).

3.3 **Faci:** repetă cu `70` și o dată mai veche decât cea de la 3.2. **Vezi:** „Intrarea a fost înregistrată în istoric,
dar are o dată mai veche decât ultima: prețul curent nu s-a schimbat.” (Prețul curent rămâne 80.)

3.4 **Faci:** încearcă `abc`. **Vezi:** „Introdu o sumă validă (cel mult 2 zecimale) și o dată corectă.”

3.5 **Faci:** încearcă o sumă uriașă, `99999999`. **Vezi:** un mesaj în română (sumă invalidă / prea mare). **Dacă nu:**
dacă apare un text tehnic (de exemplu „Invalid prisma…”, „Unique constraint…” sau chiar suma într-un mesaj de eroare
nedecodat), notează-l și trimite captura: e exact ce am reparat.

---

## 4. Editare în listă și editare în masă

La <http://localhost:3000/admin/produse>.

4.1 **Editare directă.** **Faci:** la un produs apasă creionul de lângă titlu („Editează titlul pentru …”), schimbă
titlul, apasă „Salvează”. **Vezi:** „…: salvat.” și noul titlu în listă. Repetă pentru Stare și Stoc (creionul de lângă
valoare) și pentru Preț (suma, „Preț (lei, cu TVA)”). **Dacă nu:** pentru un produs cu mai multe variante prețul nu
se editează în listă („Prețul se editează pe variante”); asta e regula.

4.2 **Preț greșit în listă.** **Faci:** la editarea prețului scrie `12,345`. **Vezi:** „Introdu o sumă validă, cu cel
mult 2 zecimale (ex. 199,50).”

4.3 **În masă.** **Faci:** bifează 2 produse (pe SKU `DEMO-001` și `DEMO-002`; notează-le prețurile).
**Vezi:** bara „Acțiuni în masă” cu „2 produse selectate”. Alege „Ajustează prețul cu un procent”, scrie `10`,
„Aplică…”. **Vezi:** fereastra „Aplici modificarea la 2 produse?” cu „Prețurile (și promoțiile) se ajustează cu
10%. Prețul de achiziție nu se modifică.” Confirmă cu „Confirm și aplic”. **Vezi:** „Modificate: 2 produse.” și
prețurile cu aproximativ 10% mai mari (rotunjite la ban pe fiecare produs).
**Dacă nu:** dacă un preț nu s-a schimbat sau s-a schimbat altfel, notează valorile înainte/după.

4.4 **Faci:** același lucru cu `-10`. **Vezi:** prețurile revin aproximativ la valorile inițiale (pot diferi cu un ban,
din rotunjire).

4.5 **Faci:** încearcă `500`. **Vezi:** „Introdu un procent între -90 și 300.”

4.6 **Faci:** bifează 2 produse, alege „Schimbă starea” → „Ciornă” → confirmă. **Vezi:** „Modificate: 2 produse.”
Încearcă și „Adaugă într-o categorie” și „Schimbă brandul”. Fiecare acțiune cere o confirmare care spune că se aplică „tuturor
produselor selectate sau niciunuia”.

---

## 5. Categorii

<http://localhost:3000/admin/categorii>.

5.1 **Vezi:** arborele „Demo Piscine” cu subcategorii, fiecare rând cu adresa, „N produse” și „nivel N”.

5.2 **Faci:** „Categorie nouă”: Nume `Test A`, fără părinte, „Salvează”. Apoi `Test B` tot la rădăcină. **Vezi:** ambele în
arbore. Fără nume: „Numele categoriei e obligatoriu.”

5.3 **Faci (tastatură):** la `Test B` apasă „Mută … mai sus”. **Vezi:** `Test B` urcă deasupra lui `Test A`.
Apasă „Mută…”, la „Mută sub” alege `Test A`, „Mută”. **Vezi:** `Test B` devine subcategorie a lui `Test A`
(„nivel 2” și adresa de forma `/test-a/test-b`).

5.4 **Faci (glisare):** trage `Test B` pe zona din partea de sus „Trage aici pentru a muta la rădăcină” (apare cât
tragi) sau, dacă nu apare, folosește „Mută…” → „— La rădăcină —”. **Vezi:** `Test B` e din nou la rădăcină.
Apoi trage `Test A` peste `Test B`, în mijlocul rândului. **Vezi:** `Test A` devine subcategoria lui `Test B`.

5.5 **Mutare ilegală.** **Faci:** trage `Test B` (părintele) peste `Test A` (copilul lui). **Vezi:** „Nu poți muta
categoria acolo.” (o categorie nu poate intra în propriul copil). **Dacă nu:** dacă mutarea se face, e problemă.

5.6 **Redenumire.** **Faci:** „Editează” la `Test A`, schimbă numele în `Test A2`, „Salvează”. **Vezi:** „Salvat.” și
adresa/calea noului nume se vede și la subcategorii (calea copilului conține noua adresă).

5.7 **Ștergere refuzată.** **Faci:** „Șterge” la o categorie care are produse sau subcategorii (de exemplu `Test B` cu
`Test A2` în ea). **Vezi:** un refuz în română, cu număr („nu poate fi ștearsă”, „1 subcategorie” / „N produse”).

5.8 **Ștergere reușită.** **Faci:** șterge `Test A2`, apoi `Test B`. **Vezi:** dispar din arbore.

5.9 **Nume interzis.** **Faci:** „Categorie nouă” cu numele `A > B`. **Vezi:** un mesaj în română despre caracterele
„>” și „|” (separatoare din import/export).

---

## 6. Branduri

<http://localhost:3000/admin/branduri>.

6.1 **Faci:** „Brand nou”: Nume `Brand Test`, „Salvează”. **Vezi:** brandul în listă, cu 0 produse.

6.2 **Faci:** „Editează” → „Alege logoul” → alege o imagine din bibliotecă → „Salvează”. **Vezi:** logoul se vede la
editare. „Scoate logoul” îl elimină.

6.3 **Faci:** încearcă să creezi încă un brand cu același nume/adresă. **Vezi:** „Adresa e deja folosită de alt brand.”

6.4 **Faci:** „Șterge” la un brand cu produse (de exemplu „Demo Hayward”). **Vezi:** un refuz în română (fereastra de ștergere avertizează deja că „Un brand folosit de produse nu poate fi
șters”). Apoi șterge `Brand Test`: **vezi** că dispare.

---

## 7. Atribute

<http://localhost:3000/admin/atribute>.

7.1 **Faci:** „Atribut nou”: Nume `Diametru test`, Cod `diametru_test`, Tip „Număr”, Unitate `mm`, bifează „Filtrabil în
magazin”, „Creează atributul”. **Vezi:** „Atributul a fost creat.” și rândul cu unitatea și „nefolosit”.
Cod cu majuscule sau spațiu (`Diametru Test`): **vezi** „Codul începe cu o literă mică și conține doar litere mici, cifre și _.”

7.2 **Faci:** „Atribut nou” cu Tip „Listă”, Nume `Material test`, Cod `material_test`; la opțiuni inițiale scrie pe câte un
rând `Inox` și `PVC`. **Vezi:** „2 opțiuni”.

7.3 **Pe produs.** Deschide `Pompă test 1` → tabul „Atribute”. **Faci:** la „Diametru test” scrie `12,5` și salvează.
**Vezi:** „Modificările au fost salvate.” Scrie `abc`: **vezi** „Introdu un număr valid, cu cel mult 4 zecimale (ex. 12,5).”
La „Material test” alege „Inox”.

7.4 **Faci:** înapoi la Atribute: **vezi** „1 produs” la utilizare. Încearcă „Șterge atributul Diametru test”.
**Vezi:** refuz („Atributul e folosit pe produse și nu poate fi șters”). Deschide atributul: **vezi** că tipul nu se mai poate
schimba („Tipul nu se mai poate schimba: atributul are valori…”).

7.5 **Curățare:** în tabul Atribute al produsului lasă ambele câmpuri „— Nespecificat —”/goale, salvează; acum
atributele se pot șterge.

---

## 8. Imagini, documente, conformitate, SEO, produse asociate

Pe `Pompă test 1`.

8.1 **Imagini.** Tabul „Media” → „Adaugă din bibliotecă” → alege 2 imagini → confirmă. **Vezi:** prima are eticheta
„Principală”. Apasă „Mută … mai jos” pe prima: **vezi** ordinea schimbată („poziția 2 din 2”). „Scoate din produs”
elimină una; salvează. **Vezi:** „Imaginile au fost actualizate.”

8.2 **Document valid.** Tabul „Documente” → „Încarcă document”: alege PDF-ul, Tip „Manual”, „Încarcă”. **Vezi:** „Documentul
a fost încărcat.” și rândul în listă. „Descarcă” deschide/salvează fișierul (linkul expiră repede, e normal).

8.3 **Document fals.** **Faci:** încearcă `fals.pdf` (text redenumit). **Vezi:** „Tipul fișierului nu este acceptat. Poți
încărca PDF, PNG, JPEG sau WebP (tipul se verifică din conținut, nu din extensie).” Fără fișier: „Alege un fișier.”

8.4 **Editare document.** „Editează” → schimbă titlul → „Salvează”; **vezi** „Documentul a fost actualizat.” „Șterge documentul”
→ confirmă: **vezi** „Documentul a fost șters.”

8.5 **Conformitate.** Tabul „Conformitate”: alege o Clasă energetică, la „Link EPREL” scrie `http://exemplu.ro` și salvează.
**Vezi:** „Link-ul EPREL trebuie să înceapă cu https:// și să nu conțină spații.” Cu `https://eprel.ec.europa.eu/exemplu`
se salvează.

8.6 **SEO.** Tabul „SEO”: scrie un „Titlu SEO”. **Vezi:** contorul „N din … caractere recomandate” și previzualizarea.

8.7 **Produse asociate.** Tabul „Asociate”: tip „Accesorii”, caută `Demo 02`, „Adaugă: …”. **Vezi:** „Relația a fost
adăugată.” Deschide produsul asociat: la „Din alte produse către acesta” apare relația inversă.

---

## 9. Fișe explodate (cere pasul 0.6.b)

9.1 **Vezi:** în meniul din stânga „Fișe explodate” (dacă nu apare: aștepți până la 5 minute după pasul 0.6.b).
Deschide <http://localhost:3000/admin/fise-explodate>.

9.2 **Faci:** „Fișă nouă”: Titlu `Fișă test`, „Alege imaginea” din bibliotecă, „Creează fișa”. **Vezi:** editorul fișei cu imaginea.

9.3 **Faci:** „Adaugă hotspot”: număr 1, caută `Demo 01` și alege produsul, apoi apasă pe imagine pentru poziție,
„Salvează hotspot-ul 1”. **Vezi:** „Hotspot-ul 1 a fost salvat.” și un marcaj numerotat pe imagine. Alt hotspot cu același
număr: „Numărul e deja folosit de alt hotspot al fișei.”

9.4 **Faci:** în editorul fișei, la „Produse asociate fișei” caută și asociază un produs; apoi deschide acel produs →
tabul „Piese de schimb”. **Vezi:** fișa apare acolo.

9.5 **Faci:** „Șterge fișa” → confirmă. **Vezi:** fișa dispare; produsele rămân.

---

## 10. Coșul de gunoi, arhivare, duplicare, restaurare

10.1 **Duplicare.** În lista de produse, la `Pompă test 1` apasă „Duplică”. **Vezi:** „Copia „…” a fost creată ca ciornă.” și
nota că documentele, prețul de achiziție, stocul, EAN-ul, clasa energetică și linkul EPREL **nu** se copiază. SKU-urile copiei
au sufixul „-COPIE”.

10.2 **Arhivare.** Bifează copia → „Arhivează” → confirmă. **Vezi:** „Arhivat: 1 produs.” Filtrul Stare = „Arhivat” îl arată.
Bifează-l → „Dezarhivează”: **vezi** că revine ca ciornă.

10.3 **Coș.** Bifează copia → „Mută în coșul de gunoi” → confirmă. **Vezi:** „Mutate în coșul de gunoi: 1 produs.” și dispare din
lista normală. Apasă „Coș de gunoi” (în „Vedere”): **vezi** nota „Produsele din coșul de gunoi nu apar în magazin…” și
produsul cu „Șters la …”.

10.4 **Restaurare.** În Coș: „Restaurează” la produs. **Vezi:** „Restaurat: 1 produs.” și reapare în lista normală.

10.5 **Ștergere definitivă.** Mută din nou copia în coș; în Coș apasă „Șterge definitiv…”. **Vezi:** o fereastră care
enumeră ce se șterge odată cu produsul (variante, imagini, documente…) și cere să scrii adresa produsului. Scrie o adresă
greșită: **vezi** „Adresa tastată nu coincide cu a produsului. Nu s-a șters nimic.” Scrie adresa corectă și confirmă:
**vezi** „Produsul „…” a fost șters definitiv.”

---

## 11. Export CSV și XLSX (cu Excel)

11.1 **Faci:** în lista de produse (fără filtre) apasă „Exportă…”. **Vezi:** fereastra cu „Ce exporți” (selecție / filtre /
tot catalogul), „Include și produsele din coșul de gunoi”, Format CSV/XLSX. Textul spune că **prețul de achiziție nu se
exportă niciodată**.

11.2 **CSV.** Alege „Tot catalogul” și „CSV (pentru Excel)”, „Exportă”. **Vezi:** „Exportul a fost descărcat:
export-produse-AAAA-LL-ZZ.csv”. Deschide fișierul **cu dublu-click în Excel**. **Vezi:** coloanele **separate** (SKU, Titlu,
Preț…), nu lipite într-o singură coloană; diacriticele corecte (de exemplu „Mărime”, „Pompă”, nu semne ciudate precum „PompÄƒ”);
prima linie `sep=;` nu se vede în Excel. **Dacă nu:** dacă coloanele sunt lipite sau diacriticele sunt stricate, e o problemă
(notează versiunea de Excel).
**Verifică că NU există** nicio coloană de „Preț de achiziție” / „cost”.

11.3 **Zerouri la început.** Creează un produs cu SKU `00123` (Produs nou). Exportă din nou, **XLSX**. **Vezi:** în XLSX
SKU-ul este `00123`; în CSV deschis în Excel poate apărea `123` (de aceea textul de ajutor recomandă XLSX pentru coduri cu
zerouri). XLSX-ul are o a doua foaie „Despre export” și prețurile ca numere în lei.

11.4 **Doar selecția.** Bifează 2 produse, „Exportă…”, alege „Produsele selectate (2)”. **Vezi:** fișierul conține exact 2
produse. Fără nicio bifă, opțiunea scrie „(nu ai selectat niciunul în listă)”.

11.5 **Doar filtrele.** Filtrează după un brand, „Exportă…” → „Toate produsele care respectă filtrele curente (N)”. **Vezi:**
numărul de rânduri = N.

---

## 12. Import generic (șablon, mapare, verificare, aplicare, a doua rulare)

<http://localhost:3000/admin/produse/import>.

12.1 **Șablonul.** **Faci:** pe pasul „1. Fișier” alege „Șablon XLSX (recomandat)” (descarcă). Deschide-l în Excel.
**Vezi:** foaia „Produse” cu antetul (SKU, Titlu, Subtitlu, Descriere, Adresă (slug), Preț (lei, cu TVA), Preț promoțional…,
Categorii, Brand, EAN, …, Clasă de livrare, Stare) și două rânduri de exemplu (`POMPA-100`, `FILTRU-25`), plus foaia
„Instrucțiuni”. Descarcă și „Șablon CSV” și deschide-l cu dublu-click: coloanele trebuie să fie separate.

12.2 **Import cu erori.** Încarcă șablonul **neschimbat** (profil „Generic”), „Încarcă și analizează”.
**Vezi:** pasul „2. Mapare” cu coloanele potrivite singure. „Verifică (fără modificări)”.
**Vezi:** rezultatul verificării: rândurile cu **eroare** (categoria „Pompe > Pompe de circulație” și brandul „Hayward” nu
există la tine), cu motivul în română, și nota „Nu s-a modificat nimic în catalog.” Rândurile cu erori nu se aplică.
**Dacă nu:** dacă importul ar crea în tăcere categorii sau branduri inexistente, notează.

12.3 **Import corect.** În Excel, șterge conținutul coloanelor „Categorii” și „Brand” din ambele rânduri și salvează ca
`.xlsx`. Încarcă din nou, „Verifică”. **Vezi:** „Produse noi: 2”. „Aplică importul…” → „Confirm și aplic”.
**Vezi:** „Import terminat”. În lista de produse apar `POMPA-100` (1.299,00) și `FILTRU-25` (349,90).

12.4 **A doua rulare.** Încarcă **același fișier** din nou, aceeași mapare, „Verifică”. **Vezi:** „Neschimbate: 2”, „Produse
noi: 0”, și nota „Nu există nimic de aplicat”.

12.5 **Actualizare.** În Excel schimbă prețul lui `POMPA-100` în `1399,00`, salvează, încarcă, verifică. **Vezi:** „Actualizate: 1”
cu „Se schimbă: …preț…”. Aplică. **Vezi:** prețul nou în listă.

12.6 **Preț de achiziție nu intră.** În Excel adaugă o coloană nouă numită `Pret achizitie` cu o valoare, încarcă. **Vezi:**
la mapare coloana e marcată: „Pare să conțină prețul de achiziție sau date de furnizor. Nu se importă niciodată.” Dacă
încerci totuși să o alegi manual: „Prețul de achiziție nu se importă. Lasă coloana respectivă nemapată.”

12.7 **Fișiere greșite.** Redenumește un `.txt` în `.xlsx` și încarcă-l. **Vezi:** „Fișierul nu poate fi citit; pare
deteriorat.” (sau echivalentul în română). Fișier gol: „Fișierul este gol sau nu are rânduri de date.” **Dacă nu:** orice
text în engleză sau tehnic e problemă.

---

## 13. Import WooCommerce cu fișierul tău real

Fișierul `local-data/woocommerce-export.csv` are **8 produse** (toate simple). Dacă l-ai importat deja în verificările
anterioare, produsele vor apărea ca „Neschimbate/Actualizate” în loc de „Noi”; nu e o problemă. Pentru un test „de la
zero” poți muta întâi produsele în coș și le poți șterge definitiv (secțiunea 10), dar nu e obligatoriu.

13.1 **Faci:** la import alege profilul „WooCommerce (export de produse)”, încarcă `woocommerce-export.csv`,
„Încarcă și analizează”. **Vezi:** „Profil WooCommerce” cu „Rânduri după tip: 8 simple” (sau echivalent), coloanele
recunoscute singure.
**Dacă nu:** „Fișierul nu pare un export WooCommerce de produse…” înseamnă că ai ales fișierul greșit.

13.2 **Opțiuni.** **Vezi:** „Păstrează starea din fișier (publicat → activ)” **debifat** (produsele noi intră ca ciornă),
unitățile (kg, cm), corespondența claselor de livrare (Paletizat → Paletizat, Supradimensionat → Supradimensionat),
atributele din fișier cu opțiunea de a le crea sau ignora, și secțiunea „Imagini” (o folosești la secțiunea 14).
Lasă bifa pentru imagini **debifată** acum.

13.3 **Verificare.** **Faci:** continuă la „Verifică (fără modificări)”. **Vezi:** numărul de produse noi/neschimbate,
lista „Ce se creează odată cu produsele” (categorii, branduri, atribute de creat), „Alte constatări” (descrieri reduse la
text, tabele reduse la linii) și, dacă fișierul are coloane de cost sau furnizor, mesajul că sunt **BLOCATE** și nu apar
în raport. **Dacă nu:** dacă vezi sume de preț de achiziție în raport, e problemă gravă.

13.4 **Aplică.** **Faci:** „Aplică importul…” → „Confirm și aplic”. **Vezi:** „Import terminat”. În lista de produse
apar cele 8 produse (de exemplu `MSC210`, `MSC280`, `IBC18`) ca „Ciornă”; în Categorii apar ramurile create (de exemplu
„Incalzire piscina > Pompe de caldura”). Deschide un produs: titlu, preț cu TVA, clasă de livrare, descriere ca text
simplu.

13.5 **A doua rulare.** Reîncarcă același fișier cu aceleași opțiuni și verifică. **Vezi:** toate cele 8 „Neschimbate”,
„Nu există nimic de aplicat”. Nimic nu se dublează.

13.6 **Audit pe produs.** În Prisma Studio → tabela **AuditLog** → filtrează `action` = `product.create` (sau
`product.update`) pentru un produs importat și deschide `after`: **vezi** `importId` în conținut. Tot acolo există
un rând `product.import`. (Înainte de reparațiile de securitate importul lăsa doar acest rând-sumar.)
**Dacă nu:** dacă produsele importate nu au niciun rând propriu în `AuditLog`, notează.

---

## 14. Imagini din adrese (WooCommerce)

Cere pasul 0.6.a (lista de domenii) și internet. Serverul `dev:web` trebuie să fie pornit (descărcarea se face în fundal).

14.1 **Faci:** repetă importul din 13.1, dar la secțiunea „Imagini” **bifează** „Aduce imaginile din adrese, în fundal,
după ce produsele sunt create”. **Vezi:** „Fișierul conține N adrese de imagini: … pe domenii permise …, … pe alte
domenii (se vor respinge)” și lista „Domenii din fișier” cu `piscineshop.ro — domeniu permis` și alte domenii marcate
„domeniu NEPERMIS” (de exemplu `fluidra.bynder.com`, `webshop.aquachem.hr`) — **doar cele de pe domeniile permise se
descarcă**.
**Dacă nu:** „Lista de domenii permise este goală…” înseamnă că setarea din 0.6.a lipsește sau are altă valoare.

14.2 **Aplică.** **Vezi:** la final blocul „Imaginile din fișier” cu bara de progres și „Descărcate / Deja existente /
Eșuate / În așteptare”, apoi „Descărcarea s-a terminat.” Cele de pe domenii nepermise apar la „Imagini eșuate” sau în
raport cu motivul „Domeniu nepermis”.

14.3 **Faci:** deschide un produs → tabul „Media”. **Vezi:** imaginile atașate, prima „Principală”. Biblioteca media
(<http://localhost:3000/admin/media>) arată fișierele noi, trecând singure la „Gata”.

14.4 **A doua rulare.** Repetă importul cu aceeași bifă. **Vezi:** „Deja în bibliotecă / Deja atașate” și **nicio**
descărcare nouă.

14.5 **Reia imaginile.** Dacă la 14.2 au rămas imagini eșuate din motive de rețea, butonul „Reia imaginile” le
reîncearcă. (Butonul pentru oprirea unui import blocat nu există, vezi lista de la început.)

---

## 15. Istoricul importurilor și exporturilor

<http://localhost:3000/admin/produse/import/istoric> (sau linkul „Istoric importuri” din pagina de import).

15.1 **Vezi:** tabul „Importuri” cu importurile aplicate (Data, Utilizator, Fișier, Profil, Stare „Aplicat”, Rânduri,
Rezultat cu contoare noi/actualizate/neschimbate/cu erori). Un import doar verificat **nu** apare aici.

15.2 **Faci:** „Detalii” la un import. **Vezi:** sumarul, filtrul „Arată” (Toate / Cu erori / Ignorate / Noi / Actualizate)
și „Descarcă raportul (CSV)”. Deschide CSV-ul **cu dublu-click în Excel**: coloanele separate, diacritice corecte.

15.3 **Faci:** tabul „Exporturi”. **Vezi:** exporturile tale din secțiunea 11 (Data, Utilizator, Domeniu, Format, Rânduri,
Stare „Descărcat”), **doar numere**, nicio valoare din catalog.

---

## 16. Securitate vizibilă: roluri, blocare, mesaje

Folosește o **fereastră privată** pentru conturile de test; Owner-ul rămâne în fereastra normală.

### 16.1 Editor conținut (`editor.test@example.test`)

1. Autentifică-te. Deschide <http://localhost:3000/admin/produse>. **Vezi:** lista, cu nota „Poți edita titlul produselor.
   Prețul, starea, stocul și restul câmpurilor cer permisiunea de gestionare a produselor.” **Nu** vezi butoanele „Produs
   nou”, „Import produse”, „Exportă…”, nici caseta de acțiuni în masă.
2. Deschide un produs. **Vezi:** nota „Poți edita doar conținutul produsului (titlu, descriere, imagini, SEO). Prețul,
   stocul, livrarea, starea, brandul și categoriile sunt doar pentru citire.” Tabul „Prețuri” e doar pentru citire.
3. **Cel mai important:** în tabul „Prețuri” **nu există** secțiunea „Preț de achiziție (NIR, fără TVA)”. Nici în Variante,
   nici în altă parte nu apare vreun preț de achiziție. **Dacă îl vezi, e o problemă gravă.**
4. Editorul poate schimba titlul și SEO și salva. **Vezi:** „Modificările au fost salvate.”
5. Tastează manual în adresă `/admin/produse/nou` și `/admin/produse/import`. **Vezi:** „Acces interzis” / „Nu ai
   permisiunea necesară pentru această secțiune.”

### 16.2 Suport clienți (`suport.test@example.test`)

1. Autentifică-te. **Vezi:** meniul fără „Produse”, „Categorii”, „Branduri”, „Atribute”.
2. Tastează `/admin/produse`, `/admin/categorii`, `/admin/produse/import`. **Vezi:** de fiecare dată „Acces interzis”.

### 16.3 Manager (`manager.test@example.test`)

1. Autentifică-te, deschide un produs cu preț de achiziție (de exemplu `Pompă test 1`). **Vezi:** secțiunea de preț de
   achiziție **vizibilă**, dar cu „Ai voie să vezi prețul de achiziție, dar nu să îl modifici.” Nu poate salva.
2. **Vezi:** Managerul **poate** crea produse, importa și exporta (are `products.write` și `products.export`).

### 16.4 Încercări greșite de parolă

Se face cu un cont de test (`editor.test@example.test`), **nu** cu Owner-ul, într-o fereastră privată.

1. Pe <http://localhost:3000/autentificare> introdu emailul și parole greșite, una după alta. **Vezi:** „Email sau
   parolă incorecte.” la fiecare, același mesaj și pentru un email care nu există (nu se spune dacă contul există).
2. Continuă până primești: **„Prea multe încercări. Poți încerca din nou peste N minut(e).”**
   - Pe calculatorul tău adresa clientului nu e cunoscută (setarea `trustedProxyHops` este 0), deci pragul e de **15
     greșeli** și blocarea durează **cel mult 1 minut**.
   - Într-o instalare în spatele serverului web (cu valoarea 1) pragul este de **5 greșeli** și blocarea de **15 minute**,
     care se dublează la blocări repetate.
3. Cât timp contul de test e blocat, autentifică-te cu **Owner-ul** (alt email, aceeași fereastră sau alta).
   **Vezi:** merge imediat. Blocarea ține doar de emailul greșit (și de adresă), nu blochează alți utilizatori.
4. Așteaptă expirarea (sau rulează `npm.cmd run admin:unlock -- editor.test@example.test`). **Vezi:** „Contul … a fost
   deblocat”, apoi autentificarea cu parola corectă merge.
5. **Conectări reușite nu blochează:** autentifică-te corect și deconectează-te de 6–7 ori la rând. **Vezi:** nicio
   blocare (se numără doar greșelile).

   *Notă:* faptul că un străin **nu poate bloca contul Owner-ului de la o altă adresă** nu se poate simula pe un singur
   calculator; este verificat prin teste automate cu Redis real.

### 16.5 Mesajele erorilor

Parcurge câteva erori la întâmplare (SKU duplicat, preț invalid, fișier greșit, ștergerea unei categorii cu produse,
mutare ilegală) și confirmă că toate sunt în română și fără text tehnic. Deschide și o adresă care nu există, de exemplu
`http://localhost:3000/admin/produse/nuexista`. **Vezi:** o pagină de „nu s-a găsit”, nu un ecran cu eroare tehnică.

### 16.6 Auditul nu scurge costul

Prisma Studio → **AuditLog** → rândurile cu `action` = `product.cost.update`. **Vezi:** în `before`/`after` valoarea
prețului de achiziție apare ca **`[ascuns]`**, nu ca sumă. **Dacă vezi suma, e o problemă gravă.**

---

## 17. Curățenie

1. Produsele fictive: `npm.cmd run dev:seed-products -- --remove`. **Vezi:** „Șterse: N produse, N categorii, N branduri, N
   fișiere media.”
2. Produsele de test pe care le-ai creat tu (`Pompă test 1`, copii, `POMPA-100`, `FILTRU-25`, cel cu SKU `00123`): în
   lista de produse → coș → „Șterge definitiv…”. Produsele importate din WooCommerce le păstrezi sau le ștergi, după cum vrei.
3. Conturile de test (`editor.test`, `suport.test`, `manager.test`): le poți lăsa pentru verificări viitoare sau le
   ștergi din Prisma Studio (tabela `User`).
4. Oprește Prisma Studio (Ctrl+C în fereastra lui) și, dacă ai dezactivat fișele explodate pentru liniște, pune
   `partsDiagrams` înapoi pe false.

---

## Tabel de bifat

Pune **OK** sau **Problemă** și, la problemă, un cuvânt în „Observații” + referința pasului (de exemplu „2.3”).

| Secțiune | Ce verifici | Rezultat (OK / Problemă) | Observații |
| --- | --- | --- | --- |
| 0 | Servicii pornite, date demo create, conturi de test, setări din Studio |ok | |
| 1 | Listă, căutare, filtre, sortare, paginare |ok | |
| 2.1–2.6 | Produs nou, TVA extras corect, preț redus, SKU duplicat, modificări nesalvate |ok | |
| 2.7–2.10 | Generator de variante, editare/ștergere variantă, ultima variantă |ok | |
| 3 | Preț de achiziție (Owner): salvare, istoric, valori greșite cu mesaj în română |ok | |
| 4.1–4.2 | Editare directă în listă (titlu, stare, stoc, preț) |ok | |
| 4.3–4.6 | Editare în masă (procent, stare, brand, categorie) |ok | |
| 5.1–5.6 | Categorii: creare, mutare (tastatură și glisare), mutare ilegală, redenumire |ok | |
| 5.7–5.9 | Categorii: ștergere refuzată/reușită, nume interzis |ok | |
| 6 | Branduri: creare, logo, duplicat, ștergere cu produse |ok | |
| 7 | Atribute: creare, valori pe produs, tip blocat, ștergere refuzată |ok | |
| 8.1 | Imagini produs (adăugare, ordine, scoatere) |ok | |
| 8.2–8.4 | Documente: valid, fals refuzat, editare, ștergere |ok | |
| 8.5–8.7 | Conformitate, SEO, produse asociate |ok | |
| 9 | Fișe explodate (flag, creare, hotspot, asociere, ștergere) |ok | |
| 10 | Duplicare, arhivare, coș, restaurare, ștergere definitivă cu confirmare |ok | |
| 11 | Export CSV în Excel (coloane separate, diacritice, fără cost), XLSX, selecție, filtre |ok | |
| 12.1–12.5 | Import generic: șablon, erori, import corect, a doua rulare, actualizare |ok | |
| 12.6–12.7 | Cost nu se importă; fișiere greșite cu mesaj în română |ok | |
| 13 | Import WooCommerce (fișierul real): verificare, aplicare, a doua rulare, audit pe produs |ok | |
| 14 | Imagini din adrese: domenii permise/nepermise, progres, a doua rulare |ok | |
| 15 | Istoric importuri/exporturi, raport CSV în Excel |ok | |
| 16.1 | Editor: fără cost, fără butoane de import/export, refuz pe pagini |ok | |
| 16.2 | Suport: fără Produse, „Acces interzis” |ok | |
| 16.3 | Manager: vede costul, nu îl poate modifica |ok | |
| 16.4 | Blocare după greșeli: mesaj, nu blochează Owner-ul, deblocare |ok | |
| 16.5 | Toate erorile în română, fără text tehnic |ok | |
| 16.6 | Auditul arată `[ascuns]` la cost |ok | |
| 17 | Curățenie făcută |ok | |

**Rezultat general:** ☒ totul OK — pot confirma Faza 4 · ☐ am probleme (le-am trecut mai sus)

*Parcurs de utilizator și confirmat în chat la 2026-10-21: fără observații.*

---

## Cum raportezi o problemă

Pentru fiecare problemă trimite-mi:

1. **Numărul pasului** din ghid (de exemplu „2.3”) și ce te așteptai să vezi.
2. **Ce ai văzut de fapt**, cu textul exact copiat (dacă poți selecta textul, copiază-l; altfel o captură).
3. **Captura de ecran** a întregii ferestre a browserului (să se vadă adresa din bară și mesajul). La erori de formular,
   include și câmpurile completate (fără parole!).
4. **Contul** cu care erai autentificat (Owner / Editor / Suport / Manager).
5. Pentru **eroare tehnică sau pagină albă**: apasă F12 → tabul „Console” și trimite o captură cu liniile roșii; din
   terminalul în care rulează `dev:web` copiază ultimele ~20 de linii (nu conțin parole).
6. Pentru **probleme cu Excel**: versiunea de Excel, ce ai văzut (coloane lipite? semne ciudate în loc de diacritice?) și
   fișierul descărcat, dacă nu conține date private.
7. Pentru **import**: raportul descărcat („Descarcă raportul (CSV)”) și numele fișierului sursă (nu e nevoie să-mi trimiți fișierul
   dacă e cel din `local-data`).

**Nu trimite niciodată** parole, chei sau conținutul fișierului `.env`.
