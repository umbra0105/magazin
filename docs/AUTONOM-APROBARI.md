# Aprobări pentru fazele B și C (mod autonom)

Fazele de modul **B** (autonom cu poartă umană) și **C** (cu punct de control) nu se îmbină în `main` până când **utilizatorul** a scris aici «aprobat» pentru ele, după verificarea manuală a fazei (`docs/20-mod-autonom.md` §3, §5 condiția 6 și §9). Fazele de modul **A** nu au nevoie de aprobare și nu apar aici.

**Claude Code nu scrie și nu schimbă aprobările.** Poarta de îmbinare nu poate dovedi cine a scris o linie, de aceea fișierul se modifică numai de utilizator.

## Format

Câte o linie pentru fiecare fază: `- Faza N: <stare>`. Doar **`aprobat`** (primul cuvânt după două puncte) aprobă faza; orice alt cuvânt (în așteptare, neaprobat, retras) nu. Dacă o fază apare de mai multe ori, **ultima linie decide**. După stare se poate scrie data și o notă.

```
- Faza 9: aprobat, 2026-12-01, verificat comanda cu ramburs
- Faza 9: retras, 2026-12-02, am găsit o problemă la TVA
```

## Stare curentă

Modul B:

- Faza 8: în așteptare
- Faza 9: în așteptare
- Faza 10: în așteptare
- Faza 13: în așteptare
- Faza 14b: în așteptare
- Faza 15: în așteptare
- Faza 15b: în așteptare

Modul C:

- Faza 6: în așteptare
- Faza 7: în așteptare
- Faza 18: în așteptare
- Faza 22: în așteptare
