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
| 2026-11-13 | redesign-final | Lot 3b-2 / pasul 1: Fișe explodate (lista și shell-ul editorului) | commit-ul pasului | per pas: 12 teste noi de design (roșu pe 9), parts-diagrams 3/3, arhitectură, typecheck OK; verify:full în rândul de mai jos | S3: 1 (FINISAJE.md) |
