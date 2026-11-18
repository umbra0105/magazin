# Sursa pentru județe și localități (SIRUTA) — propunere pentru Faza 9

**Stare:** 🛑 propunere, **neaprobată**. Nu s-a descărcat și nu s-a instalat nimic; nicio linie de cod nu s-a scris pentru ea.
**Întocmit:** 2026-11-18, la începutul Fazei 9. Citirea paginilor s-a făcut doar în browser/HTTP (fără descărcarea fișierelor de date).

**Cum aprobi:** lipești în sesiune `Sursa SIRUTA aprobată: <sursă, licență>` (poți alege varianta A sau B de mai jos sau altă sursă).

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

## 3. Licență și condiții de reutilizare (cum rezultă din surse, nu din memorie)

- Pagina de drepturi de autor a INS (https://insse.ro/cms/ro/content/copyrightro-0) spune că reutilizarea se face «numai conform licenței pentru o guvernare deschisă», cu trimitere la **OGL-ROU-1.0** (`http://data.gov.ro/base/images/logoinst/OGL-ROU-1.0.pdf`), și cere «indicarea clară și precisă a sursei».
- Setul «SIRUTA» (INS) de pe data.gov.ro (versiunea veche, 2014) are licența afișată **OGL-ROU-1.0**.
- **Neconfirmat de mine:** pagina setului `siruta_s1-2026` de pe data.gov.ro nu a arătat licența în textul citit; textul PDF-ului OGL-ROU-1.0 nu l-am citit. De aceea licența se aplică pe baza notei de pe insse.ro, nu a unei etichete a setului. Dacă vrei certitudine, deschide tu pagina setului și PDF-ul licenței înainte să aprobi.
- Consecințe practice dacă licența e OGL-ROU-1.0: reutilizare (inclusiv comercială) și redistribuire permise **cu indicarea sursei** (INS, SIRUTA, versiunea). Atribuirea o punem în `THIRD-PARTY-NOTICES.md` și în metadatele seed-ului. Textul exact al licenței se citește la aprobare; nu inventez condiții.

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

## Surse citite

- https://insse.ro/cms/ro/siruta
- https://insse.ro/cms/ro/content/copyrightro-0
- https://data.gov.ro/dataset/siruta
- https://data.gov.ro/dataset/siruta_s1-2026
- https://data.gov.ro/dataset/legenda-siruta-registrul-unitatilor-administrativ-teritoriale-ale-romaniei
- https://data.gov.ro/dataset/coduri-postale-romania
