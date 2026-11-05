# Faza 5 (Stoc) — bilanț la închidere

Întocmit la punctul (14). Răspunde la patru întrebări: ce am amânat conștient și de ce, ce datorie tehnică s-a strâns, ce așteaptă răspunsuri de la contabil sau avocat și ce trebuie făcut înainte de Faza 6. Fiecare element are trimiterea lui în `docs/06-todo-master.md` (numărul fazei) sau în `docs/PROGRESS.md`.

## 1. Ce s-a livrat

Cele 14 puncte ale planului (`docs/FAZA-5-plan.md`): schema și migrația; cantități exacte (`bigint`, 4 zecimale); unități, pas de vânzare și conversia SmartBill; disponibilitatea în pași cu restul nevandabil; rezervare, angajare și oglindire cu garanția «fără stoc negativ» în bază; ajustări cu ora efectivă; joburi (expirare, sincronizare veche, curățare); ecranul Stoc cu istoric și «Stoc mic»; tabul Stoc din produs, brand și listă, prețul pe unitate și pe pas, coloane de import/export; contoarele din Panou; «Anunță-mă când revine» (partea de server și emailul); importul «stoc la zi» din SmartBill și «Pornește gestionarea»; multi-depozit în spatele steagului `multiWarehouse` (serviciu, transfer, ecranul Depozite, selectorul și dialogul de transfer). La închidere: testul de concurență final, acoperirea față de cerințe (`docs/FAZA-5-acoperire-teste.md`) și ghidul de verificare cap-coadă (`docs/FAZA-5-verificare-manuala.md`).

## 2. Ce am amânat conștient, și de ce

| Ce | De ce nu acum | Unde se face |
| --- | --- | --- |
| **Sincronizarea prin API cu SmartBill** (poza prin API, nu prin fișier) | Documentația API se citește înainte de implementare; până atunci stocul vine din exportul «Stoc la zi» încărcat de mână (decizia D1) | Faza 13 / 15 |
| **Rezervarea prin coș și plată**, angajarea la plasare, `reservationExpiresAt` în checkout | Coșul, plata și comanda nu există | Faza 9–10 (în TODO) |
| **Cheie străină spre `Order`/`OrderLine`** în locul referinței generice (tip + id) a angajării, cu validarea datelor existente | Nu exista `Order` când s-a construit angajarea; testele de concurență din Faza 5 se rulează din nou pe schema nouă | Faza 9 |
| **Formularul și ruta publică «Anunță-mă»**, textul GDPR | Vitrina nu există (formular: Faza 7); textul legal merge cu restul textelor legale | Faza 7 / 18 |
| **Emailul «sincronizarea SmartBill e neactualizată»** | Panoul și bannerul avertizează deja; emailul vine cu modulul de emailuri de admin. Jobul scrie în audit (`stock.snapshot.stale` / `recovered`) | Faza 11 |
| **Calendarul zilelor nelucrătoare** pentru expirarea transferului bancar | «Zile lucrătoare» e acum luni–vineri; setarea `regional.nonWorkingDates` se adaugă odată cu checkout-ul care o folosește | Faza 10 |
| **Greutatea liniei = greutate pe unitate × cantitate** | Transportul nu există | Faza 12 |
| **Unitatea în care se trimite stocul către eMAG** (`ChannelListing.stock` e `Int?`, stocul nostru e `Quantity` cu pas) | De decis cu datele reale ale canalului | Faza 22b |
| **Motorul de prețuri cu cantitate `bigint`** și regula finală de rotunjire pe linie (R1/R2, provizorie) | Rotunjirea ține de motorul de prețuri și de răspunsul contabilului | Faza 8 |
| **Termen/stare în coș și plată, selector în pași, validarea pasului la adăugare și plasare, ramburs la «La comandă», coșuri mixte** | Fac parte din checkout | Faza 9 |
| **Ora facturii pe comandă, unitățile/zecimalele/rotunjirea SmartBill, cele 20 de cazuri numerice, lista «comenzi fără factură»** | Facturarea nu există | Faza 13 |
| **Livrarea pe părți** pentru coșuri mixte (acum «toată odată») | Decizie D6: se reia dacă stocul rămâne blocat în «angajat» | După lansare |
| **Bifa «vinde și restul»** (rest nevandabil) | Încalcă regula că orice cantitate comandată e multiplu de pas; restul se rezolvă prin ajustare/inventariere | Nu se face (decizie) |
| **Tamponul de siguranță** | Coloana `safetyBuffer` există și intră în calculul disponibilului, dar nu are ecran sau setare cu valoare implicită; de decis valoarea (D1.5, punctul 4) | Înainte de lansare |
| **Inventariere ghidată (stock take), rapoarte de rotație, raportul săptămânal de diferențe aplicație ↔ SmartBill** (`docs/04` §5.5, D1.5 punctul 7) | Fac parte din rapoarte; azi inventarierea se face prin ajustare cu motivul «Inventariere (corecție)» sau prin importul «stoc la zi» | Faza 20 |
| **Pornirea steagurilor și editarea setărilor `inventory.*` din interfață** | Paginile Setări și Utilizatori sunt încă placeholder | Faza 16 (azi: `dev:flag` și Prisma Studio) |

## 3. Datoria tehnică acumulată în Faza 5

| Datorie | Risc | Unde |
| --- | --- | --- |
| **Ecranul Stoc: filtrele de tip și de stare se aplică în memorie**, pe cel mult 5.000 de variante (peste: mesaj «precizează căutarea») | Lent pe un catalog foarte mare | TODO Faza 20 |
| **`prepare` și `ajustarea` din `stock-service.ts` citesc `variant.product.*` fără pază** după un `select` imbricat (același tipar ca defectul reparat la 9c) | `TypeError` dacă un produs dispare între interogări; risc mic azi, relevant când apar coșul și comenzile | TODO Faza 20 (de păzit la Faza 9) |
| **Rotunjirea e provizorie:** R1/R2 și afișarea «≈» a prețului pe pas | Pot cere schimbare după răspunsul contabilului | TODO Faza 8 |
| **Scripturile dev-only** (`dev:seed-stock`, `dev:stock-race`, `dev:stock-adjust`, `dev:stock-jobs`, `dev:back-in-stock`, `dev:availability`, `dev:flag`) | Nu trebuie să ajungă în pachetul distribuit | TODO Faza 21 |
| **Fixture-urile de stoc șterg date, inclusiv registre imuabile** (singurele excepții de la triggere: `e2e-support.ts` și `stock-fixtures.ts`, păzite de `append-only`) | Nu trebuie să intre în pachet sau în imagine | TODO Faza 21 (`.dockerignore`); test `test-utils-isolation` |
| **`ecom_test` păstrează rânduri `audit_log` comise de E2E** (`stock.transfer` etc.), care nu se pot șterge (triggerul e regulă permanentă) | Cresc în timp; testele de integrare nu presupun un jurnal gol | `CLAUDE.md` (regula `audit_log`) |
| **Curățarea comună E2E poate șterge rolurile `e2e-…` ale altui fișier** când rulează în paralel (2 lucrători) | Teste intermitente; rolul `e2e-depozite-citire` e deja exclus și curățat de fișierul lui | Notă la fixture-uri, `e2e-support.ts` |
| **Un singur steag global în E2E:** testele care pornesc `multiWarehouse` trebuie să stea în același fișier (`warehouses.spec.ts`, serial) | Două fișiere care pornesc steagul s-ar încurca | Regulă de lucru, în PROGRESS (13c–13d) |
| **Widget-uri native în afara limbii aplicației:** `datetime-local`/`date`, `type="number"`, `type="search"`, `<select>` nativ | Text în limba browserului | `CLAUDE.md`; Faza 17/18 |
| **Import de 5.000 de rânduri: fără probă de timp și memorie** și import de imagini doar pe stocare locală în teste | Surprize la un catalog real | PROGRESS (datoriile din 15b), de tratat la verificări de performanță |
| **Dependențe cu avertismente de audit, doar urmărite** (`deepmerge-ts`, `mysql2`, `fast-uri`, `deepmerge`, `postcss`) și SheetJS din `vendor/` | Reverificare la fiecare actualizare | TODO Faza 20 |
| **`pnpm.exe`/`turbo.exe` blocate pe PC-ul utilizatorului** (mediu, nu produs) | Comenzile locale diferă de cele din CI | `CLAUDE.md` |

Datoria mai veche, nescoasă de Faza 5 (audit netranzacțional, `force-dynamic`, setări/utilizatori placeholder, memoria pe încărcări mari etc.) rămâne în blocurile «Datorie tehnică» din `docs/PROGRESS.md`, fiecare cu faza ei.

## 4. Ce așteaptă răspunsuri de la contabil sau avocat

**Contabil** (`docs/INTREBARI-CONTABIL.md`). Din 2026-10-28 există răspunsuri verbale (stoc 0 → SmartBill refuză factura cu descărcare de gestiune activă; 2 zecimale la cantitate, rotunjire la cea mai apropiată cifră; kg în kg, sacul ca bucată; «La comandă» facturat la plată sau, la ramburs, la expediere). **Lipsesc în scris**, iar următoarele sunt încă deschise:

| Întrebare | Ce blochează |
| --- | --- |
| **2.** Unitatea și zecimalele stocului în SmartBill pentru cele 6 produse | Configurarea conversiilor la sincronizare (Faza 13/15) |
| **4.** Rotunjirea: pe fiecare linie sau pe totalul facturii | **Regula finală R1/R2** (acum provizorie) și «≈» din prețul pe pas; Faza 8 și 13. **Decizie de bani/TVA: 🛑 când vine momentul** |
| **6.** Restul rămas dintr-un ambalaj vândut în magazinul fizic | Cum se ajustează restul nevandabil |
| **8.** Ramburs refuzat la un produs adus special | Regula «ramburs interzis la produse La comandă» (Faza 9) |
| **9–11.** Vouchere cadou, puncte de loialitate, transportul la retur parțial | Fazele 15b și 14 (nu blochează stocul) |

**Avocat** (`docs/INTREBARI-AVOCAT.md`, încă «de trimis»): **1.** termenul de livrare la «La comandă» și la coșuri mixte (30 de zile, termene mai lungi, furnizor care nu mai poate livra, anulare, ramburs); **3.2.** «Anunță-mă» (o singură trimitere, ștergerea adresei, temeiul GDPR); **3.1.** jurnalul de audit și dreptul la ștergere; **4.** dreptul de retragere pentru ambalaje (rolă, cutie, sac sigilat), produse tăiate la cerere, informări pentru produse chimice. Termenul legal de livrare atinge plata, deci nu se decide în cod.

## 5. Ce trebuie făcut înainte de Faza 6

1. **Încheierea Fazei 5:** închisă pe 2026-11-05, la cererea utilizatorului: push → «CI verde» → tag-ul adnotat `faza-5-completa` (mesaj: «verificare manuală cap-coadă nefăcută»).
   **PUNCT DESCHIS:** verificarea manuală cap-coadă de către utilizator: nefăcută la închidere (2026-11-05); ghidul (`docs/FAZA-5-verificare-manuala.md`) rămâne disponibil și se poate parcurge oricând; orice defect găsit ulterior se repară în commit separat de fix.
2. **Punctul (15c) din Faza 4: descrierea bogată** (HTML sanitizat, editor, randare în storefront), **înainte de Faza 6**, apoi reimportul descrierilor din exportul WooCommerce (TODO Faza 4).
3. **Skill-ul `frontend-design` pentru storefront:** aduci fișierul `SKILL.md`, îl citim integral, verificăm că nu contrazice `CLAUDE.md`, abia apoi îl punem în `.claude/skills/` (TODO Faza 6, primul pas).
4. **Alegi cele 3–5 magazine de referință UX** (punctul din Faza 0; intră în verificarea skill-ului).
5. **Nu blochează Faza 6, dar e bine de hotărât curând** (lista «înainte de lansare»): cine face sincronizarea zilnică SmartBill și la ce oră; valoarea implicită a tamponului de siguranță; dacă mai vrei adăugiri la ghidul de verificare.
