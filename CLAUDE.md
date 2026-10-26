# Platformă eCommerce white-label

## Ce construim

Platformă de eCommerce în Next.js, cu storefront public și panou de administrare
complet, livrată ca PACHET INSTALABIL: o instalare = un magazin. Același cod rulează
pe mai multe instalări; branding, conținut și integrări diferă prin setări. Piața
țintă: România.

## Stack

- Node.js 24 LTS (minim 24.7.0: parolele folosesc `crypto.argon2` din Node), pnpm
- Next.js 15 App Router, TypeScript strict, React Server Components
- PostgreSQL + Prisma, Redis (cache/sesiuni/cozi), BullMQ
- Tailwind CSS + shadcn/ui, React Hook Form + Zod
- S3-compatible storage (MinIO local), React Email
- Vitest (unit/integrare) + Playwright (E2E)
- Docker Compose pentru dezvoltare locală

## Structura

- `apps/web` — aplicația Next.js: `(storefront)`, `(admin)`, `api`
- `packages/db` — Prisma schema, migrații, seed
- `packages/core` — logica de business (services, use-cases). **Fără React aici.**
- `packages/ui` — design system
- `packages/integrations` — adaptoare externe (plăți, curieri, facturare)
- `packages/jobs` — workers BullMQ
- `packages/shared` — tipuri, utils, erori
- `docs/` — specificațiile proiectului. Citește-le înainte de a lucra la o zonă nouă.

## Reguli obligatorii

### Configurabilitate (white-label) — regula #1 a proiectului

Acesta e un PACHET INSTALABIL: o instalare = un magazin. NU e multi-tenant, deci nu
există `tenantId`. În schimb:

- **Nimic hardcodat.** Numele magazinului, logo-ul, culorile, datele firmei, cotele
  de TVA, textele legale, expeditorul de email — toate vin din tabelele `Setting`
  și `Branding`, editabile din admin.
- Dacă scrii o culoare, un text de brand sau o valoare de business direct în cod,
  e un bug. Culorile vin din CSS variables generate din `Branding`.
- `.env` conține DOAR secrete și conexiuni (DB, Redis, APP_KEY, APP_URL, storage).
  Restul e în baza de date.
- Funcționalitățile opționale (blog, recenzii, wishlist, multi-depozit, loialitate,
  vouchere) sunt în spatele unui feature flag. `isEnabled('blog')` ascunde meniul,
  ruta ȘI codul.
- Accesul la date stă în servicii în `packages/core`, nu împrăștiat în componente.
- Personalizările pentru un client se fac prin setări, temă, blocuri CMS sau
  `/extensions`. **Niciodată prin modificarea core-ului.**

### Prețuri (citește docs/09-preturi-si-parteneri.md)

- Prețurile se stochează BRUT, cu TVA inclus, ca `int` în bani. `19900` = 199,00 lei.
  Ce tastează adminul e ce vede clientul. TVA-ul se EXTRAGE din brut pentru factură.
- Un singur preț public pentru toți. Grupurile de clienți au `pricingType`:
  `none` (Client standard: prețul public), `discount` (Client fidel 5%, VIP 7%:
  prețul public minus procentul) și `cost_plus` (Partener 1/2/3, adaos 12/17/21%).
  Procentele sunt editabile din admin; atribuirea în grup e manuală.
- `cost_plus`: `pret_brut = costNet × (1 + adaos) × (1 + TVA)`, unde `costNet` e
  `costPrice` (prețul NIR, FĂRĂ TVA, cel mai recent preț de intrare). Partenerul
  plătește MINIMUL dintre acest preț și prețul public curent (inclusiv promoția).
  Produs fără `costPrice` → prețul public. Procentele sunt `int` în puncte de bază.
- ⚠️ `costPrice`/`costPriceDate` și `CostPriceHistory` sunt DOAR pentru admin:
  niciodată în API public, props către componente client, storefront, feed-uri,
  `OrderLine.productSnapshot` sau loguri. Vizibile doar cu `products.cost.view`.
- Nu există comutator „cu/fără TVA" și nu există prețuri ascunse.
- Rotunjirea se face pe LINIE de comandă, o singură dată. Totalul e suma liniilor.
- Un singur motor de prețuri în packages/core/pricing, apelat din PLP, PDP, coș,
  checkout și factură. Niciun calcul de preț duplicat altundeva.
- Discountul de grup (`discount`) NU se cumulează implicit cu prețul promoțional (se
  ia cel mai mic), decât dacă grupul are `stacksWithSalePrice = true`. Cuponul SE
  cumulează, cu excepția cupoanelor marcate `notForDiscountedGroups` (care blochează
  orice grup cu `pricingType ≠ none`). `excludeFromGroupDiscount` se aplică ambelor tipuri.

### Fiscal, facturare și plăți (docs/10-decizii-deschise.md, Partea I)

- TVA: o singură cotă, 21%, pentru toate produsele (și digitale), din setarea
  `tax.standardRate`. Niciodată hardcodată; `TaxClass`/`TaxRate` rămân generice.
- Vânzare DOAR în România, pentru orice produs (`regional.allowedCountries`, implicit
  `["RO"]`). Fără OSS și fără taxare inversă în Val 1.
- Facturare: SmartBill (principal, prin `InvoiceProvider`; Oblio posibil mai târziu).
  Seria și numărul le definește SmartBill; e-Factura o transmite SmartBill.
  Emitere: card = la plata confirmată; transfer bancar = proformă, apoi factură după
  confirmarea adminului; ramburs = la plasare, cu storno dacă se întoarce; retur
  parțial = storno parțial. Înainte de Faza 13 citește documentația API SmartBill.
- Ramburs: limită 10.000 lei persoane fizice, 5.000 lei persoane juridice (CUI la
  facturare sau grup `cost_plus`), ambele configurabile în setări. Peste limită, metoda
  se ascunde.

### Stoc — model WooCommerce (citește docs/FAZA-5-plan.md)

- Setare globală `inventory.manageStock` (implicit ON) = valoarea implicită pentru
  produsele **noi**. Bifă per produs `manageStock` care o suprascrie. La produse cu
  variante, bifa poate coborî și la nivel de variantă. Importurile setează explicit
  `false` (inventarul îl face utilizatorul); produsele negestionate se văd în editor ca
  «negestionat până la inventar».
- `manageStock = true`: cantități reale, istoric imuabil de mișcări, alerte de stoc mic.
  **Disponibil = Fizică − Angajat − Rezervat** (niciodată sub 0). Cantitatea fizică vine
  din SmartBill (poză periodică, la început importul «stoc la zi»); aplicația ține
  «angajat» (comenzi online confirmate, încă neoglindite în poză) și «rezervat»
  (plăți în curs). **O bucată se scade o singură dată** (factură înainte de poză =
  oglindită, după poză = încă angajată).
- **Rezervarea (D4):** coșul NU rezervă nimic. Card: rezervare la inițierea plății, expirare
  15 minute (`inventory.reservationMinutes`). Ramburs: scade imediat la plasare. Transfer
  bancar: 3 zile lucrătoare, setabil. **Fără stoc negativ, garantat în baza de date**
  (CHECK ≥ 0 + rezervare dintr-o singură comandă SQL condiționată); concurența se testează
  pe Postgres real, în punctul care introduce rezervarea.
- `manageStock = false`: disponibilitatea e un simplu dropdown `stockStatus`
  (în stoc / stoc epuizat / la comandă). ZERO InventoryItem, zero rezervări,
  zero decrement. Ramură explicită în cod — NU simula cu o cantitate mare.
- **Stări vizibile (D6):** În stoc / Stoc limitat / La comandă (cu termen în zile) /
  Indisponibil. Termenul de livrare: pe produs, apoi implicit pe brand, apoi setarea
  globală. Hibrid: produsul gestionat devine «La comandă» la epuizare doar dacă
  `allowBackorder` e pornit (implicit oprit). «La comandă» nu are rezervare și nu are
  limită de cantitate. Coșuri mixte: livrare toată odată (termenul cel mai lung).
- **Cantități și unități (D11):** cantitatea e un întreg `BIGINT` cu 4 zecimale (zecimi de
  miime), niciodată `float`; aritmetica trece doar prin modulul `Quantity` din
  `packages/shared` (test de arhitectură). Cantitatea comandată e mereu multiplu EXACT
  al pasului de vânzare (pe produs sau pe variantă); disponibilitatea și pragurile se
  exprimă în pași; restul nevandabil se vede doar în admin. Regula de rotunjire (R1 pe
  unitate / R2 pe pas, PROVIZORIE până confirmă contabilul) aparține motorului de prețuri;
  în `packages/shared` stă doar primitiva exactă preț × cantitate, fără rotunjire.
- **O unitate nulă pe produs sau variantă înseamnă EXACT «buc»** (unitatea implicită, fără zecimale, de sistem):
  rezolvarea unității și comparațiile trec prin `effectiveMeasureUnit` / `sameMeasureUnit` (`inventory/units.ts`),
  iar în formulare alegerea «buc» se salvează ca „fără unitate”. «buc» nu se dezactivează, nu își schimbă codul și
  nu primește zecimale (validat în serviciu).
- O singură locație vizibilă, «Depozit principal» (redenumibilă); modelul multi-depozit
  rămâne în bază, în spatele flag-ului `multiWarehouse`.

### Produse digitale (docs/11-produse-digitale.md)

- Coșul poate fi fizic, digital sau MIXT. Transportul se calculează doar pe liniile
  fizice. Coș 100% digital = fără pas de livrare, fără ramburs.
- Accesul se acordă prin `DigitalEntitlement` la confirmarea plății și se revocă
  la rambursare. Linkurile sunt semnate, cu expirare scurtă — niciodată permanente.
- Bifa legală de renunțare la dreptul de retragere e SEPARATĂ de acceptarea
  Termenilor, neprebifată, obligatorie, și se salvează pe comandă.

### Loialitate și vouchere (docs/14-loializare-si-vouchere.md)

- Punctele se țin într-un registru imutabil (LoyaltyTransaction). Soldul se
  RECALCULEAZĂ din tranzacții, nu se editează direct niciodată.
- Reducerea din puncte intră ULTIMA în lanțul de reduceri, după cupon. Fără plafon
  procentual implicit (configurabil din admin). Transportul se plătește mereu în bani.
- ⚠️ Regula dură: suma de plătit în bani ≥ max(cost transport, `minCashAmount`, implicit
  1 leu). Comanda de 0 lei nu poate apărea; NU există ramură `loyalty_points`.
- Standard, Fidel și VIP acumulează puncte (discountul Fidel/VIP se cumulează cu ele);
  Partenerii NU (`earnsLoyaltyPoints = false`).
- ⚠️ Voucherul cadou NU e o reducere. E o METODĂ DE PLATĂ, alături de card și
  ramburs. Nu intră în motorul de prețuri și nu reduce baza de TVA.

### Nișa: echipamente pentru piscine (docs/15-specific-nisa-piscine.md)

- Produsele sunt grele și voluminoase. Costul de transport se calculează pe
  greutatea volumetrică ((L×l×h)/5000) sau pe cea reală, care e mai mare.
- Produsele `oversized` nu pot merge la easybox — ascunde opțiunea automat.
- Pompele de căldură și dezumidificatoarele au nevoie de etichetă energetică
  afișată înainte de finalizarea comenzii, nu doar în specificații.
- Atributele tehnice sunt numerice, cu unitate de măsură, și trebuie filtrabile
  pe interval (slider), nu doar pe valoare exactă.

### Canale de vânzare (docs/12-emag-marketplace.md)

- `Order.channelId` și `ChannelListing` există din Faza 4, chiar dacă eMAG vine
  mai târziu. `ean` și `warrantyMonths` sunt obligatorii pe variantă.

### Bani și taxe

- Sumele sunt `int` în bani (minor units). `1999` = 19,99 RON. Niciodată `float`.
- Un helper `Money` nu există încă. Calculul exact al **cantităților** e în
  `packages/shared/src/quantity.ts` (`Quantity`, fără rotunjire); motorul de prețuri și helperul de
  bani vin în Faza 8 (până atunci sumele sunt `int` în bani, iar TVA se extrage cu `vat.ts`).
  Rotunjirea se face pe linia de comandă, o singură dată (vezi „Prețuri"), nu pe total.
- TVA-ul se stochează pe linia de comandă (rată + valoare) și nu se recalculează
  retroactiv. Cotele vin din setări, nu sunt hardcodate.

### Comenzi

- Trei câmpuri de status separate: `status`, `paymentStatus`, `fulfillmentStatus`.
- Tranzițiile sunt validate de un state machine explicit. Fără `order.status = x` direct.
- Comanda păstrează un snapshot imutabil (produs, preț, TVA, adrese).
- Orice acțiune pe comandă scrie un `OrderEvent`.

### Cod

- TypeScript strict. Fără `any`, fără `@ts-ignore` fără explicație în comentariu.
- Validare Zod la marginea sistemului: formulare, API, webhook-uri, variabile de mediu.
- Logica de business în `packages/core`, apelabilă din server action, API, worker și test.
- Erori tipate (`DomainError`, `ValidationError`, `IntegrationError`) cu cod stabil.
- Server Components implicit; `"use client"` doar unde e strict necesar.
- Fără culori hardcodate în componente — doar CSS variables din tokens de temă.
- Toate scrierile din admin trec prin `auditLog()`.
- Webhook-urile: verificare semnătură + idempotență, întotdeauna.
- Side-effects (email, AWB, factură) prin queue, niciodată sincron în tranzacție.

### Fișiere CSV pentru Excel — regulă permanentă

- Orice fișier CSV destinat deschiderii în Excel (șablon, raport, export de produse, comenzi, clienți,
  facturi etc.) se generează în **UTF-16LE cu BOM (octeții `FF FE`), cu delimitator TAB și FĂRĂ linia
  `sep=`**, EXCLUSIV prin funcția comună (`toCsv` / `csvResponse` / `csvStreamResponse` din
  `packages/core/src/catalog/import/import-csv.ts`), cu antet în română. Nu se scrie CSV de mână în altă
  parte; testul de arhitectură `csv-generation` pică la orice ocolire și la orice linie `sep=` scrisă de aplicație.
- Orice import de CSV acceptă: UTF-16LE cu BOM (formatul de mai sus și «Unicode Text» din Excel), UTF-8 cu
  sau fără BOM, un CSV salvat din Excel (Windows-1250, separator «,», câmpuri în ghilimele) și linia `sep=` a
  fișierelor străine (`extractSepLine`); delimitatorul `;` `,` sau TAB se detectează.
- Motiv (dovedit în Excel 16.0 pe Windows, cu `scripts/excel-csv-probe.ps1`): o linie `sep=` face Excel să
  ignore BOM-ul UTF-8 și să citească diacriticele ca Windows-1252 («Adresă» → «AdresÄƒ»), deși octeții sunt
  corecți; fără ea, un CSV UTF-8 cu «;» are coloanele lipite pe un PC cu separatorul de listă «,», iar un CSV
  UTF-8 cu TAB nu are TAB-ul recunoscut. UTF-16LE cu BOM și TAB (Excel îl tratează ca «Unicode Text») dă
  diacritice corecte ȘI coloane separate. Nu se revine la UTF-8 cu `sep=` fără o nouă probă în Excel. Regula
  nu se mai reamintește: se aplică oriunde apare un CSV descărcabil.
- La fiecare punct cu un CSV descărcabil, în **👉 VERIFICĂ TU** intră pasul: «deschide CSV-ul cu
  dublu-click în Excel și vezi coloanele separate ȘI diacriticele corecte (de exemplu „Adresă”, „Preț”,
  „Șurub”, nu „AdresÄƒ”)». Pentru o verificare automată pe PC-ul cu Excel există `scripts/excel-csv-probe.ps1`
  (manual, în afara CI; nu schimbă setări și nu atinge un Excel deschis).

### Câmpuri de fișier — regulă permanentă

- **Nu se folosește niciodată `<input type="file">` direct.** Se folosește `FileInput` din `@ecom/ui`:
  câmpul nativ arată «Choose File / No file chosen» în limba browserului (nu în română) și e greu de
  distins pe fundal alb. `FileInput` păstrează câmpul real (ascuns vizual, dar accesibil de la tastatură,
  trimis în formulare, cu `ref`), cu buton vizibil și texte în română, iar fișierul ales și mărimea lui
  sunt într-o regiune `aria-live`. Testul de arhitectură `file-input` pică la orice câmp de fișier nativ.

### Fără widget-uri native în afara limbii aplicației — regulă permanentă

- În cod nou **nu se folosește `window.confirm` / `alert` / `prompt`** (butoanele și textele lor ies în limba
  browserului, nu în română): se folosește un dialog propriu (`Dialog` din `@ecom/ui`), cu texte din mesaje.
  Excepție: dialogul nativ `beforeunload`, controlat de browser.
- **Nu te bazezi pe validarea nativă a browserului** (`required`, `pattern`, `type="email"`/`"url"` într-un
  `<form>` fără `noValidate`): baloanele ies în limba browserului. Formularele au `noValidate` și mesaje proprii
  în română, cu focus pe primul câmp greșit. Testul de arhitectură `native-widgets` pică la orice ocolire.
- Datorie cunoscută, de tratat înainte de lansare (Faza 17/18): `datetime-local`/`date`, `type="number"`,
  `type="search"` și `<select>` nativ (vezi PROGRESS).

### Navigarea în administrare — regulă permanentă

- **O singură intrare de meniu pe grup, ecranele grupului ca taburi** (bară de legături de navigare deasupra paginii, nu
  taburi ARIA care ascund conținut). Primul grup e **Produse** (Toate produsele, Categorii, Branduri, Atribute, Unități de
  măsură, Fișe explodate, Stoc, sub `/admin/produse/…`; **Media** rămâne separat). Același model pentru **Comenzi, Clienți,
  Marketing, Conținut, Setări** când apar. Un ecran nou al unui grup se adaugă ca tab în `apps/web/src/lib/admin-nav.ts`
  (nu ca intrare nouă de meniu), într-un grup de rute `(tabs)` cu `layout.tsx` care desenează `AdminTabBar`.
- Un tab apare doar dacă utilizatorul are permisiunea (și flag-ul) ecranului; intrarea de meniu apare dacă vede cel puțin un
  tab și duce la primul tab permis. Meniul și bara nu sunt securitate: fiecare pagină își păstrează `requireAdmin`, iar
  rutele `api/admin` verifică permisiunea. Editorul unei entități, formularele «nou» și importurile sunt pagini întregi,
  în afara grupului `(tabs)`.
- Când un ecran își schimbă adresa, adresa veche redirecționează permanent (308) la cea nouă, prin `admin-redirects.ts`,
  iar legăturile interne, testele și ghidurile de verificare se actualizează în același commit (testul de arhitectură
  `admin-navigation` pică la orice legătură spre o adresă veche).

### Teste E2E — aserțiuni de succes — regulă permanentă

- O aserțiune care dovedește că o acțiune s-a terminat trebuie să verifice o stare care apare DOAR după
  finalizarea ei: editorul s-a închis, indicatorul de încărcare a dispărut, a apărut un element nou sau
  textul dintr-un element nou. NU un text care poate exista deja în pagină (de exemplu `toContainText` pe un
  rând care conține un `<select>` deschis cu acel text printre opțiuni, sau pe un titlu care conține deja
  cuvântul căutat): trece imediat, testul se încheie cu acțiunea în curs și devine intermitent.
- Orice aserțiune nouă de text pe un element care poate conține deja acel text (select deschis, listă, titlu)
  se respinge la revizuire.

### Comenzi utile

Comenzile generale ale proiectului (cele din documentația de instalare și de pe serverele unde
`pnpm` funcționează):

- `pnpm dev` — pornește aplicația
- `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:studio`
- `pnpm test` / `pnpm test:e2e`
- `pnpm lint` / `pnpm typecheck`
- `docker compose -f docker/docker-compose.dev.yml up -d`

**⚠️ Specific PC-ului Windows al utilizatorului (nu e o regulă a produsului):** acolo `pnpm.exe` și
`turbo.exe` sunt blocate de Windows Application Control, iar setările de securitate nu se ating.
Scripturile din `package.json` sunt scripturi `node`, deci aceleași nume rulează prin `npm.cmd`.
Pe acel calculator folosesc, în loc de comenzile de mai sus:

- `npm.cmd run dev:web` (aplicația), `npm.cmd run db:migrate` / `db:seed` / `db:studio`
- `npm.cmd run test` (unitare), `npm.cmd run test:integration`, `npm.cmd run test:e2e`
- `node scripts/run-all.mjs lint` și `node scripts/run-all.mjs typecheck` (în loc de `pnpm lint/typecheck`)
- `npm.cmd run lint:root`, `npm.cmd run format:check` (= `prettier --check .` pe tot repo-ul)

Nimic din documentația de instalare, din scripturile livrate sau din CI nu trebuie să depindă de
`npm.cmd`/`node scripts/run-all.mjs`; CI-ul și serverele rulează cu `pnpm`.

### Definiția de „gata"

Un task e gata când: typecheck trece, lint trece, testele trec, funcționează manual
în browser (verificat de utilizator), are audit log dacă e acțiune de admin,
commit-ul e făcut, și `docs/06-todo-master.md` e bifat.

### Protocol de raportare — OBLIGATORIU

Citește `docs/13-protocol-de-lucru.md` și respectă-l la literă. Pe scurt:

- Nu începe niciun punct din TODO fără anunțul **🟢 ÎNCEP** (ce faci, ce fișiere
  atingi, cât durează). Marchează punctul cu `[~]`.
- Nu termina niciun punct fără anunțul **✅ GATA**, care include OBLIGATORIU
  secțiunea „👉 VERIFICĂ TU" cu pași concreți de testat în browser.
  Marchează `[x]` doar după ce utilizatorul confirmă.
- La finalul unei faze: **🏁 FAZĂ TERMINATĂ**, cu rezumat în limbaj de om și
  verificare cap-coadă.
- Când ai nevoie de o decizie: **🛑 STOP**, marchează `[!]` și OPREȘTE-TE. Nu ghici.
- Un singur `[~]` poate exista în tot fișierul TODO la un moment dat.
- La finalul fiecărei sesiuni, actualizează `docs/PROGRESS.md` în formatul din §4
  al protocolului.
- Un commit per punct terminat. Fără commit-uri uriașe la final de zi.
- Se lucrează după mesajele utilizatorului din conversație; prompturile numerotate din
  `docs/07-prompturi-claude-code.md` sunt depășite și se ignoră.

## Verificare, commit și push — regulă permanentă

- **Teste care pică întâi:** pentru orice constrângere (CHECK, unicitate, permisiune, regulă
  numerică) scriu întâi testul, văd că pică pe codul fără ea, apoi implementez.
- **Concurența intră din punctul de rezervare**, nu la final: testele cu cereri simultane pe
  Postgres real se scriu odată cu codul care rezervă/angajează.
- **Testele de integrare nu presupun date de seed.** CI-ul rulează doar `prisma migrate deploy`
  (fără seed), pe când `ecom_test` local poate avea seed rulat de mână: un test care trece doar pe
  a doua e roșu în CI. Orice test care are nevoie de depozit implicit, unități (`buc`, `mp` …),
  roluri, setări sau alte date de sistem le CREEAZĂ singur (în tranzacția anulată, cu
  `runBaseSeed(tx)` sau cu fixture-uri), iar când numără ce există compară înainte/după, nu cu o
  valoare fixă («exact 1 depozit implicit» e o presupunere de seed). Nu se schimbă CI-ul ca să
  se potrivească testului.
- **Verificare completă înainte de ORICE commit de cod, citită integral:** unitare, integrare,
  lint, `lint:root`, typecheck, `prettier --check .` pe TOT repo-ul și E2E complet pe build de
  producție (număr de teste trecute, picate, nerulate). NU fac commit înainte de a fi citit
  rezultatul complet; un test picat se repară înainte de commit. Fixture-urile comune cu
  curățare globală se folosesc dintr-un singur fișier de teste.
- **Integrarea se rulează pe DOUĂ baze, ambele citite integral:** `ecom_test` (seed-uită) ȘI o bază
  doar migrată, ca în CI. Pentru a doua: `TEST_DATABASE_URL` către o bază nouă cu «test» în nume
  (de exemplu `ecom_ci_test`, pe același server; `test:integration` o creează și o migrează singur),
  apoi `npm.cmd run test:integration`; după verificare o ștergi cu `DROP DATABASE` (doar baza pe
  care ai creat-o tu). Un test care trece pe una și pică pe cealaltă se repară în test, nu în CI.
- **Niciun `git push` fără autorizarea utilizatorului**, în conversație, pentru acel moment.
  Când e autorizat, arăt MAI ÎNTÂI `git status --short` și `git log --oneline origin/main..HEAD`
  și mă opresc dacă apare ceva neașteptat; apoi rulez, în ordine: `prettier --check .` pe tot
  repo-ul, lint, `lint:root`, typecheck; abia apoi `git push origin main`.
- **După push aștept «CI verde» de la utilizator** înainte de punctul următor (excepție doar când
  utilizatorul spune explicit altceva; dacă CI-ul pică, mă opresc și raportez).
- **Nu ating dev serverul utilizatorului.** Spun când trebuie repornit (după migrații și după
  orice modificare în nucleu, singletonurile păstrează codul vechi).
- **Migrațiile le aplică utilizatorul** pe baza de dezvoltare; eu le verific doar pe baza `*_test`.
- **Decizii care ating bani, TVA, facturare sau obligații legale:** mă opresc cu 🛑 și le aduc
  utilizatorului înainte; punctele deschise rămase le decid cu recomandarea din plan și le notez
  în `docs/PROGRESS.md`.

## Procese, porturi și build-uri — regulă permanentă

Mașina utilizatorului rulează în paralel servere pornite de el (dev server, Docker). Greșelile aici
strică munca lui fără ca eu să observ.

- **Nu opri niciun proces pe care nu l-ai pornit tu.** Nici după nume, nici după linia de comandă,
  nici după port. Ții evidența PID-urilor proprii și oprești doar acele PID-uri.
- **Probele rulează doar pe port propriu**, pornite și oprite după PID. Dacă un port e ocupat,
  alegi alt port; nu te bazezi pe ce răspunde pe un port ocupat și nu îl „eliberezi".
- **Nu rula build-uri care scriu peste `.next` cât timp poate exista un server de dev pornit.**
  Pentru probe folosește un director de build separat: `NEXT_DIST_DIR=.next-probe pnpm build:web`
  (pe PC-ul Windows al utilizatorului: variabila setată în shell, apoi `npm.cmd run build:web`; și `next start` cu același `NEXT_DIST_DIR`). După probă ștergi `apps/web/.next-probe` și restabilești
  fișierele pe care Next le rescrie la build: `git checkout -- apps/web/tsconfig.json apps/web/next-env.d.ts`.
- Înainte să pornești un server sau un build, verifică ce ascultă pe portul ales.

## Ce să NU faci

- Nu instala librării grele fără să întrebi.
- Nu schimba schema Prisma fără migrație.
- Orice CHECK compus din schema bazei folosește comparații explicite (`IS NULL` / `IS NOT NULL`) pe fiecare coloană și are un test cu cazul „una setată, una nulă”. Un CHECK cu rezultat NULL TRECE: `(x IS NULL AND y IS NULL) OR (x BETWEEN 0 AND 9 AND y BETWEEN 0 AND 9)` acceptă `x = 5, y = NULL`.
- Nu scrie logică de business în componente React.
- Nu adăuga microservicii, GraphQL sau abstractizări „pentru viitor".
- Nu genera sute de fișiere deodată. Lucrează incremental, cu commit-uri.
