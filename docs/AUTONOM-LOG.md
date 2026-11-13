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
