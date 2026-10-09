# 10 — Registru de decizii

Toate deciziile proiectului, într-un singur loc. ✅ = decis · 🔴 = blochează dezvoltarea · 🟡 = decide până la faza indicată · 🟢 = opțional

---

# PARTEA I — Decizii luate

## Model de produs
| | Decizie |
|---|---|
| ✅ | **Pachet instalabil**: o instalare = un magazin, o bază de date. Fără multi-tenancy, fără `tenantId`. |
| ✅ | Branding 100% din panoul de admin: nume, logo, favicon, culori, fonturi, date firmă, texte legale |
| ✅ | Personalizările se fac prin setări, temă, blocuri CMS și `/extensions`. **Niciodată prin modificarea core-ului.** |
| ✅ | Livrare prin **Docker Compose** (pachet software, nu are legătură cu curierii) |
| ✅ | **TU faci instalarea la client**, nu clientul singur. Instalatorul poate fi mai simplu: verificări de bază, fără „prost-rezistență" extremă. Economie: ~2-3 zile |
| ✅ | **Primul magazin lansat e al tău.** Deci: construiești întâi magazinul funcțional, îl lansezi, abia apoi îl transformi în pachet instalabil |
| ✅ | **Migrare din site-ul existent: doar produsele**, prin import CSV. Fără clienți, fără comenzi, fără redirect-uri de URL |
| ✅ | Catalog: **~500 de produse publicate** (din portofoliu de ~1.000) → **Postgres FTS e suficient**, fără Meilisearch în Val 1 |

## Prețuri
| | Decizie |
|---|---|
| ✅ | Prețurile se stochează **BRUT, cu TVA inclus**, ca `int` în bani. `19900` = 199,00 lei |
| ✅ | **Un preț public unic**, identic pentru vizitator, persoană fizică și persoană juridică |
| ✅ | **Niciun preț nu se ascunde.** Vizitatorul nelogat vede prețul complet |
| ✅ | **Trei tipuri de grup de clienți** (`pricingType`): **`none`** (Client standard: prețul public) · **`discount`** (Client fidel 5%, Client VIP 7%: procent din prețul public) · **`cost_plus`** (Partener 1/2/3: adaos 12% / 17% / 21% peste prețul de achiziție NIR). Toate procentele sunt editabile din admin, per grup. Detalii în `09` |
| ✅ | Formula `cost_plus`: **`pret_brut = costNet × (1 + adaos) × (1 + TVA)`**, unde `costNet` e prețul NIR FĂRĂ TVA și TVA vine din setări (21%). Afișat cu TVA inclus, ca la toți ceilalți. Rotunjire pe linia de comandă, o singură dată |
| ✅ | **Plafon pentru Partener:** plătește **minimul** dintre prețul lui calculat și prețul public curent (inclusiv promoția). Nu poate plăti mai mult decât oricine altcineva |
| ✅ | **Produs fără preț de achiziție:** se aplică prețul public, cu avertisment în admin („produse fără preț NIR") |
| ✅ | **Prețul de achiziție = cel mai recent preț de intrare** din lista de recepții (poate scădea sau crește). `costPrice` (int, bani, fără TVA) și `costPriceDate` pe variantă, cu istoric. **DOAR în admin**: niciodată în API public, storefront, feed-uri, snapshot de comandă sau loguri |
| ✅ | **Import săptămânal al prețurilor NIR** dintr-un fișier exportat din SmartBill („lista de mișcări produse"): potrivire pe SKU, cea mai recentă dată per produs, actualizare doar dacă data e mai nouă, raport cu coduri necunoscute. Instrument în **Faza 15**. Un API SmartBill poate înlocui importul mai târziu |
| ✅ | **Nu adăugăm acum** prețuri pe categorie sau pe produs per grup (posibil mai târziu) |
| ✅ | Grupurile se atribuie **manual**; doar „Client standard" există la instalare, celelalte cinci sunt un **seed specific magazinului**, nu default de pachet |
| ✅ | `excludeFromGroupDiscount` (produs/categorie) se aplică **ambelor** tipuri de grup: produsul exclus costă prețul public pentru toți |
| ✅ | Afișare Partener: badge „Preț partener" + „Preț standard" tăiat; în coș linie informativă „Avantaj partener"; **pe factură doar prețul unitar încasat**, nimic special. Fidel/VIP: linie explicită de reducere, ca înainte |
| ✅ | Discountul de grup (`discount`) **NU se cumulează** cu promoția publică (se ia prețul cel mai mic), decât dacă `stacksWithSalePrice` e bifat pe grup. La `cost_plus` se ia oricum minimul |
| ✅ | Cuponul **SE cumulează** cu prețul de grup, cu excepția cupoanelor marcate `notForDiscountedGroups` (care blochează orice grup cu `pricingType ≠ none`) |
| ✅ | Atribuirea în grup se face **manual** de admin, individual sau în masă. Fără promovare automată |
| ✅ | **Prețul de achiziție (`products.cost.view`) îl văd rolurile Owner, Admin, Manager și Contabil.** Editor, Suport și Depozit nu. Editarea (`products.cost.edit`): doar Owner și Admin. Maparea e în `packages/core/src/rbac/catalog.ts` |
| ✅ | **Fără modul B2B clasic**: fără liste de prețuri per client, fără tranșe de cantitate, fără comutator cu/fără TVA, fără conturi de firmă multi-utilizator |
| ✅ | Facturarea pe firmă (CUI) la checkout rămâne disponibilă **oricui** |

## Fiscal, facturare și plăți (răspunsuri contabil)
| | Decizie |
|---|---|
| ✅ | **TVA: o singură cotă, 21%, pentru toate produsele, inclusiv digitale.** Cota rămâne în setări (`tax.standardRate`, implicit 21), nu hardcodată. Structura `TaxClass`/`TaxRate` rămâne generică; activă e o singură cotă |
| ✅ | **Vânzare DOAR în România, pentru orice produs** (nu doar cele digitale). Țările permise sunt o setare (implicit `["RO"]`). Taxarea inversă intracomunitară (VIES) și OSS nu se construiesc în Val 1 |
| ✅ | **Card cu plată reușită:** factura la plasarea comenzii / plata confirmată |
| ✅ | **Transfer bancar (OP):** proformă, apoi factură după confirmarea plății (confirmată de admin) |
| ✅ | **Ramburs:** factură la plasarea comenzii, cu storno dacă se întoarce. Plata se consideră încasată când curierul virează banii (reconciliere în admin) |
| ✅ | **Retur parțial:** storno parțial |
| ✅ | **Seria și numărul facturii** le definește SmartBill (nu avem numerotare proprie). **e-Factura o transmite SmartBill automat** |
| ✅ | **Ramburs: limită de valoare 10.000 lei pentru persoane fizice și 5.000 lei pentru persoane juridice**, ambele configurabile în setări. „Persoană juridică" = are CUI la facturare **sau** e într-un grup `cost_plus` (Partener). Peste limită, metoda de plată se ascunde |
| ✅ | **Puncte de loialitate: transportul se plătește mereu în bani.** Regula dură: **suma de plătit în bani nu poate fi mai mică decât costul transportului**; la comenzi fără transport (ridicare personală, doar digital) se aplică un **minim configurabil, implicit 1 leu**. Comanda de 0 lei nu poate apărea, iar ramura `loyalty_points` nu există |

## Catalog și stoc
| | Decizie |
|---|---|
| ✅ | **Variante de produs** (mărime, culoare) — DA |
| ✅ | Produse **fizice ȘI digitale** (tutoriale video) |
| ✅ | **Bifă `manageStock`, exact ca în WooCommerce**: setare globală (implicit ON) + suprascriere per produs și, la produsele cu variante, per variantă |
| ✅ | `manageStock = true` → cantități reale, rezervare la **inițierea plății** cu expirare **15 minute**, decrement la confirmare, alerte de stoc mic |
| ✅ | `manageStock = false` → doar dropdown `stockStatus` (în stoc / stoc epuizat / la comandă). Zero inventar, zero rezervări. Ramură explicită în cod |

## Integrări
| | Decizie |
|---|---|
| ✅ | Plăți: **Netopia + EuPlătesc**, ambele, plus ramburs și transfer bancar |
| ✅ | Curieri: **wootPRO** ca agregator principal + **Sameday direct** ca al doilea adaptor |
| ✅ | ⚠️ **Fără integrare Cargus separată** — Sameday a achiziționat Cargus în august 2026, sistemele se unifică |
| ✅ | Video tutoriale: **Bunny Stream** în producție, driver `local` pe localhost |
| ✅ | Produse digitale: **acces pe viață** · vânzare **doar în România** (ca toate produsele, fără OSS) · TVA 21% · **lecție de preview gratuită** pe pagina de produs |
| ✅ | Texte legale: **template-uri generate de instalator**, revizuite de avocat înainte de lansare |
| ✅ | Depozite: **model multi-depozit în bază, UI simplu cu un depozit implicit**, multi activabil prin flag |
| ✅ | La stoc 0: **„stoc epuizat" + „anunță-mă când revine"** |
| ✅ | Ramburs: **taxă configurabilă**, implicit fără · **limite de valoare 10.000 lei (PF) / 5.000 lei (PJ)**, configurabile (vezi „Fiscal, facturare și plăți") |
| ✅ | **Ridicare personală de la sediu** ca metodă de livrare |
| ✅ | Licențiere: **Val 2**. Vinzi instalarea și mentenanța, nu codul |
| ✅ | Credit „Powered by" în footer: **da, discret, dezactivabil din setări** |
| ✅ | Texte de admin într-un fișier de traduceri din prima (traducerea în engleză, când o ceri) |
| ✅ | Tehnic: **Prisma** · **Better Auth** · storage **disc local**, S3 comutabil · **Postgres FTS** · **SMTP din admin** · **Sentry opțional** |
| ✅ | **Loialitate**: 1 punct = 1 leu (1% cashback) · acordare automată la expirarea ferestrei de retur · expirare 12 luni cu avertizare · **fără plafon procentual la utilizare** (configurabil din admin, dacă vrei mai târziu), dar punctele **nu acoperă transportul** și se aplică regula dură „suma în bani ≥ costul transportului" (vezi „Fiscal, facturare și plăți") · **Standard, Fidel și VIP acumulează, Partenerii NU** · discountul Fidel/VIP se cumulează cu punctele |
| ✅ | **Vouchere cadou cu sold rămas**, tratate ca **metodă de plată**, nu ca reducere |
| ✅ | **Editor de temă Nivel 2**: culori, fonturi, logo, radius, variante de header și footer, layout de card, lățimi, dark mode, CSS custom, preview live (~6 zile) |
| ✅ | Ai produse **peste 50 kg și 150 cm** → patru clase de transport, inclusiv palet și „cere ofertă" |
| ✅ | **Cerere de ofertă instalare**, nu produs: bifă pe produs → bifă în checkout → contact telefonic manual, separat de comandă. Fără preț pe site |
| ✅ | **Transport**: prețul vine din API-ul curierului. Doar două clase, `standard` și `oversized`. Fără metodă de palet separată |
| ✅ | **Fișă explodată: varianta A** — imagine + tabel numerotat cu adăugare în coș. Structura de date permite adăugarea hotspot-urilor ulterior, fără rescriere |
| ✅ | Documente de produs (etichetă energetică, fișă tehnică, manual) — **încărcate manual**, prin tab „Documente" generic |
| ✅ | **Selectorul de produs NU intră în core** — prea specific pentru un pachet white-label. Se face ca extensie, când vrei |
| ✅ | **Comparare produse: Val 2** |
| ✅ | Programarea instalării: **apel telefonic**, fără calendar |
| ✅ | Vinzi **piese de schimb cu coduri de producător** → căutare exactă pe cod, cu index trigram |
| ✅ | Facturare: **SmartBill** furnizor principal (cu e-Factura). *Propusă de Claude, confirmată de utilizator.* Oblio rămâne posibil mai târziu, prin aceeași interfață `InvoiceProvider`. Înainte de Faza 13 se citește documentația API curentă și se verifică (de utilizator, cu SmartBill) că abonamentul include acces API |
| ✅ | **eMAG Marketplace**: DA, dar după lansarea magazinului propriu. Modelul de date se pregătește însă din Faza 4 |

## 🟡 Deschise (nedecise)
| | Subiect | Situația | De decis până la |
|---|---|---|---|
| 🟡 | **Voucher cadou: metodă de plată sau reducere?** | Contabilul a spus „reducere din comandă", dar proiectul îl tratează ca **metodă de plată** (nu reduce baza de TVA). Rămâne metodă de plată până lămurește contabilul diferența dintre **voucher cumpărat** (plată anticipată) și **cod de reducere gratuit**. *Consecință colaterală:* un voucher poate acoperi integral o comandă (regula „în bani ≥ transport" privește punctele, nu voucherele); de stabilit cum se tratează plata fără gateway | Faza 15b |
| 🟡 | **Termenul legal minim de valabilitate al voucherelor** | Contabilul se interesează | Faza 15b |
| 🟡 | **Puncte de loialitate: TVA pe 100 sau pe 90?** | Contabilul a spus „linie de discount, nu afectează baza de TVA", ambiguu. Întrebare trimisă: la 100 lei cu 10 lei plătiți în puncte, TVA se calculează pe 100 sau pe 90? | Faza 15b |
| 🟡 | **Produs digital în comandă mixtă cu ramburs** | Recomandarea: eliberare la **livrare confirmată**, nu la virament (`11` spune acum „la confirmarea încasării"). În așteptarea deciziei utilizatorului | Faza 14b |

---

# PARTEA II — De verificat înainte de lansare

Nu mai sunt decizii de luat. Astea sunt verificări externe — nu ține de cod, dar blochează lansarea.

| | De verificat | Cu cine | Când |
|---|---|---|---|
| 1 | **Limita de greutate/dimensiuni a wootPRO.** Întreabă exact: „Ce se întâmplă dacă cer un tarif pentru 90 kg, 160×80×80 cm? Primesc preț sau eroare?" Dacă e eroare, avem nevoie de ramura „cere ofertă" (+1 zi) | wootPRO | Înainte de Faza 12 |
| 2 | ~~Cotele de TVA curente~~ ✅ **Răspuns: 21% pentru toate produsele** (vezi Partea I) | Contabil | Faza 0 |
| 3 | **Obligațiile de etichetare energetică** — ce categorii din portofoliul tău intră și ce se cere exact | Consultant / ANPC | Înainte de lansare |
| 4 | **Textele legale generate** — revizuite și adaptate | Avocat | Înainte de lansare |
| 11 | **Jurnalul de audit vs. dreptul la ștergere (GDPR).** `audit_log.actorLabel` conține emailul unei persoane, iar jurnalul e doar de adăugare (trigger în DB, nu se poate șterge). Verifică temeiul legal, termenul de păstrare și ce se răspunde la o cerere de ștergere | Avocat | Înainte de lansare |
| 5 | **Cele 14 întrebări de mai jos**: 11 au răspuns, 2 rămân 🟡 (#8, #9), #10 e rezolvată prin decizie de produs | Contabil | Faza 0 și Faza 13 |
| 6 | **Suport pentru plăți recurente / tokenizare card** — cere-l explicit în contract, chiar dacă abonamentele vin în Val 2 | Netopia / EuPlătesc | La semnarea contractului |
| 7 | **VPS cu IP fix** — obligatoriu pentru whitelist-ul eMAG | Furnizor VPS | Înainte de Faza 21 |
| 9 | **Acces API SmartBill.** Verifică cu SmartBill că abonamentul tău include acces API (fără el, nu putem emite facturi din magazin); citim documentația curentă înainte de implementare | Utilizator, cu SmartBill | Înainte de Faza 13 |
| 10 | **Fișier exemplu de export SmartBill** („lista de mișcări produse"), pentru formatul importului de prețuri NIR (coloane, format dată, preț cu/fără TVA, mai multe intrări în aceeași zi) | Utilizator | Înainte de Faza 15 |
| 8 | **Documentația API eMAG curentă** — se schimbă, nu te baza pe memorie | eMAG | La Faza 22b |

# PARTEA III — Cele 14 întrebări pentru contabil

> ✅ = răspuns primit și mutat în Partea I · 🟡 = rămâne deschis (vezi Partea I, „Deschise")

Astea nu sunt decizii tehnice. Nu ți le poate răspunde niciun dezvoltator și niciun model de limbaj — depind de specificul firmei tale și de legislația în vigoare la momentul lansării.

**1. Când se emite factura fiscală?**
La încasare, la livrare, sau la plasarea comenzii? Diferă pe metodă de plată?
*De ce contează*: decide dacă jobul de facturare se declanșează la webhook-ul de plată, la generarea AWB-ului, sau la confirmarea livrării. Sunt trei implementări diferite.
*Ce e frecvent*: la confirmarea plății pentru card, la expediere pentru ramburs.
**✅ Răspuns contabil:** card cu plată reușită → factura la plasarea comenzii / plata confirmată · transfer bancar → proformă, apoi factură după confirmarea plății de către admin · ramburs → factură la plasarea comenzii, cu storno dacă se întoarce.

**2. Ce cotă de TVA se aplică produselor tale?**
Standard sau redusă? Ai produse cu cote diferite în același coș?
*De ce contează*: TVA-ul se stochează pe fiecare linie de comandă. Dacă ai cote mixte, calculul și factura sunt mai complexe.
*Atenție*: verifică valorile curente — cotele s-au schimbat în ultimii ani.
**✅ Răspuns contabil:** o singură cotă, **21%**, pentru toate produsele (inclusiv digitale). Fără cote mixte în același coș.

**3. Cum tratăm rambursul (plata la livrare)?**
Curierul încasează și îți virează banii peste câteva zile. Când se consideră factura încasată? Cine emite chitanța?
*De ce contează*: decide când marchezi comanda ca `paid` și când se eliberează produsele digitale dintr-o comandă mixtă.
**✅ Răspuns contabil:** factura se emite la plasarea comenzii; plata se consideră încasată **când curierul virează banii** (reconciliere în admin). *Eliberarea produselor digitale din comanda mixtă cu ramburs rămâne 🟡 (Partea I).*

**4. Proformă sau factură fiscală pentru transferul bancar?**
Clientul comandă și plătește prin OP. Îi emiți proformă și apoi factură la încasare, sau direct factură?
*De ce contează*: dacă e proformă, trebuie două documente și două stări de comandă.
**✅ Răspuns contabil:** proformă, apoi factură după confirmarea plății (confirmată de admin).

**5. Care e procedura corectă de storno la retur?**
Factură de storno completă, parțială, sau notă de credit? Ce se întâmplă cu transportul returnat?
*De ce contează*: rambursarea parțială e frecventă (clientul returnează 1 din 3 produse). Trebuie să știu ce document se generează.
**✅ Răspuns contabil:** retur parțial → **storno parțial**. *(Tratamentul transportului returnat nu a fost precizat.)*

**6. Serie și numerotare facturi**
Le gestionează SmartBill, sau ai serii proprii care trebuie respectate? Ai nevoie de serii separate pentru online și offline? Pentru eMAG?
*De ce contează*: numerotarea trebuie să fie fără goluri și thread-safe. Dacă SmartBill o gestionează, e mult mai simplu.
**✅ Răspuns contabil:** seria și numărul le definește **SmartBill**. *(Serii separate online/offline/eMAG: neprecizat.)*

**7. e-Factura: cine răspunde de transmitere și în ce termen?**
SmartBill transmite automat? Ce faci dacă transmiterea eșuează? Care e termenul legal curent?
*De ce contează*: decide dacă am nevoie de un mecanism de retry cu alertă și de un ecran de monitorizare în admin.
**✅ Răspuns contabil:** **SmartBill transmite e-Factura automat.** *(Termenul și procedura la eșec nu au fost precizate; păstrăm statusul `efacturaStatus` vizibil în admin, cu retry și alertă.)*

**8. Voucherele cadou: cum se inregistreaza contabil?**
Un voucher nu e o reducere, e o **plata anticipata** — o datorie in bilant pana la utilizare. Pe factura finala apare ca metoda de plata, nu ca discount, si **nu reduce baza de TVA**.
*De ce conteaza*: decide daca voucherul intra in lantul de reduceri (gresit) sau la plata (corect). Vezi `14` Partea B §4.
*Intreaba si*: ce termen minim de valabilitate e legal si cum se trateaza soldul neutilizat la expirare.
**🟡 Răspuns contabil (ambiguu):** „reducere din comandă". Proiectul îl tratează ca metodă de plată; diferența dintre **voucher cumpărat** (plată anticipată) și **cod de reducere gratuit** urmează să fie lămurită. Termenul minim de valabilitate: contabilul se interesează.

**9. Punctele de loialitate: cum se trec pe factura?**
Reducerea din puncte e o reducere comerciala. Se trece pe linie sau ca discount global? Afecteaza baza de TVA?
*De ce conteaza*: decide unde intra in calcul si cum arata factura.
**🟡 Răspuns contabil (ambiguu):** „linie de discount, nu afectează baza de TVA". **Întrebare trimisă:** la 100 lei cu 10 lei plătiți în puncte, TVA se calculează pe 100 sau pe 90?

**10. Comandă de 0 lei, acoperită integral din puncte de loialitate**
Clientul poate acoperi întreaga valoare a produselor cu puncte. Rămâne de plată doar transportul — sau nimic, dacă e ridicare personală. Cum se facturează o comandă cu valoare zero? E acceptabil, sau trebuie să impun un minim de plată în bani?
*De ce contează*: dacă e problematic, pun o limită de utilizare a punctelor înainte de a implementa, nu după.
**✅ Rezolvat prin decizie de produs (nu prin răspunsul contabilului):** comanda de 0 lei **nu poate apărea**. Suma de plătit în bani ≥ costul transportului; la comenzi fără transport, minim configurabil (implicit 1 leu). Vezi Partea I.

**11. Produsele digitale: cum se facturează și ce TVA au?**
Sunt „servicii prestate electronic". Se facturează diferit de bunuri? Ce se întâmplă dacă vinzi unui client din alt stat UE?
*De ce contează*: decide dacă blochez vânzarea digitală în afara României (recomandarea mea în Val 1) sau dacă construiesc suport OSS.
**✅ Răspuns contabil:** 21%, la fel ca toate produsele. Vânzare **doar în România**, pentru orice produs. Fără OSS.

**12. Prețul de achiziție (NIR) pentru prețul de partener: ce valoare folosim?**
Dacă același produs intră în stoc la prețuri diferite în timp, la care ne raportăm?
*De ce contează*: decide ce înseamnă `costPrice` și cum se actualizează.
**✅ Răspuns contabil:** prețul NIR = **ultimul preț de intrare**, exportat din SmartBill.

**13. Prețul de partener, calculat cost + adaos și afișat cu TVA: e ok pe factură?**
*De ce contează*: dacă ar fi nevoie de un tratament special (ex. linie de discount), modelul de factură se schimbă.
**✅ Răspuns contabil:** e în regulă; nimic special pe factură.

**14. Limite de plată în numerar**
Ce plafon se aplică plăților în numerar (ramburs la curier) către persoane fizice și juridice?
*De ce contează*: decide limitele implicite ale metodei ramburs.
**✅ Răspuns contabil:** **5.000 lei** pentru persoane juridice (B2B) și **10.000 lei** pentru persoane fizice (B2C). Valorile sunt configurabile în setări; confirmă periodic că sunt cele în vigoare.

---

## Cum folosești acest fișier
1. Completează 🔴 înainte de Faza 1.
2. Completează 🟡 înainte de faza indicată.
3. Ține fișierul în `docs/` și spune-i lui Claude Code să-l citească la fiecare sesiune.
4. Când răspunzi, mută decizia în Partea I și șterge recomandarea — ca să nu existe ambiguitate peste 3 luni.
