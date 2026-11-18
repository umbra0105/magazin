# Sursa pentru județe și localități (SIRUTA) — propunere pentru Faza 9

**Stare:** sursa a fost **aprobată** de utilizator (INS, SIRUTA semestrul 1 din 2026, varianta A, CC BY 4.0). Încărcarea e **oprită la 🛑** de la verificarea cifrei de control (vezi secțiunea 7).
**Întocmit:** 2026-11-18, la începutul Fazei 9. Citirea paginilor s-a făcut doar în browser/HTTP (fără descărcarea fișierelor de date).

**Aprobare:** «Sursa SIRUTA aprobată: INS, registrul SIRUTA semestrul 1 din 2026, varianta A (CSV de pe data.gov.ro), licență CC BY 4.0», 2026-11-18. Fișierul stă în `local-data/siruta/` (necomis).

## 1. Ce este și cine o publică

SIRUTA este registrul oficial al unităților administrativ-teritoriale din România (județe, municipii/orașe/comune, localități componente). Pagina INS spune că responsabilul de diseminare este **Institutul Național de Statistică (INS)**, iar autoritatea emitentă este Guvernul României, Departamentul pentru administrația locală. Ierarhia are trei niveluri (cifrele de pe pagina INS, versiunea din 30 iunie 2026): **42** de județe (inclusiv Municipiul București), **3.181** de unități administrativ-teritoriale, **13.755** de localități componente (sate, sectoare), în total 16.978 de coduri. Codul are 6 cifre, cu cifră de control.

## 2. URL-uri oficiale (cele două pagini citite)

| Ce | URL | Observații |
|---|---|---|
| Pagina INS a registrului | https://insse.ro/cms/ro/siruta | «Ultima actualizare: 30 iunie 2026». Oferă două arhive `.rar`: «SIRUTA AN» (2025) și «SIRUTA SEMESTRU» (2026, S1), cu «Fișier MS-ACCES (cu diacritice)» și «Fișier Excel». |
| Arhiva semestrului curent (INS) | https://insse.ro/cms/files/siruta/2026/SIRUTA_S1_2026.rar | Format `.rar`: nu se poate despacheta fără un program pe care nu-l instalez fără aprobare. |
| Metodologie (INS) | https://insse.ro/cms/files/siruta/2026/Metodologie.doc | Nedescărcată. |
| Același registru pe portalul de date deschise | https://data.gov.ro/dataset/siruta_s1-2026 | Publicator: INS. Creat 24 iulie 2026, actualizat 11 august 2026. Resursă **CSV** `siruta_s1_2026.csv` (direct, fără arhivă). |
| Legenda câmpurilor (INS) | https://data.gov.ro/dataset/legenda-siruta-registrul-unitatilor-administrativ-teritoriale-ale-romaniei | `Legenda-SIRUTA.xlsx`: numele câmpurilor și semnificația, nivelurile, tipurile de localități. Nedescărcată. |

Pagina INS nu enumeră numele coloanelor (menționează proprietățile TIP, MED, REG, ZONA, FSL; FSL este un factor intern de sortare și de relație copil–părinte). **Coloanele exacte le verific din legendă și din fișier abia după aprobare**; dacă nu se potrivesc cu ce presupune planul de mai jos, mă opresc.

## 3. Licență și condiții de reutilizare (corectat după aprobare, 2026-11-18)

- **Pentru fișierul folosit (`siruta_s1_2026.csv`, setul https://data.gov.ro/dataset/siruta_s1-2026) se aplică licența **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/)**, așa cum a confirmat utilizatorul pe pagina setului. Aceasta e licența setului; ea înlocuiește ce scria aici înainte.
- Nota generală de pe insse.ro (https://insse.ro/cms/ro/content/copyrightro-0) trimite la OGL-ROU-1.0 (`http://data.gov.ro/base/images/logoinst/OGL-ROU-1.0.pdf`); setul vechi «SIRUTA» (2014) de pe data.gov.ro are și el OGL-ROU-1.0. Pentru **acest** fișier nu se aplică ele, ci CC BY 4.0.
- Condițiile CC BY 4.0 care ne privesc: atribuire (creditul sursei), link către licență, mențiunea că datele au fost modificate, fără formulări care sugerează că titularul ne susține. Redistribuirea (fișierul derivat din repo) și folosirea comercială sunt permise cu aceste condiții.
- **Atribuirea (decizia utilizatorului):** doar în `THIRD-PARTY-NOTICES.md` și în metadatele seed-ului (nu într-un loc vizibil din aplicație, fiindcă legea nu o cere acum). Text: «Institutul Național de Statistică (INS), registrul SIRUTA, semestrul 1 din 2026», linkul către licență, mențiunea «Date modificate: coloane selectate, diacritice normalizate» (la afișare numele se transformă și din majuscule în litere mici cu inițiale mari; mențiunea se completează cu asta), fără nicio formulare care să sugereze susținerea INS.

## 4. Două variante de încărcare (cer decizia ta)

**A. CSV de pe data.gov.ro (recomandat).** Fișierul `siruta_s1_2026.csv`, fără arhivă, deci nu cere niciun program nou. Tu îl descarci manual (sau îmi spui explicit să-l descarc) într-un folder din `local-data/` (necomis).
**B. Fișierul Excel din arhiva `.rar` de pe insse.ro.** Aceeași sursă de bază, dar `.rar` cere un dezarhivator pe care nu-l instalez fără aprobare; Excel-ul îl poți extrage tu.

În ambele cazuri **nu comit fișierul brut**. Comit doar, dacă licența o permite și o aprobi, un fișier derivat compact (județ, cod SIRUTA, nume, cod părinte, tip), cu atribuirea sursei și versiunea, ca instalarea să aibă datele fără acces la internet (pachetul e instalabil). Fără acest fișier, instalarea ar depinde de o descărcare, ceea ce nu vreau pentru un pachet.

## 5. Cum se va încărca și cum se actualizează (după aprobare)

1. **Tabele aditive** (migrare nouă, fără `DROP`/`DELETE`): județ și localitate cu `sirutaCode` unic, `parentSirutaCode`, nume cu diacritice, tip, `isActive`, `sourceVersion`.
2. **Încărcare** printr-o comandă `siruta:import` (script în `packages/db`, Zod la intrare): citește fișierul cu calea dată; verifică structura și **cifra de control** a fiecărui cod; refuză tot dacă un rând e greșit (tranzacție unică); idempotent (rulat de două ori, același rezultat).
3. **Seed:** `db:seed` rulează comanda pe fișierul derivat din repo. **Teste: numai set fictiv mic** (câteva județe și localități inventate), niciodată fișierul real.
4. **Actualizare:** INS publică semestrial (ianuarie și iulie). Reîncărcarea cu fișierul nou produce un raport de diferențe (noi / redenumite / dispărute). Un rând dispărut se **marchează inactiv**, nu se șterge (comenzile vechi păstrează adresa ca snapshot oricum). Versiunea încărcată se ține într-o setare și se vede în admin.
5. **Cod poștal:** SIRUTA nu are coduri poștale. Singurul set public cu poștale legate de SIRUTA e al Poștei Române, din 2016, deci îl **consider învechit** și nu-l propun. În Faza 9 codul poștal rămâne câmp introdus de client, cu validare doar de format (6 cifre); nu cer sursă pentru el acum.

## 6. Ce NU fac până la aprobare

Nu descarc nimic în repo, nu instalez nimic, nu scriu migrarea, seed-ul sau codul care depinde de această sursă. Restul Fazei 9 (cod fără date reale SIRUTA) începe abia după mesajul tău de aprobare, cum ai cerut.

## 7. Verificarea fișierului (2026-11-18, înainte de orice cod)

Verificat cu un script de probă (în afara repo-ului, doar numere), pe `local-data/siruta/siruta_s1_2026.csv` (UTF-8 cu BOM, separator «;», 16.978 de rânduri), față de **Metodologie.doc** (INS): [https://insse.ro/cms/files/siruta/2026/Metodologie.doc](https://insse.ro/cms/files/siruta/2026/Metodologie.doc).

- **Coloane:** `SIRUTA;DENLOC;CODP;JUD;SIRSUP;TIP;NIV;MED;REGIUNE;FSJ;NUTS;LAU`. Corespund planului: cod, nume, cod părinte (`SIRSUP`), tip (`TIP`), județ (`JUD`). **Observație:** fișierul conține și `CODP` (cod poștal pe localitate). Conform deciziei, **nu se stochează**: codul poștal rămâne câmp introdus de client, validat doar ca format.
- **Numărătoare:** 16.978 de rânduri; nivelurile NIV 1/2/3 = 42 / 3.181 / 13.755, **identic** cu pagina INS. Fără coduri duplicate. Tipuri (din metodologie): 40 județ, 6 sector al Municipiului București, 1–5 municipii și orașe, 3 comună, 9–11 și 17–19 localități componente, 22–23 sate.
- **Sectoare:** există 6 rânduri cu `TIP = 6` (sectoarele 1–6, cu `JUD = 40` și părintele 179132 = Municipiul București), deci condiția 4 se poate îndeplini.
- **Diacritice:** numele sunt în **majuscule**, cu sedilă (`Ţ`, `Ş`) în mare parte și câteva cu virgulă (`Ș`): normalizarea la ș/ț e necesară.
- **Cifra de control:** algoritmul oficial din metodologie (secțiunea «Codul de identificare SIRUTA»): primele 5 cifre ale codului de 6 cifre (completat cu zerouri la stânga) se înmulțesc cu ponderile **7, 5, 3, 2, 1**; produsele se adună **cifră cu cifră** (35 contează 3+5); restul sumei la 10 se scade din 11; restul acelui rezultat la 10 e cifra de control. Exemplul din document: 179132 → 17913 → 29 → rest 9 → 11−9 = 2 → cifra 2. Implementarea mea reproduce exemplul.
- **🛑 Datele nu respectă algoritmul pentru 77 de coduri din 16.978 (0,45%).** 16.901 coduri îl respectă, inclusiv toate cazurile cu rest 0 (1.685 din 1.693); cele 77 sunt răspândite uniform pe toate resturile, deci nu e o diferență de interpretare a algoritmului. Sunt **68 de comune (`TIP 3`) și 9 sate (`TIP 23`)**, din 15 județe (JUD 1–5, 7–10, 12–14, 16, 17, 19), cu coduri între 9019 și 86519. Sectoarele și județele trec. Metodologia nu spune nimic despre excepții.
- **Decizie cerută (🛑, regula din prompt):** cum tratăm cele 77. Opțiuni în raportul din sesiune.

## Surse citite

- https://insse.ro/cms/ro/siruta
- https://insse.ro/cms/ro/content/copyrightro-0
- https://data.gov.ro/dataset/siruta
- https://data.gov.ro/dataset/siruta_s1-2026
- https://data.gov.ro/dataset/legenda-siruta-registrul-unitatilor-administrativ-teritoriale-ale-romaniei
- https://data.gov.ro/dataset/coduri-postale-romania
- https://insse.ro/cms/files/siruta/2026/Metodologie.doc
