# Faza 5 — verificare manuală cap-coadă (Stoc)

Ghid pentru cine verifică Faza 5 **fără să fie programator**, în aproximativ o oră. Fiecare punct al fazei (1–13) a fost deja
verificat de tine când s-a livrat; aici NU repeți acele verificări, ci parcurgi **drumul întreg al unui stoc**, de la configurare
la alertă, cu cele 6 produse-model din plan ca fir roșu. Dacă un pas arată altfel decât scrie, notezi numărul lui în tabelul de la
sfârșit.

Cum citești un pas: **Faci** = ce apeși sau rulezi · **Vezi** = ce trebuie să apară · **Dacă nu** = ce înseamnă.

Regulă generală: orice mesaj în engleză, orice text tehnic („Error”, „undefined”, „500”, „[object Object]”) sau o pagină albă este o
**problemă**, chiar dacă pasul „a mers”. Pe telefon (sau fereastra îngustată) nu trebuie să apară derulare orizontală a paginii.

Parolele le alegi tu. Nu le scrie în fișiere sau în mesaje.

---

## Ce NU se poate verifica manual acum (sari peste, nu sunt defecte)

| Ce | De ce |
| --- | --- |
| Rezervarea la plată, expirarea ei, angajarea la plasarea comenzii | Coșul și plata vin în Fazele 9–10. Aceste mecanisme sunt apărate de teste pe Postgres real (concurență inclusă) și de demonstrațiile din terminal de la pasul 5 |
| Formularul «Anunță-mă când revine» din vitrină | Vitrina și ruta publică vin în Faza 7 (textul GDPR în Faza 18). Pasul 6 verifică de la cerere până la email, cu un script |
| Emailul «sincronizarea SmartBill e neactualizată» | Vine în Faza 11. Acum alerta se vede în banner și în Panou, iar jobul scrie în audit |
| Sincronizarea automată din SmartBill (API) | Faza 13/15. Acum cantitățile vin din exportul «Stoc la zi», încărcat de mână |
| Un CSV de descărcat din zona Stoc | Zona Stoc nu generează CSV (importul citește `.xls` / `.xlsx`). Coloanele de stoc din exportul de produse le-ai verificat la punctul 9b |
| Datele calendaristice cu selector nativ (`datetime-local`), lista deschisă a `<select>` | Datorie cunoscută, de tratat în Faza 17/18 |

---

## 0. Pregătirea

1. Docker Desktop pornit, apoi, în rădăcina proiectului:

   ```powershell
   docker compose -f docker/docker-compose.dev.yml up -d
   ```

2. **Repornește dev serverul o dată** (Ctrl+C în fereastra lui, apoi `npm.cmd run dev:web`): pe parcursul fazei s-a schimbat nucleul, iar
   singletonurile păstrează codul vechi. **Vezi:** <http://localhost:3000/api/health> răspunde „ok”.
3. Într-un al doilea terminal pornește emailul de probă (`npm.cmd run dev:mail`, mesajele apar în <http://localhost:8025>) și, într-un al
   treilea, **worker-ul** (`npm.cmd run worker`): fără el nu se trimit emailurile și nu rulează joburile de stoc.
4. **Produsele-model.** Mai întâi vezi dacă le ai deja: **Catalog → Stoc**, caută „demo stoc”.

   - **Dacă le ai deja** (cazul bazei tale de dezvoltare, create la verificările anterioare): **nu rula nimic** și treci la pasul 5.
     Scriptul `dev:seed-stock` nu face nimic când produsele există și nu poate nici să le șteargă pe cele cu mișcări de stoc
     (registrul e imuabil). Cantitățile pot fi diferite de cele din tabelul pasului 1, fiindcă le-ai ajustat între timp: contează
     **regulile** (pasul, disponibilul în pași, restul nevandabil), nu cifrele exacte. Baza ta nu are nicio sincronizare SmartBill, deci
     pasul 4 arată starea «Neimportat», nu «Neactualizat».
   - **Dacă nu le ai** (bază nouă), creează-le cu poza SmartBill **veche**, ca să vezi alerta «Neactualizat» la pasul 4:

     ```powershell
     npm.cmd run dev:seed-stock -- --poza=veche
     ```

     **Vezi:** „Au fost create 10 produse de stoc fictive (adresa demo-stoc-…)”.
5. Autentifică-te ca Owner pe <http://localhost:3000/autentificare>. Pentru pasul de drepturi (pasul 8) ai nevoie și de un cont **Editor**
   (îl ai din ghidul Fazei 4), într-o fereastră privată.

---

## 1. Cele 6 produse-model: unitate, pas și disponibil în pași

**Faci:** meniul **Catalog → Stoc**, caută „demo stoc”.

**Vezi,** pe fiecare rând: stocul fizic în unitatea produsului, **disponibilul în pași** și **restul nevandabil** (doar în admin). Tabelul
arată starea la crearea produselor; pe o bază deja folosită, cantitățile fizice pot diferi, dar disponibilul în pași și restul trebuie să
iasă din cantitatea afișată pe rând, cu pasul din a doua coloană:

| Produs | Unitate · pas | Stoc fizic | Disponibil în pași | Rest nevandabil |
| --- | --- | --- | --- | --- |
| Țeavă PVC-U | ml · 2,5 | 100 ml | 40 de pași (100 ml) | — |
| Liner placare | mp · 41,25 (rola) | 100 mp | **2 pași (82,5 mp)** | **17,5 mp** |
| Bisulfat de sodiu | kg · 25 (sacul) | 80 kg | 3 pași (75 kg) | 5 kg |
| Furtun de dozare | ml · 1 | 300 ml | 300 de pași | — |
| Mozaic placare | mp · 2,03 (cutia) | 10 mp | 4 pași (8,12 mp) | 1,88 mp |
| Lemn de abachi, 4 variante | ml · 1,5 / 1,8 / 2,1 / 2,6 | 10 ml fiecare | 6 · 5 · 4 · 3 pași | 1 · 1 · 1,6 · 2,2 ml |

**Dacă nu:** dacă o cifră diferă, notează produsul și cifra văzută. Virgula e separatorul zecimal peste tot („41,25”, nu „41.25”).

**Faci (prețul):** deschide **Liner placare** → tabul **Prețuri**, apoi **Bisulfat de sodiu**.
**Vezi:** la liner prețul pe mp și prețul rolei cu „≈” (suma nu iese exactă); la bisulfat „120,00 RON / sac de 25 kg” și, mai mic,
„(4,80 RON/kg)”, fără „≈”. Afișarea e marcată provizorie (rotunjirea o confirmă contabilul, vezi bilanțul).

**Faci (pasul refuză ce nu e multiplu):** la mozaic, tabul **Unitate și pas**, pune pasul `2,0301` (4 zecimale pe o unitate cu 2).
**Vezi:** mesaj în română la câmp, nimic salvat. Revino la `2,03`.

---

## 2. Ajustări și istoric

**Faci:** în **Stoc**, la Furtun de dozare apasă **Ajustează**, motiv **Vânzare în magazin**, cantitate `-10`, notă „proba mea”.
**Vezi:** dialogul se închide cu confirmare; fizicul scade cu 10 ml (de la 300 la 290, dacă produsul e neatins). Apasă **Istoric**: o
mișcare nouă, cu motivul, ora efectivă, „stoc după”, numele tău.

**Faci:** repetă cu o cantitate mai mare decât tot stocul, de exemplu `-1000`. **Vezi:** refuz în română („sub zero”), stocul rămâne cel de
dinainte. Motivul **Recepție marfă** nu primește cantitate
negativă. Lista de motive: Vânzare în magazin, Recepție marfă, Retur, Inventariere (corecție), Deteriorat, Pierdut/Furt, Alt motiv.

**Faci:** la Liner, ajustează cu `+0,5` (motiv **Recepție marfă**). **Vezi:** ajustarea nu cere să fie multiplu de pas (fizicul crește cu
0,5 mp, de exemplu de la 100 la 100,5 mp); disponibilul în pași rămâne la fel, iar restul nevandabil crește cu 0,5 mp (de la 17,5 la 18 mp,
dacă produsul e neatins). Corectează la loc cu `-0,5`, motiv **Inventariere (corecție)**.

---

## 3. Gestionat, negestionat, «La comandă», digital

**Faci:** deschide pe rând din **Catalog → Produse**: *Cartuș filtru* (negestionat), *Pompă de căldură* (La comandă), *Ghid de
întreținere* (digital), tabul **Stoc**.
**Vezi:** cartușul: „Negestionat până la inventar”, un dropdown de disponibilitate, **fără cantități**; pompa: „La comandă” cu termenul
în zile și de unde vine (produs, brand sau setarea magazinului); ghidul: doar o notă, fără controale de stoc. În **Stoc** niciunul dintre ele nu
are cantități.

Nu schimba nimic aici: trecerea gestionat / negestionat ai verificat-o la punctul 9a.

---

## 4. Alerte: stoc mic, prag, Panou, sincronizare veche

**Faci:** în **Stoc**, comutatorul **Stoc mic**.
**Vezi:** variantele epuizate sau la prag, cele mai urgente primele (pe produsele neatinse: *Pompa de căldură*, la 0, apoi *Clor tablete*
și *Liner placare*, la 2 pași, care e pragul implicit; dacă ai ajustat produsele, lista poate diferi, dar ordinea rămâne de la cele mai
urgente la cele mai puțin urgente); meniul nu are un element nou. Apasă **Prag** la o variantă din listă și pune `1`: dacă stocul ei
e de 2 pași, rândul iese din vedere (e peste prag); șterge pragul propriu (gol) și revine la setarea magazinului.

**Faci:** deschide **Panoul** (`/admin`). **Vezi:** secțiunea „Alerte de stoc” cu cardurile **Stoc mic**, **Doar rest nevandabil** și
**Sincronizare SmartBill**; fiecare duce în vederea potrivită din Stoc. Pe baza ta, fără nicio sincronizare, cardul spune
**Neimportat**, iar pe pagina Stoc bannerul spune „Stocul nu a fost încă importat din SmartBill. Cantitățile afișate sunt cele
introduse manual.” (Pe o bază cu poza veche, creată cu `--poza=veche`, ar fi **Neactualizat** și „Ultima actualizare: acum … Cantitățile
pot fi depășite.”) După importul de la pasul 7 starea devine **La zi**.

---

## 5. Rezervări, expirare și concurență (demonstrații din terminal)

Aceste două scripturi rulează pe baza de **test** (`ecom_test`), nu pe a ta, și își șterg datele la final.

1. `npm.cmd run dev:stock-race` — cereri deodată pe ultima bucată. **Vezi:** la fiecare scenariu, numărul de cereri care reușesc este
   exact cât permite stocul (niciodată mai multe), iar celelalte sunt refuzate.
2. `npm.cmd run dev:stock-jobs` — o rezervare cu termen de 12 secunde. **Vezi:** după expirare disponibilitatea revine **singură**; o
   poză veche produce o alertă o singură dată; cererile «Anunță-mă» vechi se șterg.

**Dacă nu:** copiază ultimele linii ale ieșirii.

---

## 6. «Anunță-mă când revine» (de la cerere la email)

**Faci:** în terminal, cu adresa ta de probă citită de la tastatură (nu se scrie pe linia de comandă și nu rămâne în istoricul
comenzilor; scriptul nu o afișează):

```powershell
$env:PROBE_EMAIL = Read-Host "Adresa de email pentru probă"
```

Scrie adresa la întrebare și apasă Enter. Variabila trăiește doar în această fereastră de terminal; folosește aceeași fereastră pentru
toate comenzile `dev:back-in-stock` de mai jos. Apoi:

```powershell
npm.cmd run dev:back-in-stock -- add DEMO-STOC-POMPA
```

Apoi, în admin, **Stoc**, la *Pompă de căldură* apasă **Ajustează**, motiv **Recepție marfă**, cantitate `3`.
**Vezi:** în Mailpit (<http://localhost:8025>), în cel mult ~2 minute, **un singur email** «Anunță-mă când revine». Dacă mai ajustezi o dată
(`+3`), nu mai vine altul: cererea s-a consumat. `npm.cmd run dev:back-in-stock -- status DEMO-STOC-POMPA` spune în ce stare e cererea.
Curăță: `npm.cmd run dev:back-in-stock -- clean DEMO-STOC-POMPA`, apoi șterge variabila din fereastră:

```powershell
Remove-Item Env:PROBE_EMAIL
```

Dacă *Pompa de căldură* nu mai e la 0 (ai ajustat-o într-o verificare anterioară), scriptul spune „Varianta se poate comanda deja, deci
nu s-a păstrat nicio cerere. Pune stocul la 0 (Admin → Stoc) și rulează din nou.”: coboară-o întâi la 0 cu o ajustare negativă (motiv
**Deteriorat** sau **Inventariere (corecție)**), apoi repetă comanda `add`. Emailul apare în Mailpit în cel mult ~2 minute (worker-ul
trebuie să ruleze).

---

## 7. Importul «stoc la zi» și pornirea gestionării

**Faci:** **Stoc → Import stoc la zi**; alege exportul tău real din `local-data/`, gestiunea setată, apasă **Verifică** (nu modifică nimic).
**Vezi:** raportul cu potrivirile pe SKU, necunoscutele (în ambele sensuri), unitățile diferite, rotunjirile și diferențele; ora pozei
(avertisment dacă lipsește ora). Aplică (cu bifa pentru ora pozei). Pe baza ta, fără nicio sincronizare, aplicarea creează prima poză; dacă
ai aplicat totuși exportul la punctul 12, rezultatul e «neschimbate», e în regulă. Produsele demo nu sunt în exportul real: **nu
confirma** punerea la 0 a variantelor gestionate care lipsesc din fișier, altfel le golești. **Vezi:** bannerul devine „La zi” (Actualizat acum …), cardul din Panou
la fel, iar în **Istoric** apar mișcările pozei. A doua rulare cu același fișier: „neschimbate”, fără mișcări noi.

**Faci:** în ecranul de import, legătura **Pornește gestionarea stocului**; încarcă același fișier.
**Vezi:** previzualizare cu variantele care se pornesc, cele fără potrivire în fișier, cele deja gestionate și cele care rămân
negestionate. Nu aplica pe catalogul tău real dacă nu vrei produsele gestionate; previzualizarea e suficientă pentru acest pas.

---

## 8. Drepturi

**Faci:** cu contul **Editor** (fereastra privată), deschide un produs → tabul **Stoc**; apoi încearcă `/admin/produse/stoc`.
**Vezi:** Editorul vede **starea** variantelor (în stoc / epuizat), **nu** cantitățile și nu are „Ajustează”; pagina **Stoc** îi dă „Acces
interzis” și meniul nu are „Stoc”. Cu Owner totul se vede.

---

## 9. Multi-depozit (steagul `multiWarehouse`)

Baza ta are deja un depozit în plus, **«Depozit test»**: îl folosești ca destinație și **nu mai creezi** un „Depozit secundar”. Dacă într-o
bază nouă nu există niciun al doilea depozit, creează unul după ce pornești steagul (**Catalog → Depozite**) și folosește numele lui.

**Faci,** steagul oprit (starea normală): **Catalog**. **Vezi:** nu există „Depozite”; în **Stoc**, `?depozit=oricare` nu schimbă nimic și
nu apar selector sau buton „Transferă”.

**Faci:** `npm.cmd run dev:flag -- multiWarehouse on` (fără repornire; schimbarea se vede la următoarea cerere).
**Vezi:** în **Catalog** apare ultimul element **Depozite**, cu „Depozit principal” (fără buton de dezactivare) și „Depozit test”. În
**Stoc** apare selectorul **Depozit**; alege „Depozit test”: lista se schimbă după depozitul ales, iar adresa conține `?depozit=…`.

**Faci:** notează cât mozaic (mp) are „Depozit principal” și cât „Depozit test” (poate fi 0 sau să nu apară deloc). Revino la „Depozit
principal”, la Mozaic apasă **Transferă**, destinația „Depozit test”, `2,03`.
**Vezi:** dialogul arată „Din depozitul …”, disponibilul din sursă (în pași) și pasul; `2,5` (nu e multiplu de pas) e refuzat cu mesaj în
română. La reușită: „Am mutat … din … în …”, iar în **Istoric** două mișcări legate (ieșire și intrare). Stocul din „Depozit principal”
scade cu 2,03 mp, iar în „Depozit test” crește cu 2,03 mp față de cât ai notat (pe un mozaic neatins, cu 10 mp în principal: 7,97 mp
rămân, iar disponibilul din sursă înainte de transfer era 8,12 mp = 4 pași).

**Faci:** `npm.cmd run dev:flag -- multiWarehouse off`. **Vezi:** meniul „Depozite”, selectorul și butonul „Transferă” dispar; stocul din
„Depozit principal” rămâne cel de după transfer (mutarea a avut loc, al doilea depozit nu se mai vede cât timp steagul e oprit).

---

## 10. Curățenie

1. `npm.cmd run dev:flag -- multiWarehouse off` (dacă nu l-ai oprit deja).
2. `npm.cmd run dev:seed-stock -- --remove`: șterge produsele fictive **fără mișcări**. Cele pe care ai făcut ajustări sau transfer
   (Furtun, Liner, Pompă, Mozaic) au mișcări și **rămân**: registrul de mișcări nu se șterge (e imuabil). Le poți arhiva din **Produse**.
   «Depozit test» rămâne și el (după transfer are stoc, deci nu se dezactivează); e inofensiv cât steagul e oprit.
3. Închide worker-ul și `dev:mail`.

---

## Tabelul tău

| Pas | Ce verifici | OK? | Observații |
| --- | --- | --- | --- |
| 0 | Pregătirea: servicii, repornire, worker, produsele fictive | | |
| 1 | Cele 6 produse: pași, rest, prețul pe unitate / pe pas, refuz de pas | | |
| 2 | Ajustări, istoric, refuz sub zero, fără pas la ajustare | | |
| 3 | Gestionat / negestionat / La comandă / digital | | |
| 4 | Stoc mic, prag, Panou, banner de sincronizare | | |
| 5 | Concurență și expirare (terminal) | | |
| 6 | «Anunță-mă»: un singur email | | |
| 7 | Import «stoc la zi» și pornirea gestionării | | |
| 8 | Drepturi: Editorul fără cantități | | |
| 9 | Multi-depozit: oprit = invizibil, pornit = selector și transfer | | |
| 10 | Curățenie făcută | | |

**Rezultat general:** ☐ totul OK — pot confirma Faza 5 · ☐ am probleme (le-am trecut mai sus)

---

## Cum raportezi o problemă

Pentru fiecare problemă trimite: **numărul pasului**, ce te așteptai, **textul exact** văzut (sau o captură a întregii ferestre, cu adresa
din bară), contul cu care erai autentificat și, la o eroare tehnică, ultimele ~20 de linii din terminalul `dev:web`. **Nu trimite
niciodată** parole, chei sau conținutul fișierului `.env`.
