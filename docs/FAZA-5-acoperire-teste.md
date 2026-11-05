# Faza 5 — acoperirea testelor față de cerințe

Întocmit la punctul (14), pe codul de la închiderea fazei. Fiecare rând: cerința (din `CLAUDE.md`, `docs/FAZA-5-plan.md` și `docs/06-todo-master.md`) → testul care o apără.
Tipuri: **U** unitar · **I** integrare (Postgres real) · **E** E2E (browser, build de producție) · **A** test de arhitectură (citește sursa). Fișierele sunt date fără cale; se găsesc cu `git ls-files | grep <nume>`.

Golurile găsite la această trecere sunt marcate **GOL → umplut** și au testul adăugat, scris și văzut pica pe o mutație a sursei reale (fără nicio schimbare de comportament). Golurile care rămân deschise sunt la final.

## 1. Schema și constrângerile bazei de date (punctul 1)

| Cerință | Test |
| --- | --- |
| Cantități `BIGINT` nenegative și plafonate; `physical`, `reserved`, `committed` ≥ 0 (fără stoc negativ, garantat în bază) | I `stock-schema` («InventoryItem») |
| Unic per variantă + depozit; `IS NULL` explicit în CHECK-urile compuse, cu cazul «una setată, una nulă» | I `stock-schema` (toate grupurile) |
| Unități de măsură: cod, zecimale 0–4, «buc» de sistem; pas, minim, bază de preț, conversie SmartBill pe produs și pe variantă | I `stock-schema` («unități…», «unitate, pas și bază de preț») |
| Depozit: cod unic, un singur implicit | I `stock-schema` («depozite»); I `base-seed` |
| `StockMovement` imuabil (fără UPDATE/DELETE, triggerul nu se oprește în teste) | I `stock-schema` («StockMovement»); U `append-only` |
| Rezervare și angajare: stări, unicitate (aceeași comandă nu angajează de două ori aceeași variantă), referință generică | I `stock-schema` («StockReservation», «StockCommitment») |
| `BackInStockAlert`: o cerere în așteptare per adresă + variantă, adresă validă | I `stock-schema`; I `back-in-stock` |
| Constantele din cod oglindesc CHECK-urile din bază | I `stock-schema` («constantele din cod oglindesc…») |
| Unități de bază și «Depozit principal» create de seed, fără dubluri la a doua rulare | I `base-seed`, `base-seed.upgrade` |
| **Migrarea de date D2:** produsele și variantele existente fără rând de stoc trec pe «negestionat»; cele cu stoc, cele care moștenesc și `updatedAt` nu se ating | **GOL → umplut** I `stock-data-migration` (rulează instrucțiunile din fișierul migrației într-o tranzacție anulată; pică dacă migrația își schimbă forma) |
| Setările `inventory.*`: valori implicite și limite | U `registry`, `settings-service.more` |

## 2. Cantități exacte și unități (punctele 2–3)

| Cerință | Test |
| --- | --- |
| Citire și formatare cu virgulă, fără `float`; 3 × 2,03 = 6,09; 10 × 0,3 pe 1,0 | U `quantity` |
| Multiplu EXACT de pas, număr de pași, depășiri și plafoane, erori tipate | U `quantity` |
| Preț × cantitate exact (`bigint`), fără regulă de rotunjire; preț pe pas ÷ pas | U `quantity` |
| Nicio cantitate ca număr zecimal în codul de stoc (`Math.round`, `Number(...)`, `toFixed`, `parseFloat` interzise) | A `quantity-arithmetic` (cu cazuri sintetice, ca testul să nu poată trece în gol) |
| Unitatea nulă = «buc», fără zecimale; «buc» nu se dezactivează, nu își schimbă codul | U `units`, `measure-unit-service`; I `measure-unit-store`; E `measure-units` |
| Pasul față de zecimalele unității; pasul efectiv (variantă → produs → unitate) | U `sale-config`; I `sale-config` |
| Conversia SmartBill: orice comandă valabilă se convertește exact; refuz cu explicația | U `sale-config`; I `sale-config`; E `measure-units` |
| Unitățile din raportul SmartBill: tabel explicit, fără deosebire de litere și diacritice | U `smartbill-units` |
| Cele 6 produse-model configurate (mozaic, bisulfat, abachi cu 4 pași) | E `measure-units`; U `stock-overview`; I `stock-overview` |
| Prețul pe unitate și pe pas, «≈» doar când suma nu iese exactă | U `price-display`; E `price-display` |

## 3. Disponibilitate, stări, rezervare și angajare (punctele 4–5)

| Cerință | Test |
| --- | --- |
| Disponibil = Fizică − Angajat − Rezervat, niciodată sub 0; în pași; restul nevandabil (100 mp, pas 41,25 → 2 pași, rest 17,5) | U `availability` (tabel calculat de mână + referință cu fracții exacte) |
| Trei ramuri explicite: negestionat, «La comandă», gestionat; digitalele mereu disponibile; hibrid doar cu `allowBackorder` | U `availability`; I `stock-service` («clasificarea liniilor») |
| Termenul de livrare: produs → brand → global; coșuri mixte: termenul cel mai lung | U `availability`, `product-stock`; I `product-stock` |
| Negestionat: zero rânduri de stoc, zero rezervări, zero decrement | I `stock-service`, `stock-concurrency` («coșuri cu linii negestionate»); I `woo-import` (regula D2) |
| Rezervare dintr-o singură comandă SQL condiționată, toate liniile sau nimic, idempotentă | I `stock-service`, `stock-concurrency` |
| Expirarea: card 15 minute, ramburs imediat, transfer bancar 3 zile lucrătoare; expirare și la citire | U `workdays`; I `stock-service`, `stock-maintenance` |
| Cronologia D1: o bucată se scade o singură dată (factură înaintea pozei = oglindită, după ea = angajată) | U `reconcile` (inclusiv simulare pe ore); I `stock-service` («oglindire»), `stock-concurrency` («poza față de rezervări») |
| **Concurența, pe Postgres real, cu date comise:** 10 cereri/stoc 1; 100/stoc 10; 10 × 0,3 pe 1,0 → 3; liner 5 cereri pe 100 mp → 2; webhook dublu; confirmare vs expirare; coș mixt; cursa poză vs factură; aceeași comandă angajată de două ori | I `stock-concurrency` |
| **Testul de concurență FINAL:** toate operațiile (rezervare, eliberare, confirmare, angajare directă, ajustare ±, transfer în ambele sensuri, expirare) deodată pe aceleași rânduri, în 2 valuri cu rezervări îmbătrânite între ele: fără deadlock, nimic negativ, contoare egale cu rândurile, fără supravânzare, registrul explică stocul, transferul conservă totalul | **GOL → umplut** I `stock-final-concurrency` (4 mutanți pe sursa reală: fără `FOR UPDATE`, expirarea fără contor, rezervarea fără condiția de disponibil, intrarea transferului cu 1 în plus — toți prinși) |

## 4. Ajustări, joburi, alerte (punctele 6, 7, 10)

| Cerință | Test |
| --- | --- |
| Motive fixe (D8), semnul după motiv, precizia unității; pasul NU se aplică la ajustări fizice | U `adjustment-rules`; I `stock-adjustment` |
| Ora efectivă; poza înlocuiește ajustările dinainte și le păstrează pe cele de după | U `adjustment-rules`, `reconcile`; I `stock-adjustment`; E `stock` |
| Refuz sub 0 și peste plafon; avertismente `effective_before_snapshot`, `below_commitments` | I `stock-adjustment`; E `stock` |
| Concurență la ajustări: 10 × -1 pe stoc 5 → 5; 100 × -1 pe stoc 10 → 10 | I `stock-concurrency` («ajustări fizice»), `stock-final-concurrency` |
| Joburi: expirarea rezervărilor (lot plin, două instanțe deodată), «poza e prea veche» (o singură alertă), curățarea cererilor vechi | U `stock-maintenance`, `stock-jobs`; I `stock-maintenance`, `stock-maintenance-concurrency` |
| Prag «stoc mic» în pași, propriu pe variantă sau global; vederea «Stoc mic» ordonată după urgență | I `stock-threshold`; U `stock-overview`, `stock-alerts`; I `stock-overview`; E `low-stock` |
| Contoarele din Panou doar cu `inventory.read` (fără drept, nici interogarea nu rulează) | I `stock-overview` («alertele din Panou»); E `low-stock`, `stock` |

## 5. Admin Stoc, tabul din produs, listă (punctele 8–9)

| Cerință | Test |
| --- | --- |
| Pe variantă: Fizică (valabilă la), Angajat, Rezervat, Disponibil, Rest; bannerul La zi / Neactualizat / Neimportat | U `stock-overview`, `stock-time`; I `stock-overview`; E `stock` |
| Produsul care dispare între interogări nu aruncă `TypeError` (9c) | U `stock-overview-store` |
| Adresa (căutare, filtre, paginare, vedere, motiv, depozit) | U `stock-url`, `stock-view`, `stock-form` |
| Ajustare din admin: permisiuni, validări proprii în română, audit cu înainte/după | U `stock-adjustments`, `stock-form`; E `stock`, `low-stock` |
| Tabul Stoc din produs: gestionat ↔ negestionat, hibrid, termen, suprascriere pe variantă, denumirea pasului | I `product-stock`; E `product-stock-tab`; U `product-stock` |
| Cantitățile se REDACTEAZĂ pe server pentru cine nu are `inventory.read` | U `product-stock` («redactRowQuantities»); I `product-stock`; E `product-stock-tab` |
| Coloana «Stoc» și coloana «Preț» din listă; termenul implicit pe brand | E `product-stock-tab`, `price-display` |
| Coloane de stoc în import/export (virgulă zecimală, pe produs sau pe variantă) | U `import-plan-sale`, `export-rows` |
| Prețul de achiziție nu apare în nicio suprafață de stoc | A `cost-exposure` (orice fișier nou care îl numește pică) |

## 6. «Anunță-mă», importul «stoc la zi», pornirea gestionării (punctele 11–12)

| Cerință | Test |
| --- | --- |
| Cerere neutră și idempotentă, plafoane pe adresă și pe variantă, adresa nu apare în erori | I `back-in-stock`; U `back-in-stock` |
| Trimitere o singură dată (`claim` atomic), cereri simultane, adresa nu ajunge în Redis | I `back-in-stock-concurrency`, `back-in-stock-delivery`; U `email-processor`, `render` |
| Importul: gestiuni din setare, cantități exacte, potrivire pe SKU, unitate diferită = eroare, conversie cu rotunjire în jos + avertisment | U `stock-report-plan`, `stock-report-time`; I `stock-report-import` |
| Cititorul de fișier `.xls` / `.xlsx`; refuz pentru ce nu e Excel | U `stock-report-reader` (integrations), `stock-report-reader.contract`; E `stock` |
| Toată-sau-deloc; a doua rulare «neschimbate»; amprenta; import în timp ce se rezervă stoc | I `stock-report-import`, `stock-report-import-concurrency`; E `stock` |
| Încărcare: Origin, sesiune, drept, tip din octeți, dimensiune | U `stock-report-upload`, `stock-activation-upload`; E `stock` |
| «Pornește gestionarea»: previzualizare, confirmare explicită, o tranzacție cu cantitățile, plafon, variante cu suprascrieri | U `stock-activation-plan`; I `stock-activation`, `stock-activation-concurrency`; E `stock` |
| Regula D2 în importul WooCommerce (negestionat, «în stoc», «buc») | I `woo-import`; U `woo-plan` |

## 7. Multi-depozit (punctul 13)

| Cerință | Test |
| --- | --- |
| Steagul oprit = invizibil ȘI inert: meniu, rută, acțiuni, selector, transfer, serviciu (înaintea drepturilor și a bazei) | A `multi-warehouse-flag.architecture` (cu cazuri sintetice); U `warehouse-service`, `stock-transfer`, `warehouse-selection`; E `warehouses` |
| Un depozit în plus nu schimbă nimic din ce nu îl cere explicit (import, rezervări, disponibilitate) | I `multi-warehouse-isolation` |
| CRUD depozite: cod stabil din nume, implicitul nu se dezactivează, cu stoc nu se dezactivează | U `warehouse-service`; I `warehouse-service`; E `warehouses` |
| Transfer: două mișcări legate, niciodată sub angajat + rezervat, pas și unitate, orice eroare anulează tot, avertismentul despre poza SmartBill | I `stock-transfer`; U `stock-transfer`; E `warehouses` |
| Concurența transferului: sens opus (fără deadlock), din aceeași sursă, cu rezervări, zecimale | I `stock-transfer-concurrency`, `stock-final-concurrency` |
| Selectorul din Stoc și dialogul de transfer: doar cu steagul pornit și mai mult de un depozit activ; `?depozit=` ignorat altfel | U `warehouse-selection`; E `warehouses` (11 teste, inclusiv telefon) |

## 8. Drepturi, audit, interfață (transversal)

| Cerință | Test |
| --- | --- |
| `inventory.read` / `inventory.write`: Owner, Admin, Manager, Depozit; Editor, Suport, Contabil nu; scrierea implică citirea | **GOL → umplut** U `rbac/catalog` (2 teste; mutant «Depozit fără inventory.write» prins). Înainte, rolurile le apărau doar testele E2E |
| Toate scrierile de stoc din admin trec prin `withPermission` și `auditLog()`; refuzul se auditează fără valori | U `stock-adjustments`, `stock-transfer`, `warehouse-service`; A `admin-pages-guard`, `admin-routes-guard`, `denied-audit-gate` |
| Auditul de stoc are actor și înainte/după | E `stock`, `low-stock`, `warehouses` |
| Fără `window.confirm` / validare nativă / `<input type="file">` direct | A `native-widgets`, `file-input` |
| Meniul: o singură intrare «Catalog», «Stoc» și «Depozite» ca sub-elemente, după drept și steag | A `admin-navigation`; U `admin-nav`; E `admin-navigation` |
| Telefon: fără derulare orizontală (Stoc, Stoc mic, Panou, Depozite, transfer) | E `low-stock`, `warehouses` |
| Fixture-urile de stoc refuză orice bază fără «test» în nume; nu intră în pachet | U `stock-fixtures`; I `e2e-support-stock`; A `test-utils-isolation` |
| Fără date calendaristice fixe care pot trece din viitor în trecut (regula din `CLAUDE.md`) | Verificat la punctul 14 cu o căutare a `new Date("20…")` și `Date.UTC(20…)` în testele de stoc, jobs și E2E: toate datele fixe sunt fie în trecut (2026-10-20…29, cu ceasul INJECTAT în serviciu), fie în 2099; niciuna nu poate trece din viitor în trecut, deci niciun test de stoc nu poate începe să pice doar din cauza datei |

## 9. Goluri rămase deschise

- **Rezervarea, angajarea și expirarea prin coș și plată (Faza 9–10):** serviciul e testat complet, dar fluxul real (coș → plată → webhook → comandă) nu există încă; testele de concurență din Faza 5 se rulează din nou pe schema nouă când angajarea primește cheie străină (în TODO, Faza 9).
- **Timp și memorie pe un catalog mare (~1.600 de produse, import de stoc, ecranul Stoc):** nu există un test automat de încărcare; filtrele de tip și de stare ale ecranului Stoc se aplică în memorie, până la 5.000 de variante (în TODO, Faza 20).
- **Raportul SmartBill real:** doar manual (fișierul nu intră în repo); verificat de utilizator la 12c și 12e.
- **Trimiterea emailurilor prin SMTP real și comportamentul Excel pe alte PC-uri (separator de listă «;»):** Faza 11 / 18.
- **Calendarul zilelor nelucrătoare** în expirarea transferului bancar: acum luni–vineri, fără sărbători (în TODO, Faza 10).
