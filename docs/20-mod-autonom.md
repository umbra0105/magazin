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
| **A — autonom** | Toată faza fără oprire, cu raport la final | Rest din Redesign admin (3b-2, Lot 4), 11 (admin comenzi, emailuri), 12 (AWB, după deciziile de transport), 14 (cont și retururi, fără partea de bani), 16 (CMS), 17 (SEO, redirecturi, fără prețuri), 19 (extensii), 20 (rapoarte, hardening) |
| **B — autonom cu poartă umană** | Lucrul merge singur, dar faza **nu se îmbină** până nu verifici manual pașii marcați | 8 (motor de prețuri, coș), 9 (checkout), 10 (plăți), 13 (facturare), 14b (produse digitale, acces), 15 (grupuri de clienți, prețuri NIR), 15b (loialitate, vouchere) |
| **C — cu punct de control** | Autonom, cu o oprire planificată la mijloc | 6 și 7 (storefront): oprire după primul șablon (acasă, categorie, produs), pentru aprobarea direcției vizuale; apoi restul autonom. 18 (instalator) și 22 (lansare): verificare umană cap-coadă obligatorie |

Pașii de verificare manuală din `13-protocol-de-lucru.md` §6 rămân obligatorii pentru fazele 9, 10, 13 și 18.

## 4. Ramuri și commit-uri

- Ramura de fază: `faza-N` (sau `redesign-…` pentru redesign). Se creează din `main` actual.
- **Un commit per pas**, cu mesajul obișnuit. Nu se amestecă documentația cu codul în același commit, decât dacă documentația e consecința directă.
- Claude Code publică (`git push`) **doar ramura de fază**, nu `main`. Asta este singura autorizare de push dată în mod autonom, și doar după ce utilizatorul a spus explicit «Execută Faza N în mod autonom, conform docs/20».
- În afara modului autonom (sesiune obișnuită), regula din `CLAUDE.md` rămâne: fără push până nu cere utilizatorul.

## 5. Poarta de îmbinare în `main`

Se rulează ca script (`npm.cmd run gate:merge`), scris la pasul de configurare cu teste (ieșirea `gh` simulată). Claude Code **nu** îmbină manual, doar prin poartă. Poarta verifică, în ordine, și se oprește la prima condiție neîndeplinită:

1. Arborele de lucru e curat și nu există fișiere nefolosite din afara scopului fazei în diferență.
2. Ramura de fază e actualizată față de `main` (altfel se aduce `main` în ea, se rulează din nou verificarea).
3. Verificarea completă locală (Prettier, lint, `lint:root`, typecheck, unitare, integrare pe două baze, E2E pe build de producție) a trecut **pe codul final**, citită integral.
4. CI-ul de pe GitHub pentru vârful ramurii este **verde** (`gh pr checks`, toate verificările cerute).
5. `docs/FINISAJE.md` nu are intrări S1 sau S2 deschise.
6. Pentru faze în modul **B** sau **C**: fișierul `docs/AUTONOM-APROBARI.md` conține «aprobat» scris de utilizator pentru faza respectivă. Fără el, poarta nu îmbină.
7. Se creează eticheta `pre-faza-N` pe `main` actual, apoi se îmbină prin **commit de îmbinare** (`gh pr merge --merge`, fără squash și fără ștergerea ramurii), apoi se pune eticheta `faza-N-completa` și se trimite.

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

**Dacă `gh` nu se poate instala** (de exemplu îl blochează Smart App Control, pe care nu-l dezactivăm): poarta cere confirmarea utilizatorului pentru CI («CI verde»), ca în protocolul actual; restul modului autonom rămâne.

## 11. Relația cu alte documente

- Modifică în mod autonom doar două reguli din `13` și `CLAUDE.md`: raportul ✅ GATA per pas devine linie în `AUTONOM-LOG.md`, iar «fără push» devine «push doar pe ramura de fază». Restul rămâne: 🛑 la decizii, un singur `[~]`, definiția de «gata», regulile de securitate și de date.
- Dacă acest document contrazice `CLAUDE.md` într-o regulă de securitate, de date sau de bani, câștigă `CLAUDE.md`.
