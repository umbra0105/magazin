# Sistemul de design al panoului de administrare

Document **normativ**: orice ecran, componentă sau text vizual din admin îl respectă. Dacă o regulă de aici se contrazice cu skill-ul `frontend-design` sau cu o preferință a ta, **are prioritate acest document**; contradicția se raportează, nu se rezolvă în tăcere. Dacă se contrazice cu `CLAUDE.md`, are prioritate `CLAUDE.md` și se cere decizia utilizatorului.

Sursa: trei imagini de referință alese de utilizator (listă de comenzi, panou lateral de detalii, panou de ansamblu) și direcția generală a panourilor moderne de administrare (curat, plat, compact, tipografie neutră). Culorile de mai jos au fost **măsurate din imaginile de referință**, apoi ajustate acolo unde contrastul nu atingea WCAG AA. Nu s-au preluat valori de la alte platforme; sursa valorilor sunt imaginile de referință.

**Ce NU copiem:** numele, sigla și textele din imaginile de referință, steagurile, fotografiile de produs, harta, datele de exemplu și aranjamentul lor pagină cu pagină. Preluăm principiile și valorile de mai jos. Nu folosim numele altor platforme în interfață, cod sau comentarii.

## 1. Principii

1. **Plat și curat.** Fără umbre pe carduri și tabele, fără degradeuri, fără texturi, fără bordură dublă. Adâncimea vine din spațiu, din linii fine și din fundaluri foarte deschise.
2. **Culoarea înseamnă ceva.** Neutru pentru structură; negru-gri închis pentru acțiunea principală; albastru pentru legături, focus și informație; verde, portocaliu și roșu doar pentru stare (reușit, atenție, problemă). Nu se folosește culoare ca decor.
3. **Densitate de lucru.** Panoul se folosește ore întregi: rânduri de tabel de 48 px (40 px în varianta compactă), text de 14 px, fără spații goale decorative.
4. **Textul românesc e mai lung** decât cel englezesc (în medie cu 15–25%). Nicio etichetă nu se taie în tăcere: butoanele își măresc lățimea, celulele de tabel permit două rânduri, textul tăiat are `title` cu valoarea întreagă.
5. **Cifrele se citesc ușor.** Orice cantitate, preț, total sau contor folosește cifre tabulare (`font-variant-numeric: tabular-nums`) și se aliniază la dreapta în tabele.
6. **Același lucru arată la fel peste tot.** O stare „Neachitat" are aceeași culoare și formă în listă, în panoul lateral și în Panou.

## 2. Tokeni (singura sursă de valori)

Toate valorile trăiesc **o singură dată**, în UN singur fișier de tokeni al adminului: `packages/ui/src/styles/admin-tokens.css`, sub `[data-surface="admin"]`, cu paleta deschisă și cea închisă pe aceeași linie (`light-dark(deschis, închis)`), expuse prin Tailwind/`@ecom/ui`. **Nu există un „fișier de teme existent” în care să se adauge:** tema care există (`Branding`, 9 tokeni, servită de `/theme.css`) este a vitrinei; adminul este independent de ea (§2.4). Hex-urile sunt permise doar în fișierul de tokeni și în `presets.ts` (valorile implicite ale `Branding`). Componentele nu conțin niciun hex, nicio mărime în px și nicio umbră scrise direct. Un test de arhitectură pică la orice hex, la orice valoare arbitrară în px/rem/em (`[…px]`) și la orice `shadow-*` din afara tokenilor, în `apps/web` și `packages/ui`.

Numele sunt **semantice** (rol, nu culoare), ca să se poată schimba tema și brandul fără să se atingă componentele.

### 2.1 Culori, tema deschisă

| Token | Valoare | Folosire |
| --- | --- | --- |
| `--surface-page` | `#FFFFFF` | fundalul paginii, al barei laterale și al barei de sus |
| `--surface-canvas` | `#FFFFFF` (decis: fundal alb, ca în referințe) | fundalul din spatele zonelor „secțiune"; rămâne token separat, dar valoarea e albă; nu se trece la gri fără o decizie nouă a utilizatorului |
| `--surface-subtle` | `#F9F9F9` | antetul tabelelor, rândul de total, câmpuri dezactivate |
| `--surface-hover` | `#F2F2F2` | element de meniu activ sau cu cursorul deasupra, rând de tabel selectat |
| `--border-subtle` | `#EBEBEB` | linii între rânduri, între secțiuni, bordura barei laterale |
| `--border-control` | `#D4D4D4` | butoane secundare, selectoare de pagină |
| `--border-input` | `#8A8A8A` | marginea câmpurilor de formular (contrast 3,4:1, cerut de WCAG pentru componente) |
| `--text-primary` | `#1A1A1A` | titluri, text, valori |
| `--text-secondary` | `#616161` | etichete, anteturi de coloană, text de ajutor |
| `--text-placeholder` | `#6E6E6E` | text-model din câmpuri (4,5:1 și pe `--surface-subtle`; `#757575` dădea 4,38:1 acolo) |
| `--text-disabled` | `#B5B5B5` | doar pentru elemente dezactivate |
| `--action` | `#303236` | butonul principal (text alb pe el: 12,8:1) |
| `--action-hover` | `#1F2023` | cursor deasupra |
| `--action-pressed` | `#121315` | apăsat |
| `--action-fg` | `#FFFFFF` | textul de pe butonul principal (în tema închisă butonul e deschis, iar textul lui, închis) |
| `--link` | `#2A5BD7` | legături, tab activ la focus, inel de focus (5,9:1 pe alb) |
| `--on-brand` | `#FFFFFF` | text sau pictogramă pe fundal `--brand` (contoare) |
| `--scrim` | `rgba(0,0,0,0.40)` | fundalul întunecat din spatele panourilor laterale și dialogurilor |

Tema închisă (§9.9) se derivă din aceleași roluri, în același fișier, cu aceleași reguli de contrast (AA); un test citește fișierul și verifică fiecare pereche în ambele teme.

### 2.2 Culori de stare (perechi fundal + text, toate peste 5,5:1)

| Ton | Fundal | Text | Folosire |
| --- | --- | --- | --- |
| Neutru | `#F2F2F2` | `#4A4A4A` | neachitat, ciornă, inactiv |
| Informație | `#EFF3FF` | `#2A4FA8` | executat, în curs, informativ |
| Succes | `#E8F7EE` | `#1B6B43` | achitat, în stoc, reușit |
| Atenție | `#FFF3E0` | `#8A5300` | în așteptare, stoc mic, neactualizat |
| Problemă | `#FDECEC` | `#A62B2B` | rambursat, epuizat, eroare |

Culorile pastelate din imaginile de referință aveau text prea deschis (contrast sub 3:1 la portocaliu); aici textul e întunecat pentru a trece de AA. Fundalurile rămân cele pastelate din referință.

### 2.3 Culori pentru grafice și bara de stoc

Linii și segmente (contrast cel puțin 3:1 pe alb): verde-turcoaz `#089B94`, portocaliu `#C27400`, roșu `#D93A3A`, albastru `#2A5BD7`, gri `#8A8A8A`. Linia de comparație e **punctată**, nu doar de altă culoare. Umplerea de sub linia principală e un degrade de la 18% opacitate la 0 (singurul degrade permis). Cardurile de indicatori pot folosi fundalurile foarte deschise din referință, **numai ca fundal**, cu text în `--text-primary`: cyan `#ECFBFF`, verde `#F1FFF1`, indigo `#F4F7FF`, piersică `#FEF6F0`.

### 2.4 Brand (configurabil, pentru white-label)

Produsul este **white label**: nu are siglă și nici culoare de brand proprii. Sigla și numele din interfață aparțin magazinului care folosește platforma și se configurează de acesta (ecranul de setări vine la Faza 16).

- Din `Branding` vin în admin DOAR trei lucruri: `--brand` (culoarea `accent` a magazinului, separat pentru tema deschisă și cea închisă: inelul de focus, legăturile, contoarele), `logoUrl` și `storeName`. Restul paletei magazinului (inclusiv `primary`) nu atinge adminul: **butoanele rămân neutre** (`--action`). Schimbarea brandului nu atinge nicio componentă.
- **Gardă de contrast:** dacă brandul ales nu dă cel puțin 4,5:1 ca legătură pe `--surface-page` (și ca fundal pentru textul `--on-brand`; 3:1 ar fi minimul inelului de focus, acoperit de 4,5:1), adminul folosește valoarea implicită `--link` pentru acea temă. Garda e o funcție pură cu teste, nu o verificare vizuală.
- Locul sigliei din bara laterală (pătrat cu rază 12 px, 32 px) afișează `logoUrl` când există; până atunci (sau dacă imaginea nu se încarcă), un pătrat în `--action` cu inițiala numelui magazinului, cu `--action-fg`. Lângă siglă, numele magazinului (`general.storeName`), nu scris în cod.
- Nicio siglă, nume sau culoare din imaginile de referință nu se folosește.

### 2.5 Raze

| Token | Valoare | Folosire |
| --- | --- | --- |
| `--radius-sm` | 6 px | paginare, etichete mici, căsuțe bifare |
| `--radius-md` | 8 px | butoane, câmpuri, selectoare, element de meniu activ |
| `--radius-lg` | 12 px | carduri de indicatori, dialoguri, imagini de produs, siglă |
| `--radius-pill` | 999 px | stări (pastile), contoare, avatare |

### 2.6 Umbre (practic inexistente)

| Token | Valoare | Folosire |
| --- | --- | --- |
| `--shadow-none` | nicio umbră | carduri, tabele, secțiuni, bara laterală, bara de sus |
| `--shadow-popover` | `0 4px 16px rgba(0,0,0,.12), 0 0 0 1px rgba(0,0,0,.06)` | meniuri, liste derulante, tooltip |
| `--shadow-drawer` | `-8px 0 24px rgba(0,0,0,.08)` | panoul lateral de detalii |
| `--shadow-dialog` | `0 8px 32px rgba(0,0,0,.16)` | dialoguri |

Fără alte umbre. Nicio textură, imagine de fundal sau zgomot.

### 2.7 Spațiere (pas de 4 px)

`4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 56`. Margine de conținut: 24 px pe desktop, 16 px pe telefon. Între secțiuni: 24 px. Între câmpuri: 16 px. Înălțimea controalelor: 32 px (compact), 36 px (implicit, de la `md` în sus), 44 px pe telefon. **Textul câmpurilor (Input, Select, Textarea): 16 px pe telefon** (sub 16 px, iOS Safari mărește pagina la focus) **și 14 px de la `md` în sus.** **Textul butoanelor: 14 px la toate lățimile** (la 16 px, rândurile cu mai multe butoane depășeau ecranul de 375 px; înălțimea de 44 px pe telefon rămâne). Lățimea conținutului de formular: cel mult 880 px, centrat; tabelele ocupă toată lățimea.

### 2.8 Tipografie

- **Familie:** `Inter` (licență OFL 1.1), variabilă, **găzduită local** (fără Google Fonts și fără CDN la vizită: cerere externă la fiecare vizită, problemă GDPR). Alegerea fontului e **decisă de utilizator**, iar modul de livrare e **`next/font/google` existent** (`apps/web/src/lib/fonts.ts`, descărcat la build și servit de pe domeniul magazinului; subseturile `latin` 48.432 B și `latin-ext` 85.272 B, împreună ~131 KB), **fix pentru admin**, independent de fonturile din `Branding`; nicio dependență nouă. Dacă build-ul rulează la client sau fără rețea, se trece la fișiere woff2 locale cu `next/font/local` și `OFL.txt` (punct în Faza 21). Înainte de adoptare se verifică în browser că **ă â î ș ț Ă Â Î Ș Ț** se desenează corect, cu virgulă dedesubt la ș și ț (nu sedilă), și că nu apar glife de rezervă. Subsetul trebuie să includă Latin și Latin extins (inclusiv U+0218–U+021B).
- **Rezervă:** `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.

| Rol | Mărime / linie | Grosime |
| --- | --- | --- |
| Titlu de pagină | 22 / 28 px | 600 |
| Titlu de secțiune | 16 / 24 px | 600 |
| Text, celule de tabel | 14 / 20 px | 400 |
| Tabel compact | 13 / 18 px | 400 |
| Etichetă, antet de coloană, text de ajutor | 12 / 16 px | 500 |
| Cifre mari în carduri de indicatori | 28 / 32 px | 600 |

Fără majuscule forțate în afară de etichetele grupurilor din bara laterală (12 px, spațiere 0,04 em, `--text-secondary`). Fără text sub 12 px. Fără italic decorativ.

## 3. Componente de bază (în `@ecom/ui`)

Fiecare componentă are stările: implicită, cursor deasupra, focus (inel de 2 px `--brand`, decalaj 2 px, mereu vizibil la tastatură), apăsat, dezactivat, încărcare, eroare unde se aplică.

- **Buton principal:** fundal `--action`, text alb, rază 8 px, fără bordură și fără umbră. **Secundar:** fundal alb, bordură `--border-control`, text `--text-primary`. **Terț:** fără fundal, text `--text-primary`, fundal `--surface-hover` la cursor. **Pericol:** ca secundar cu text `#A62B2B`; confirmarea e un dialog propriu (fără `window.confirm`). Un singur buton principal pe ecran sau pe secțiune.
- **Câmp de formular:** înălțime 36 px, rază 8 px, bordură `--border-input`, etichetă deasupra (12 px, `--text-secondary`), text de ajutor dedesubt, eroare în ton Problemă cu pictogramă și text (culoarea nu e singurul semnal).
- **Pastilă de stare:** rază pill, fundal și text din perechile de la 2.2, text 12 px / 500, opțional un punct plin de 6 px în culoarea textului. Textul stării e mereu scris (nu doar culoare).
- **Contor:** pastilă mică în `--brand` cu text `--on-brand`. Componenta există; contoarele din bara laterală apar abia când există datele (§9.8).
- **Tabel:** antet `--surface-subtle`, rază 8 px pe capete, text de antet `--text-secondary` 12 px / 500, fără linii verticale, linii orizontale `--border-subtle`, rând 48 px (compact 40), coloana de selecție cu căsuță de bifare, coloane sortabile cu săgeată, cifrele la dreapta cu cifre tabulare, imagine de produs rotundă de 32 px sau cu rază 8 px, rândul selectat în `--surface-hover`. Un tabel care nu încape se derulează pe orizontală în propria regiune, sau devine listă de carduri acolo unde e mai citibil (se alege pe ecran și se notează în plan). Regula de bază e însă **prioritatea coloanelor** (mai jos): ecranele cu multe coloane nu derulează orizontal.
- **Prioritatea coloanelor (regulă pentru toate tabelele cu mai mult de 4–5 coloane, loturile 2–3 o reiau):** fiecare coloană are o prioritate, dată cu `priority` pe `Th` și pe toate `Td` ale ei (inclusiv rândurile de total): `primary` (mereu vizibilă), `secondary` (de la 48rem lățime de tabel), `tertiary` (de la 60rem) și `detail` (de la 68rem; pragurile de 60 și 68rem sunt containerele `@tier-3` și `@tier-4` din `globals.css`). Se măsoară **lățimea tabelului**, nu a ferestrei (regiunea tabelului e container numit `table`, clasele `@3xl/table:` și `@5xl/table:`), pentru că bara laterală de 240 px și marginile paginii îi iau din lățime: la fereastră de 1024 px tabelul are ≈736 px, la 1440 px ≈1152 px. Coloanele `primary` sunt cele fără de care rândul nu se înțelege (identitatea rândului, valoarea principală, starea, acțiunile); `detail` sunt cele care se pot citi și în altă parte (de exemplu în pagina de istoric a variantei). O coloană nu se ascunde fără ca informația ei să rămână la un clic distanță. Fără `min-w-*` pe tabel. Sub 42rem de tabel (telefon) tabelul poate trece în **modul stivuit** (`<Table stacked>`, opțional): fiecare rând devine un card, cu antetul rămas doar pentru cititoarele de ecran. Locul fiecărei celule în card îl dă `stack` pe `Td` / `RowHeader`: `title` (pe toată lățimea, capul cardului: numele, cu SKU-ul dedesubt rupt doar la marginea cardului), `inline` (implicit; pe aceeași linie cu celelalte, de exemplu «Disponibil» și pastila de stare) și `actions` (ultima linie, pe toată lățimea, butoane de 44 px, «Ajustează» cu text). Coloanele ne-principale nu apar în card (detaliile rămân în pagina rândului); celulele goale dispar, cifrele merg la stânga. Cardul are ≈128 px când numele are o singură linie. Tabelele care nu cer `stacked` nu se schimbă (derulează în regiunea lor). Rolurile ARIA (table, rowgroup, row, columnheader, rowheader, cell) sunt explicite pe componente, ca semantica să rămână și când se schimbă `display`. Rândul normal are cel mult 56 px când numele are un singur rând: celulele numerice nu se rup (`whitespace-nowrap`, cifre tabulare), explicația de sub valoare e o singură linie de 12 px (data scurtă «la 09.11, 09:43», cu data întreagă în `title`), iar acțiunile secundare sunt butoane doar cu pictogramă (`size="icon"`, cu `aria-label` și `title`); doar acțiunea principală a rândului rămâne cu text. Exemplu: Stoc (Produs, Disponibil, Stare, Acțiuni mereu; Fizică de la 48rem; Unitate și pas, Angajat, Rezervat, Rest nevandabil de la 64rem).
- **Tab-uri (vederi salvate):** text 14 px, cel activ cu text `--text-primary` și linie de 2 px dedesubt; celelalte `--text-secondary`. Aceleași clase (`tabClass`, `TAB_LIST_CLASS`) le au și vederile unei pagini desenate ca legături (`<nav>` cu `aria-current`, fiecare vedere cu adresa ei), de exemplu «Toate variantele» / «Stoc mic (N)».
- **Paginare:** selector „rânduri pe pagină" în stânga; în dreapta butoane de 32 px cu rază 6 px, pagina curentă cu bordură `--text-primary`. Numerele de pagină (cel mult 7 poziții, cu «…») se văd de la `md` în sus; pe telefon rămân doar «înapoi», rezumatul «Pagina 2 din 5» și «înainte», cu butoane de 44 px. Cu selectorul de rânduri pe pagină, bara rămâne și la o singură pagină (altfel nu te poți întoarce la mai puține rânduri). Componenta `Pagination` din `@ecom/ui` primește selectorul (`start`) și modul de a desena legăturile (`renderLink`).
- **Bară laterală:** lățime 240 px, pliabilă la 64 px (doar pictograme, cu etichetă la cursor; starea pliată se reține în `localStorage`, cu rezervă fără stocare), fundal alb, bordură dreaptă `--border-subtle`; element activ cu fundal `--surface-hover` și rază 8 px; grupurile cu etichetă mică deasupra; contoare albastre. Structura meniului **rămâne cea existentă** (grupul Catalog etc.); se schimbă doar aspectul.
- **Bara de sus:** înălțime 64 px. **Conține doar ce are funcție:** firimiturile, butonul de meniu pe telefon și meniul utilizatorului (avatar rotund). Căutarea globală (câmp cu fundal `--surface-subtle`, rază 8 px, pictogramă lupă) și clopoțelul cu contor rămân modelele lor de aspect, dar apar abia când există funcția și datele (§9.8), nu ca elemente moarte.
- **Panou lateral de detalii (drawer):** componenta se construiește în `@ecom/ui` (cu pagina de exemplu); ecrane noi pe drawer nu intră în redesign (§9.8). vine din dreapta, 480–560 px pe desktop, ecran întreg pe telefon, `--shadow-drawer`, fundal întunecat `--scrim`; antet cu săgeată înapoi, identificator, pastile de stare și acțiuni; secțiuni separate de linii `--border-subtle`; acțiunile principale fixate jos când conținutul derulează. Se folosește pentru consultare și editare rapidă din liste. Editarea completă a produsului rămâne pagină întreagă.
- **Card de indicator:** fundal pastelat din 2.3, rază 12 px, fără bordură și fără umbră, etichetă 12 px, cifră mare 28 px, variație cu săgeată **și** semn (+/−), graficul mic opțional; textul rămâne `--text-primary`.
- **Bară de stoc segmentată:** o bară de 6 px cu rază pill, segmente în culorile din 2.3, legendă dedesubt cu punct și număr. În Stoc și în Panou are patru segmente, cu **aceleași cuvinte și cifre ca cele trei carduri din vederea «Stoc mic»**: «În stoc», «Sub prag», «Doar rest nevandabil» (ton neutru) și «Epuizat»; eticheta «Stoc mic» nu apare în legendă (e numele tab-ului și al cardului din Panou). Invarianți: cele patru segmente însumează variantele gestionate, iar ultimele trei însumează numărul din «Stoc mic (N)» și din cardul Panoului.
- **Dialog:** rază 12 px, `--shadow-dialog`, `--scrim`, titlu, text, acțiuni la dreapta (secundar apoi principal), focus prins în dialog, închidere cu Esc.
- **Stări goale, încărcare, eroare:** schelet gri (`--surface-hover`) la încărcare, fără rotițe care ocupă tot ecranul; stare goală cu titlu, o frază și o singură acțiune; eroare cu pictogramă, text în română și o acțiune de reîncercare.
- **Notificări scurte (toast):** în dreapta jos, 4 secunde, cu buton de închidere; erorile rămân până sunt închise.
- **Pictograme:** un singur set liniar (grosime 1,5 px, 20 px), moștenesc culoarea textului. Nu se amestecă seturi.

## 4. Machete de pagină

1. **Pagină de listă** (Produse, Categorii, Branduri, Stoc, Media etc.): titlu cu număr între paranteze („Produse (1.234)"), tab-uri cu vederi, în dreapta bara de unelte (Filtrează, Exportă, acțiunea principală), tabelul, paginarea. Filtrele active se văd ca etichete eliminabile sub bară.
2. **Pagină de editare** (produs): titlu, acțiuni (Salvează principal, Anulează), secțiuni separate de linii și spațiu, o coloană de până la 880 px, bară de salvare lipicioasă cu „Modificări nesalvate". Taburile existente (General, Stoc, Prețuri etc.) se păstrează cu stilul de tab-uri de mai sus.
3. **Panou lateral de detalii** (consultare rapidă dintr-o listă).
4. **Panou de ansamblu:** rând de 3–4 carduri de indicatori, dedesubt grafic și liste, în două coloane pe desktop, o coloană pe telefon. Conținutul rămâne cel actual (contoare de stoc, sincronizare SmartBill); se schimbă aspectul.
5. **Autentificare și pagini de eroare:** aceleași reguli, centrate, fără cadru de carduri umbrite.

## 5. Mișcare

Tranziții de 120–180 ms (`ease-out`) pentru culoare, fundal și poziția panourilor. Fără animații de intrare decorative. Se respectă `prefers-reduced-motion`: panourile apar fără alunecare.

## 6. Accesibilitate (obligatoriu, nu opțional)

- Contrast AA: 4,5:1 pentru text, 3:1 pentru margini de câmp, pictograme și segmente de grafic.
- Tot ce se poate face cu mouse-ul se poate face din tastatură; ordine logică a focusului; focus vizibil peste tot; Esc închide dialoguri și panouri.
- Țintă tactilă de cel puțin 44 px pe telefon.
- Starea nu se transmite doar prin culoare (text, pictogramă sau semn alături).
- Etichete și nume accesibile în română pentru toate controalele; tabele cu antete asociate corect.
- Mărirea textului la 200% nu rupe machetele.

## 7. Reguli pentru cod și pentru viitor

- Valori doar din tokeni; hex, px și umbre scrise în componente sunt interzise (test de arhitectură).
- Orice componentă nouă se construiește în `@ecom/ui` și are o pagină de exemplu cu toate stările.
- Orice ecran nou se verifică cu capturi la 1440, 1024 și 390 px lățime și cu textul românesc real (nu cu text-model scurt).
- Dacă o cerință de produs nu are model în acest document, se propune o extindere a documentului **cu captură înainte** de implementare; nu se improvizează local.
- Pagina de exemplu cu toate stările componentelor există **doar pentru dezvoltare**: fișier `*.e2e.tsx`, rută doar când `NODE_ENV` nu e `production` sau `E2E_HARNESS=1`; un test dovedește că într-un build de producție nu există, iar la Faza 21 nu intră în pachet (ca scripturile dev-only).
- Schimbările de aspect nu schimbă comportamentul: testele E2E rămân verzi; o selecție după text sau rol care se rupe din motive vizuale se repară în test, motivat în commit.
- Widget-urile native (`datetime-local`, `date`, `type="number"`, `<select>`) rămân datoria deja notată; se tratează la Faza 17/18, nu aici.

## 8. Cum se aplică (punctul „Redesign admin")

1. Claude Code citește integral acest document, `SKILL.md` pentru `frontend-design` și `CLAUDE.md`; raportează contradicțiile; propune planul, **fără cod**.
2. **Lot 0, fundația:** tokenii, fontul, componentele din `@ecom/ui`, bara laterală și bara de sus, pagina de exemplu cu toate stările.
3. **Lot 1:** Panou și Stoc (ecranele cele mai recente), plus bara de stoc segmentată.
4. **Lot 2:** Produse (listă, panou lateral, editare).
5. **Lot 3:** Categorii, Branduri, Atribute, Unități de măsură, Media, Import/Export, Depozite, Fișe explodate.
6. **Lot 4:** autentificare, stări goale, erori, notificări.
7. După fiecare lot: capturi (desktop 1440, 1024, telefon 390), verificare completă citită integral (unitare, integrare pe ambele baze, E2E complet), utilizatorul verifică în browser, push, „CI verde".

## 9. Decizii luate de utilizator (2026-11-06)

1. **Fundal de pagină:** alb, ca în referințe (`--surface-canvas` = `#FFFFFF`). Stilul cu fundal gri și carduri albe nu se folosește.
2. **Font:** Inter. Rămâne de aprobat doar modul de livrare (secțiunea 2.8) și proba cu diacritice.
3. **Siglă și brand:** nu există siglă sau culoare de brand ale produsului; platforma e white label. Sigla, numele și culoarea de brand sunt ale magazinului care o folosește (secțiunea 2.4).
4. **Tema închisă:** dacă există deja în admin, se păstrează, iar valorile ei se derivă din rolurile semantice de mai sus (cu contrast AA obligatoriu); nu e prioritate vizuală în acest punct.

Nu mai există decizii deschise. Orice schimbare a acestor puncte se face doar prin decizie nouă a utilizatorului, notată aici.

### Decizii luate de utilizator (2026-11-09, la aprobarea planului de la Pasul 0)

5. **Adminul este independent de paleta magazinului.** Butoanele rămân neutre. Din `Branding` vin doar `--brand` (`accent`, pentru focus, legături, contoare), `logoUrl` și `storeName`, cu gardă de contrast (§2.4). Vitrina își definește valorile din `Branding`, sub propria suprafață.
6. **Excepție în `CLAUDE.md` pentru hex:** un singur fișier de tokeni al adminului (`packages/ui/src/styles/admin-tokens.css`, sub `[data-surface="admin"]`, paleta deschisă și cea închisă) și `presets.ts`; testul de arhitectură interzice hex, `[…px]` și `shadow-*` în rest.
7. **Font:** varianta A (`next/font/google` existent, Inter fix pentru admin, nicio dependență nouă); varianta B (woff2 local + `OFL.txt`) la Faza 21 dacă build-ul rulează la client sau fără rețea.
8. **Funcționalitate nouă, în afara redesignului**, fiecare la faza care are datele: căutarea globală, clopoțelul, contoarele din bara laterală, vederile salvate, variațiile și graficele, ecrane noi pe drawer. Intră în redesign: componenta drawer, bara laterală pliabilă cu stare reținută (Lot 0, doar interfață), sigla și numele magazinului în bara laterală cu inițială ca rezervă (Lot 0), bara lipicioasă de salvare peste logica existentă „modificări nesalvate” (Lot 2). Fără elemente moarte pe ecran.
9. **Tema închisă:** se păstrează meniul Sistem / Luminos / Întunecat, `localStorage` și scriptul inline din `<head>` (singurul `dangerouslySetInnerHTML` permis alături de `RichText`); valorile închise sunt derivate din rolurile semantice, cu AA.
