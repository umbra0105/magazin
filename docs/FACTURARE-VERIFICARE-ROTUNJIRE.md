# Verificarea rotunjirii în SmartBill: ghid pas cu pas

**Pentru cine:** o persoană fără cunoștințe de programare. **Cât de important:** fără acest test, magazinul nu trece în LIVE cu facturarea (butonul «Treci în LIVE» e blocat pe server până confirmi testul). **Ce NU face Claude Code:** nu pornește niciodată acest test și nu emite nicio factură.

## De ce există testul

Magazinul calculează fiecare linie cu o singură rotunjire (jumătatea de ban se rotunjește în sus) și TVA-ul fiecărei linii din prețul ei cu TVA, iar TVA-ul comenzii e **suma TVA-urilor pe linii**. Nu știm încă dacă SmartBill calculează la fel. Dacă între ce a încasat magazinul și ce iese pe factură apare chiar și **1 ban** diferență, trecem la LIVE abia după ce hotărâm cu contabilul ce facem.

Exemplu din magazin: 6,09 mp × 123,45 lei = 751,81 lei (751,8105 rotunjit); coșul de probă 751,81 + 240,00 + 9.490,00 = 10.481,81 lei, cu TVA pe linii 1.819,15 lei (nu 1.819,16, cât ar da TVA-ul extras din total).

## Ce trebuie să ai

1. Un cont **SmartBill de test sau de probă** (NU contul real al firmei). Documentele emise la test sunt reale în acel cont.
2. În contul de test: o **serie de facturi** (de exemplu «FCT»), o **serie de proforme**, cota de TVA de 21% (numele ei, de exemplu «Normala») și **accesul API** activat (token din SmartBill Cloud → Contul meu → Integrări).
3. Aplicația pornită, cu contul tău de Owner.

## Pașii

1. Intră în admin → **Setări → Facturare**.
2. La cardul **SmartBill** completează: email-ul contului, tokenul API, CIF-ul, seria facturilor, seria proformelor, numele cotei de TVA. Lasă modul **«Mod test»**. Apasă **Salvează**.
3. Apasă **Testează conexiunea**. Trebuie să apară «Conectat la SmartBill (autentificare și serie verificate)». Dacă nu, corectează datele; nu merge mai departe.
4. Deschide un terminal PowerShell în folderul proiectului (`X:\360\magazin`) și rulează mai întâi **planul** (nu contactează SmartBill):

   ```powershell
   npm.cmd run facturare:verifica-rotunjirea
   ```

   Vezi cele 3 comenzi de probă cu totalurile așteptate (10.481,81 lei; 3.743,38 lei; 1.116,81 lei).
5. Rulează **testul propriu-zis** (emite 3 facturi în contul de TEST):

   ```powershell
   npm.cmd run facturare:verifica-rotunjirea -- --confirm-cont-de-test
   ```

6. La final apare un **raport**, salvat și în `local-data\verificare-rotunjire\<data>\raport.txt`, împreună cu cele 3 PDF-uri. Pentru fiecare comandă citești linia:
   - `Total pe factura SmartBill: … → IDENTIC` sau `DIFERENȚĂ de N bani`.
7. **TVA și liniile:** API-ul SmartBill nu dă înapoi TVA-ul pe linii. Deschide fiecare PDF și compară, pe fiecare linie, valoarea liniei și TVA-ul cu cifrele din raport (între paranteze, «din care TVA»), apoi TVA-ul total.
8. **Dacă totul e identic** (totalurile din raport și TVA-ul de pe PDF-uri): în **Setări → Facturare**, la cardul SmartBill, apasă **«Confirm testul cu cont real»** (conexiunea de test trebuie să reușească în acel moment). Abia apoi butonul **«Treci în LIVE»** devine posibil.
9. **Dacă apare orice diferență** (chiar 1 ban): NU apăsa nimic în plus, NU trece în LIVE. Trimite raportul (nu conține chei) și opțiunile se discută înainte de orice altceva.

## Ce vezi, în clar

| În raport | Înseamnă |
| --- | --- |
| `IDENTIC` | SmartBill a ajuns la același total ca magazinul, la ban. |
| `DIFERENȚĂ de 1 ban` (sau mai mulți) | Rotunjirea diferă: oprire, discuție cu contabilul. |
| `NECITIT` | SmartBill nu a dat totalul; verifică factura în SmartBill Cloud și compară cu mâna. |
| `NU s-a putut emite documentul` | SmartBill a refuzat factura (seria, cota de TVA, unitatea «mp»/«sac»/«buc» din cont): corectează în cont sau în Setări → Facturare → «Texte și unități pe factură» și rulează din nou. |

## Siguranță

- Cheile se citesc din setările salvate (criptate) și **nu apar** în raport, în terminal sau în fișiere.
- Scriptul refuză să emită dacă SmartBill e în modul LIVE.
- Fără `--confirm-cont-de-test` scriptul doar afișează planul.
- Clientul de pe facturile de probă e fictiv («CLIENT DE PROBA ROTUNJIRE»).
