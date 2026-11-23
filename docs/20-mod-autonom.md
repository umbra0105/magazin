# 20 — Mod autonom: fază cap-coadă, cu plasă de siguranță

> **Statut:** propus de asistentul de ghidare, **decis de utilizator pe 2026-11-13** (principiile) și pus în aplicare abia după pasul de configurare din §10. Până atunci, protocolul din `13-protocol-de-lucru.md` și regulile de push din `CLAUDE.md` rămân în vigoare.
> **Scop:** utilizatorul nu mai este necesar la fiecare lot. Claude Code lucrează o fază întreagă, singur, iar utilizatorul verifică la sfârșitul fazei, nu după fiecare pas. Calitatea nu scade: se mută de la «verifică omul după fiecare pas» la «verifică mașina după fiecare pas, omul la capătul fazei».
> **Nu conține estimări de timp.**

## 1. Principii

1. **Autonomie proporțională cu riscul.** Interfața și documentația merg singure. Banii, stocul, plățile, permisiunile, datele personale și partea legală au opriri și verificări obligatorii (§3).
2. **Nimic nu ajunge în `main` fără poartă.** Lucrul stă pe o ramură de fază, iar îmbinarea în `main` se face doar prin poarta din §5.
3. **Orice se poate anula.** Etichetă înainte de îmbinare, îmbinare prin commit (nu squash), copie de siguranță a bazei de dezvoltare înainte de fază, fără `--force`, fără rescrierea istoriei `main`.
4. **Problemele mici nu opresc lucrul.** Se notează și se rezolvă într-o singură trecere, la final de fază sau înainte de lansare.
5. **Utilizatorul poate opri oricând** (§6.4).

## 2. Niveluri de gravitate

| Nivel | Ce înseamnă | Ce faci |
|---|---|---|
| **S1** | Bani, stoc, plăți, securitate, permisiuni, date personale, migrări pe date, aspecte legale, pierdere de date | **Oprire imediată** (🛑), nu continui, explici opțiunile |
| **S2** | O funcție nu merge sau un test critic pică | Repari **pe loc**, înainte de pasul următor |
| **S3** | Aspect, text, aliniere, finisaje | Notezi în `docs/FINISAJE.md` (o linie: ecran, ce, captură) și continui |

La întrebarea «e S2 sau S3?», alegi nivelul mai grav.

## 3. Moduri de lucru pe fază

| Mod | Ce permite | Faze (din `06-todo-master.md`) |
|---|---|---|
| **A — autonom** | Toată faza fără oprire, cu raport la final | Rest din Redesign admin (3b-2, Lot 4), 15d (imagini din descrieri, mini-fază), 11 (admin comenzi, emailuri), 12 (AWB, după deciziile de transport), 14 (cont și retururi, fără partea de bani), 16 (CMS), 17 (SEO, redirecturi, fără prețuri), 19 (extensii), 20 (rapoarte, hardening), `poarta-draft` (mini-fază de proces: PR draft până la poartă, `--doar-etichete`), `ci-joburi` (mini-fază de proces: CI-ul împărțit în joburi paralele, cu `check` ca job de agregare), `ci-e2e-paralel` (mini-fază de proces: jobul `e2e` împărțit în joburi paralele, cu shard-uri Playwright; `check` rămâne agregatorul), `e2e-curatare-comenzi` (mini-fază de proces: curățarea comenzilor E2E pe tag, fără ștergere globală în specuri; curățarea globală doar în setup/teardown, cu gardă de arhitectură), `storno-total` (mini-fază de corecție în facturare, decisă de utilizator la 2026-11-23, modul A: stornoul «total» acoperă doar restul nestornat al facturii; orice scenariu cu suma stornourilor peste totalul facturii sau cu 1 ban diferență la o comandă stornată integral rămâne 🛑 S1) |
| **B — autonom cu poartă umană** | Lucrul merge singur, dar faza **nu se îmbină** până nu verifici manual pașii marcați | 8 (motor de prețuri, coș), 9 (checkout), 10 (plăți), 13 (facturare), 14b (produse digitale, acces), 15 (grupuri de clienți, prețuri NIR), 15b (loialitate, vouchere), 22b (eMAG Marketplace: bani, comenzi și stoc externe) |
| **C — cu punct de control** | Autonom, cu o oprire planificată la mijloc | 6 (design system și layout): oprire după tokeni, preseturi și layout (header, footer, meniu, 404/500), pentru aprobarea direcției vizuale; apoi restul autonom. 7 (storefront catalog): oprire după primele șabloane (acasă, categorie, produs), pentru aprobarea lor; apoi restul autonom. 18 (instalator), 21 (împachetare și distribuție) și 22 (lansare): verificare umană cap-coadă obligatorie |
| **Continuu** | Fără fază de executat dintr-o dată | 23 (post-lansare): fiecare punct se execută ca mini-fază, în modul A sau B după zona pe care o atinge |

Tabelul din `scripts/autonom/phases.ts` (`PHASE_MODES`) se completează cu faza respectivă în primul commit al ramurii ei (cu test), ca poarta să o recunoască; fazele de mai sus fără intrare acolo (21, 22b) se adaugă atunci.

Pașii de verificare manuală din `13-protocol-de-lucru.md` §6 rămân obligatorii pentru fazele 9, 10, 13 și 18.

## 4. Ramuri și commit-uri

- Ramura de fază: `faza-N` (sau `redesign-…` pentru redesign). Se creează din `main` actual.
- **Un commit per pas**, cu mesajul obișnuit. Nu se amestecă documentația cu codul în același commit, decât dacă documentația e consecința directă.
- Claude Code publică (`git push`) **doar ramura de fază**, nu `main`. Asta este singura autorizare de push dată în mod autonom, și doar după ce utilizatorul a spus explicit «Execută Faza N în mod autonom, conform docs/20».
- **Cererea de îmbinare (PR) a fazei se deschide DRAFT:** `gh pr create --draft --base main --head faza-N` (descrierea se încheie cu liniile de atribuire cerute). Stă draft până la poartă, care o marchează ready chiar înainte de îmbinare (§5, pasul 7). **PR-ul fazei nu se îmbină niciodată din butonul GitHub**: la Faza 7 o îmbinare din buton a ocolit poarta (fără etichete, fără verificarea condițiilor), iar un PR draft nu poate fi îmbinat din buton. Dacă totuși se îmbină din GitHub, etichetele lipsă se pun cu `--doar-etichete` (§5).
- În afara modului autonom (sesiune obișnuită), regula din `CLAUDE.md` rămâne: fără push până nu cere utilizatorul.

## 5. Poarta de îmbinare în `main`

Se rulează ca script (`npm.cmd run gate:merge`), scris la pasul de configurare cu teste (ieșirea `git` și `gh` simulată; mutanți pe regulile critice). Claude Code **nu** îmbină manual, doar prin poartă. **Acest §5 descrie exact `scripts/autonom/gate.ts` și `gate-cli.ts` (verificat la faza `poarta-draft`, 2026-11-17): orice schimbare a porții schimbă și acest text, în același commit sau în cel imediat următor.** Poarta verifică, în ordine, și se oprește la prima condiție neîndeplinită:

0. Pregătirea: faza e în tabelul din §3 (altfel nu trece: nu se presupune «A»), nu există `STOP.txt` în rădăcină, iar ramura curentă e ramura fazei.
1. Arborele de lucru e curat (`git status --porcelain` gol) și în diferența față de `origin/main` nu apar fișiere de lucru: `local-data/`, `.env*`, `STOP.txt`, `zz-*`, `test-results/`, `playwright-report/`, directoare `.next*`, `node_modules/`, `*.log`, `*.bak`, `*.dump`, `.sql` în afara `packages/db/`, și `docs/AUTONOM-APROBARI.md` (îl scrie numai utilizatorul).
2. Ramura de fază conține vârful lui `origin/main` (după `git fetch origin main`). **Poarta nu aduce ea `main` în ramură**: se oprește și spune cum (`git merge origin/main`, apoi `verify:full` din nou și trimiterea ramurii).
3. Verificarea completă locală (Prettier, lint, `lint:root`, typecheck, typecheck-ul scripturilor autonome, unitare, integrare pe două baze, E2E pe build de producție) a trecut **pe codul final**: poarta citește înregistrarea scrisă de `npm.cmd run verify:full` (`local-data/gate/verificare.json`) și o compară cu hash-ul arborelui git de acum; toți pașii cu cod 0 și, la cei cu teste, zero picate, sărite, nerulate sau intermitente. Orice modificare de după (inclusiv de documentație) cere o nouă rulare.
4. Ramura are **exact o cerere de îmbinare deschisă** spre `main` (**draft sau nu**), cu vârful egal cu `HEAD`-ul local, iar CI-ul de pe GitHub pentru acel vârf este **verde** (`gh pr checks`: toate verificările trebuie să fie `pass`; zero verificări, în curs, picate, anulate sau sărite nu sunt «verde»). O cerere draft e normală: în `--dry-run` poarta spune «PR-ul e draft; poarta îl va marca ready înainte de îmbinare» și **nu o modifică**. Când nu există nicio cerere deschisă, poarta caută în istoric (`gh pr list --state all`) și spune adevărul: «PR #N e deja îmbinat (commit X)» sau «PR #N e închis fără îmbinare»; nu îmbină a doua oară.
5. `docs/FINISAJE.md` nu are intrări S1 sau S2 deschise.
6. Pentru faze în modul **B** sau **C**: fișierul `docs/AUTONOM-APROBARI.md` conține «aprobat» scris de utilizator pentru faza respectivă. Fără el, poarta nu îmbină.
7. Se creează eticheta `pre-faza-N` pe `main` actual (adnotată, trimisă singură), apoi **dacă cererea e draft** se marchează ready (`gh pr ready <n>`, fără alte flag-uri; o cerere care era deja ready nu se atinge), apoi se îmbină prin **commit de îmbinare** (`gh pr merge <n> --merge --match-head-commit <sha>`, fără squash, fără `--admin`, `--auto` sau ștergerea ramurii), apoi se pune eticheta `faza-N-completa` pe commit-ul de îmbinare (cu exact doi părinți) și se trimite. Ordinea este: **etichetă → ready → îmbinare → etichetă**. Dacă `gh pr ready` eșuează, poarta se oprește înainte de îmbinare (cererea rămâne draft). Dacă îmbinarea e refuzată după ce poarta a marcat cererea ready, poarta o readuce în draft (`gh pr ready <n> --undo`) și raportează; dacă nici `--undo` nu reușește, raportul spune că cererea a rămas ready și cum o readuci tu. Comenzile `merge`, `ready` și `ready --undo` sunt construite fiecare într-un singur loc din `gate.ts` (`mergeArgs`, `readyArgs`, `undoReadyArgs`).

**Linia de comandă a porții:** doar `--faza <id>`, `--dry-run` și `--doar-etichete`. Orice alt argument (`--force`, `--admin`, `--squash`, `--ready`, `--skip-ci`, `--no-verify`…) este respins; nu există flag care să ocolească o condiție.

**După o îmbinare făcută din GitHub (`--doar-etichete`):** `npm.cmd run gate:merge -- --faza <id> --doar-etichete [--dry-run]` pune doar etichetele unei faze deja îmbinate, fără să îmbine nimic și fără să apeleze vreodată `gh pr merge` sau `gh pr ready`. Verifică: faza e în tabel, nu există `STOP.txt`, `origin/main` e proaspăt; exact o cerere îmbinată spre `main` de pe ramura fazei; commit-ul ei de îmbinare e strămoș al lui `origin/main` și are **exact doi părinți** (nu squash sau rebase); `pre-faza-N` trebuie să arate spre **primul părinte**, iar `faza-N-completa` spre commit-ul de îmbinare. O etichetă lipsă se creează adnotată (aceleași mesaje ca la poartă) și se trimite singură (`refs/tags/<nume>`); una aflată deja pe commit-ul corect nu se atinge (idempotent); una aflată pe **alt** commit oprește tot, fără nicio modificare: o etichetă nu se mută niciodată. **Ce NU garantează:** modul nu verifică CI-ul, aprobarea, `verify:full` sau conținutul îmbinării (nu îmbină nimic), deci etichetele puse așa **nu sunt o aprobare** și nu dovedesc că faza a trecut poarta; spun doar unde a fost `main` înainte și după îmbinare.

**Anulare:** dacă după îmbinare apare o problemă gravă, se creează un commit de revenire (`git revert -m 1 <îmbinare>`) printr-o cerere nouă. **Niciodată** `reset --hard` sau `--force` pe `main`.

**Protecția ramurii pe GitHub:** dacă planul contului o permite (Settings → Branches), se activează pentru `main`: verificări de stare obligatorii, fără push forțat, fără ștergere. Dacă planul nu o permite, poarta locală este singura barieră și se respectă strict.

## 6. Plasa de siguranță

### 6.1 Copie de siguranță a bazei de dezvoltare
La începutul fiecărei faze, Claude Code face un `pg_dump` al bazei de dezvoltare (în `local-data/backups/`, în `.gitignore`), păstrează ultimele 5 și notează calea în `docs/AUTONOM-LOG.md`. Bazele de test sunt de unică folosință și nu se salvează.

### 6.2 Migrări
Un test de arhitectură respinge o migrare nouă cu `DROP`, `TRUNCATE` sau `DELETE` fără `WHERE`, dacă nu are o adnotare explicită de aprobare. Migrările cu pierdere de date sunt întotdeauna S1: se oprește.

### 6.3 Condiții de oprire (🛑 obligatoriu)
- orice S1 (§2);
- aceeași verificare pică de 2 ori la rând pe același pas după corecții;
- peste 3 runde de corecții pe același pas;
- o modificare în afara scopului declarat al pasului;
- un test intermitent: se **notează** (nu se ascunde, nu se dezactivează) și se continuă numai dacă nu atinge zona pasului;
- nevoie de ceva ce doar utilizatorul poate da: parole, chei, conturi de test, decizii din `10-decizii-deschise.md`;
- biblioteci noi, programe de instalat, setări de securitate Windows: ca până acum, doar cu aprobare;
- Docker sau baza de date nu răspund: oprire curată, cu stare notată în `PROGRESS.md`.

### 6.4 Frâna de mână
Dacă în rădăcina proiectului există un fișier numit `STOP.txt` (necomis, în `.gitignore`), Claude Code termină pasul curent, comite, notează starea și se oprește. Utilizatorul îl poate crea de oriunde (acces la distanță). Claude Code verifică fișierul la începutul fiecărui pas.

### 6.5 Ce nu se face niciodată
`--force`, `reset --hard` pe ramuri publicate, scrieri pe orice bază în afară de cele de dezvoltare și de test, parole în comenzi sau în conversație, secrete în loguri, audit-log oprit manual, date reale (WooCommerce, SmartBill, `local-data/`) comise, tipărite sau folosite ca fixture-uri.

## 7. Verificare pe niveluri de risc

| Ce | Când | Ce se rulează |
|---|---|---|
| Per pas | La fiecare pas | typecheck, lint și testele zonei atinse; teste scrise **înainte** pentru bani, stoc, plăți, permisiuni |
| Sfârșit de pas | O singură dată pe pas | verificarea completă, citită integral, pe codul final (nu înainte de ultima modificare) |
| Mutanți | Doar pe **logica critică** (bani, stoc, plăți, permisiuni, parole, acces la fișiere) | mutanții scriși pentru regulile noi; la interfață **nu** se rulează mutanți E2E |
| Interfață | La fiecare ecran nou sau modificat | teste de invarianți (un singur buton principal, fără derulare laterală, înălțimi, ținte tactile, contrast), plus **autorevizuirea tuturor capturilor** la 390 și 1440 px, în ambele teme, după lista din `17-design-sistem-admin.md` |
| Sfârșit de fază | O dată | verificarea completă, capturi finale, lista S3, raportul de fază |

Dacă nu e clar dacă ceva e «logică critică», este.

## 8. Raportare

- **`docs/AUTONOM-LOG.md`**: o linie per pas (data, pas, commit, rezultatul verificării, S3 notate). Fără cuvinte inutile.
- **`docs/FINISAJE.md`**: lista S3 acumulată (ecran, problemă, captură). Se rezolvă într-o trecere separată.
- **`docs/PROGRESS.md`**: «de unde reiau» actualizat după **fiecare** pas, ca o sesiune nouă să poată continua dacă limita de utilizare se termină.
- **🏁 la final de fază**, cu: ce funcționează, ce a rămas, S3 deschise, 10–15 pași de verificare în browser, locul capturilor, hash-ul îmbinării (sau motivul pentru care nu s-a îmbinat).
- Nu se trimit rapoarte per lot. Se trimit doar 🛑 și 🏁.
- **O fază = o sesiune nouă de Claude Code (și un chat nou cu ghidul).** La finalul oricărei faze, raportul 🏁 spune explicit: «Faza N închisă; deschide o sesiune nouă pentru Faza N+1», și indică unde e starea proiectului (`docs/PROGRESS.md`, `docs/AUTONOM-LOG.md`, ramura și etichetele). La începutul unei faze noi, sesiunea citește mai întâi `docs/PROGRESS.md`, `docs/20-mod-autonom.md` și secțiunea fazei din `docs/06-todo-master.md`, apoi confirmă înțelegerea înainte să construiască.

## 9. Ce rămâne la utilizator

1. Verificarea de la capătul fazei (10–15 pași) și o singură listă de corecții, citită de asistentul de ghidare din capturi.
2. Aprobările din `docs/AUTONOM-APROBARI.md` pentru fazele B și C.
3. Deciziile marcate 🛑 și datele pe care nu le poate afla altcineva (conturi de test, prețuri reale, răspunsuri de la contabil și avocat).
4. Frâna de mână, când e nevoie.

## 10. Pasul de configurare (o singură dată, înainte de prima fază autonomă)

1. `gh` (GitHub CLI) instalat și autentificat pe PC (instalat de utilizator; Claude Code nu instalează executabile).
2. Claude Code scrie poarta (`gate:merge`) cu teste, secțiunea scurtă din `CLAUDE.md` care trimite la acest document, și fișierele `AUTONOM-LOG.md`, `FINISAJE.md`, `AUTONOM-APROBARI.md`; adaugă `STOP.txt` și `local-data/` în `.gitignore` dacă lipsesc.
3. Utilizatorul verifică în GitHub dacă protecția ramurii `main` e disponibilă.
4. **Pilot:** restul redesignului (3b-2 și Lotul 4) ca o fază autonomă în modul A, pe ramura `redesign-final`. Pe ce învățăm din pilot se ajustează acest document.

**Dacă `gh` nu se poate instala** (de exemplu îl blochează Smart App Control, pe care nu-l dezactivăm): poarta se oprește cu cod 2 («`gh` nu răspunde», nu instalează nimic) și nu îmbină; îmbinarea rămâne atunci decizia utilizatorului, în afara porții (și, dacă o face, etichetele se pun apoi cu `--doar-etichete`, §5). Poarta nu are un mod de «confirmare manuală a CI».

## 11. Relația cu alte documente

- Modifică în mod autonom doar două reguli din `13` și `CLAUDE.md`: raportul ✅ GATA per pas devine linie în `AUTONOM-LOG.md`, iar «fără push» devine «push doar pe ramura de fază». Restul rămâne: 🛑 la decizii, un singur `[~]`, definiția de «gata», regulile de securitate și de date.
- Dacă acest document contrazice `CLAUDE.md` într-o regulă de securitate, de date sau de bani, câștigă `CLAUDE.md`.
