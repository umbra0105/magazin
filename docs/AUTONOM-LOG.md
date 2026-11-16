# Jurnalul modului autonom

O linie per pas al unei faze autonome (`docs/20-mod-autonom.md` §8). Fără cuvinte inutile: rapoartele ✅ GATA per pas nu se mai trimit, ele devin liniile de mai jos. Se trimit doar 🛑 și 🏁. «De unde reiau» stă în `docs/PROGRESS.md`, actualizat după fiecare pas.

La începutul fiecărei faze, după `npm.cmd run db:backup`, se notează aici **copie bază** cu calea fișierului (ultimele 5 copii se păstrează în `local-data/backups/`, care nu se comite).

## Format

| data | faza | pas | commit | verificare | S3 notate |
| ---- | ---- | --- | ------ | ---------- | --------- |

Exemplu de linie (nu e o intrare reală):

```
| 2026-12-01 | redesign-final | 3b-2 / pasul 2: lista Fișe explodate | a1b2c3d | per pas: typecheck, lint, teste zonă OK | S3: 1 (FINISAJE.md) |
| 2026-12-01 | redesign-final | început de fază | - | copie bază: local-data/backups/ecom-20261201-090000.sql | - |
```

La final de pas: verificarea completă, citită integral (`npm.cmd run verify:full`), cu numerele ei (unitare, integrare pe două baze, E2E), apoi scrisă pe linia pasului.

## Jurnal

| data | faza | pas | commit | verificare | S3 notate |
| ---- | ---- | --- | ------ | ---------- | --------- |
| 2026-11-13 | redesign-final | început de fază | - | copie bază: local-data/backups/ecom-20261113-142651.sql | - |
| 2026-11-13 | redesign-final | Lot 3b-2 / pasul 1: Fișe explodate (lista și shell-ul editorului) | 4244c6f | per pas: 12 teste noi de design (roșu pe 9), parts-diagrams 3/3, arhitectură, typecheck OK; verify:full complet pe codul comis: prettier, lint, lint:root, typecheck, typecheck autonom OK; 3266 unitare, 920 integrare dezvoltare, 920 integrare doar migrată, 382 E2E, 0 picate/sărite/intermitente | S3: 1 (FINISAJE.md) |
| 2026-11-13 | redesign-final | Lot 3b-2 / pasul 2: Import și Export (wizard, Woo, imagini, istoric, dialogul de export) | dfa5127 | per pas: 10 teste noi de design (roșu pe 9 din 10), 23 de comportament import/Woo/istoric/export verzi, arhitectură, typecheck, lint OK; verify:full la capătul lotului 3b-2 | S3: 1 (FINISAJE.md) |
| 2026-11-13 | redesign-final | Lot 3b-2 / pasul 3: golirea listei de excepții […px] (movements-table pe Table), admin-legacy-classes extins | b702ea1 | per pas: arhitectură 173/173, typecheck OK; verify:full complet la capătul lotului 3b-2, pe b702ea1: prettier, lint, lint:root, typecheck, typecheck autonom OK; 3266 unitare, 920 integrare dezvoltare, 920 integrare doar migrată, 392 E2E, 0 picate/sărite/intermitente | - |
| 2026-11-13 | redesign-final | Lot 4: autentificare pe suprafața adminului, 404, eroare, PageSkeleton (AdminSurface comună) | commit-ul pasului | per pas: 6 teste noi de design, auth.spec și specurile cu 404 (admin, warehouses) verzi, arhitectură, typecheck, lint OK; verify:full la finalul fazei (acoperă și capătul lotului 4) | S3: 1 notat și rezolvat |
| 2026-11-13 | redesign-final | trecerea finală pe S3 (3 intrări rezolvate în FINISAJE.md) | în același commit cu Lot 4 | verify:full final pe codul final | S3 deschise: 0 |
| 2026-11-13 | redesign-finisaje | început de fază | - | copie bază: local-data/backups/ecom-20261113-210735.sql | - |
| 2026-11-13 | redesign-finisaje | grup 1: plural românesc comun (pluralRo) în raportul de import și în mesaje | c48af00 | per pas: teste pe funcție (5) și pe mesaje (7) roșii apoi verzi, typecheck, lint | - |
| 2026-11-13 | redesign-finisaje | grup 2: breadcrumb 404 în admin și alerta de formular fără inel de focus | f8c9d83 | per pas: test pe breadcrumbsFor roșu apoi verde, typecheck, lint | - |
| 2026-11-13 | redesign-finisaje | grup 3: import pe telefon (stepper pe un rând, descrieri în greutate normală, tooltip la selecturi) | b33dea6 | per pas: typecheck, lint, arhitectură 173/173 | - |
| 2026-11-13 | redesign-finisaje | grup 4: istoricul exporturilor paginat («Încarcă mai multe») | d9f3be5 | per pas: 4 teste unitare pe serviciu roșii apoi verzi, typecheck, lint | - |
| 2026-11-13 | redesign-finisaje | grup 5: eticheta «Rând» pe carduri, țintă tactilă pentru «Detalii» | f2a8d23 | per pas: typecheck, lint, specuri import-design și states-design verzi (1 test de Tab corectat în commit-ul de documentație) | - |
| 2026-11-14 | 15d | început de fază | - | copie bază: local-data/backups/ecom-20261114-210947.sql | - |
| 2026-11-15 | 15d | nucleul: marcaje, sarcini cu tip (migrație), înlocuire idempotentă în importator | fcc3bab | per pas: teste unitare scrise întâi, typecheck, lint | - |
| 2026-11-15 | 15d | plan în ambele moduri, raport, integrare pe baza reală | 3b02e81 | per pas: 6 teste de integrare noi (rețea simulată), unitare | - |
| 2026-11-15 | 15d | bifa și raportul în interfață; marcaje scoase la randare | f527827 | per pas: E2E import-design, product-import-woo, product-import: 27 verzi | - |
| 2026-11-15 | 15d | mutanți pe idempotență, reluare, înlocuire în HTML | 2ee53c1 | 22 mutanți, toți uciși în afară de unul echivalent | - |
| 2026-11-15 | 15d | migrația kind pe baza de dezvoltare (autorizată) și încărcarea demo (29 de produse, prețuri de test) | - | copie bază: local-data/backups/ecom-20261115-142933.sql; doar migrația 20261115090000 aplicată; demo: 29 produse, 15 branduri, 40 media | - |
| 2026-11-15 | 15d | documentație: nota din (15d) în docs/06, clasificarea fazelor în docs/20 §3 | commit-ul docs | arhitectură și autonom 274/274 | - |
| 2026-11-15 | 6 | început de fază (mod C), ramura faza-6 din main `328c3c8`; poarta și garda acceptă faza-6 (teste) | - | copie bază: local-data/backups/ecom-20261115-175051.sql | - |
| 2026-11-15 | 6 | documentația A (19, 06, 18), docs/21 cu planul de design și referințele | 60c538f, 95330a3 | prettier pe docs | - |
| 2026-11-15 | 6 | tokeni și presets (Minimal echilibrat), meniu de categorii, componente ui, header/footer/drawer, galerie dev-only | 6f756c6…7ec3793 | typecheck, lint, lint:root, prettier, unitare 3385, integrare branding, 17 E2E noi pe server propriu | 2 S3 din 15d |
| 2026-11-15 | 6 | PUNCT DE CONTROL: oprit pentru «aprobat, continuă» | - | capturi în local-data/capturi-faza6/checkpoint | - |
| 2026-11-16 | 6 | aprobat direcția «echilibrat»; corecții 1–6 (panou telefon, Bold fără degrade, galerie cu imagini reale, header sticlă, plăci de meniu) | 08800c9 | unitare 3407, E2E vitrină (dev) verzi | - |
| 2026-11-16 | 6 | editorul de temă Nivel 2 + CSS personalizat validat, setări de aspect, grup «Setări» | 32e481b | unitare 3466, integrare branding, 9 E2E editor pe build de producție | - |
| 2026-11-16 | 6 | 404/500/schelete + consimțământ implicit refuzat | 171858d | unitare 3474, 9 E2E noi (dev) | - |
| 2026-11-16 | 6 | mentenanță 503 + pagina admin; teste de audit robuste la rânduri E2E | 6cff19d | unitare 3490, integrare admin 28, E2E complet pe producție: 421 trecute (1 de mentenanță reparat) | - |
| 2026-11-16 | 6 | corecturi S3 la sfârșit de fază: plăci de meniu uniforme (grilă cu 3 coloane), masă foto unică pentru imaginile de produs (`multiply`), header sticlă cu tokeni `--sf-glass-*`; capturile finale refăcute (54) | commit-ul corecturii | per pas: unitare (suprafețe, markup), E2E vitrină + stări pe build de producție, typecheck, lint, lint:root, prettier; fără verify:full (după aprobare, o singură dată pe codul îmbinat) | - |

| 2026-11-16 | 6 | verify:full pe codul îmbinat: 1 test E2E intermitent (`diagrams-design.spec.ts:379`, fișe explodate); cauza dovedită cu diagnostic (3 din 96 rulări, culoare citită în tranziție), corectat doar în test, aprobat de utilizator ca S2 | commit-ul corecției | per pas: probă roșie pe helperul vechi (`Array []`), verde pe cel nou; spec 192/192 în 16 repetări cu 2 workeri; verify:full se reface pe codul final | S3: 1 rezolvat (FINISAJE.md) |
| 2026-11-16 | 7 | început de fază (mod C), ramura faza-7 din main `6045175` (main local era cu 33 commit-uri în urmă: fast-forward, fără push); `PHASE_MODES` avea deja «7»: «C» cu test; docs: Sesiunea 21 corectată, Sesiunea 22 | commit-ul docs | copie bază: local-data/backups/ecom-20261116-150848.sql | - |
