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
| ✅ | Grupuri de clienți cu **discount procentual** (Partener, Client fidel) |
| ✅ | Discountul de grup **NU se cumulează** cu promoția publică (se ia prețul cel mai mic), decât dacă `stacksWithSalePrice` e bifat pe grup |
| ✅ | Cuponul **SE cumulează** cu discountul de grup, cu excepția cupoanelor marcate `notForDiscountedGroups` |
| ✅ | Atribuirea în grup se face **manual** de admin, individual sau în masă. Fără promovare automată |
| ✅ | **Fără modul B2B clasic**: fără liste de prețuri per client, fără tranșe de cantitate, fără comutator cu/fără TVA, fără conturi de firmă multi-utilizator |
| ✅ | Facturarea pe firmă (CUI) la checkout rămâne disponibilă **oricui** |

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
| ✅ | Produse digitale: **acces pe viață** · vânzare **doar în România** (fără OSS) · **lecție de preview gratuită** pe pagina de produs |
| ✅ | Texte legale: **template-uri generate de instalator**, revizuite de avocat înainte de lansare |
| ✅ | Depozite: **model multi-depozit în bază, UI simplu cu un depozit implicit**, multi activabil prin flag |
| ✅ | La stoc 0: **„stoc epuizat" + „anunță-mă când revine"** |
| ✅ | Ramburs: **limită de valoare și taxă configurabile**, implicit fără |
| ✅ | **Ridicare personală de la sediu** ca metodă de livrare |
| ✅ | Licențiere: **Val 2**. Vinzi instalarea și mentenanța, nu codul |
| ✅ | Credit „Powered by" în footer: **da, discret, dezactivabil din setări** |
| ✅ | Texte de admin într-un fișier de traduceri din prima (traducerea în engleză, când o ceri) |
| ✅ | Tehnic: **Prisma** · **Better Auth** · storage **disc local**, S3 comutabil · **Postgres FTS** · **SMTP din admin** · **Sentry opțional** |
| ✅ | **Loialitate**: 1 punct = 1 leu (1% cashback) · acordare automată la expirarea ferestrei de retur · expirare 12 luni cu avertizare · **fără limită de utilizare pe produse**, dar punctele **nu acoperă transportul** · **grupul Partener nu acumulează** |
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
| ✅ | Facturare: **Oblio** (cu e-Factura). SmartBill ulterior, prin aceeași interfață |
| ✅ | **eMAG Marketplace**: DA, dar după lansarea magazinului propriu. Modelul de date se pregătește însă din Faza 4 |

---

# PARTEA II — De verificat înainte de lansare

Nu mai sunt decizii de luat. Astea sunt verificări externe — nu ține de cod, dar blochează lansarea.

| | De verificat | Cu cine | Când |
|---|---|---|---|
| 1 | **Limita de greutate/dimensiuni a wootPRO.** Întreabă exact: „Ce se întâmplă dacă cer un tarif pentru 90 kg, 160×80×80 cm? Primesc preț sau eroare?" Dacă e eroare, avem nevoie de ramura „cere ofertă" (+1 zi) | wootPRO | Înainte de Faza 12 |
| 2 | **Cotele de TVA curente** (standard și redusă) și ce se aplică produselor tale | Contabil | Faza 0 |
| 3 | **Obligațiile de etichetare energetică** — ce categorii din portofoliul tău intră și ce se cere exact | Consultant / ANPC | Înainte de lansare |
| 4 | **Textele legale generate** — revizuite și adaptate | Avocat | Înainte de lansare |
| 5 | **Cele 11 întrebări de mai jos** | Contabil | Faza 0 și Faza 13 |
| 6 | **Suport pentru plăți recurente / tokenizare card** — cere-l explicit în contract, chiar dacă abonamentele vin în Val 2 | Netopia / EuPlătesc | La semnarea contractului |
| 7 | **VPS cu IP fix** — obligatoriu pentru whitelist-ul eMAG | Furnizor VPS | Înainte de Faza 21 |
| 8 | **Documentația API eMAG curentă** — se schimbă, nu te baza pe memorie | eMAG | La Faza 22b |

# PARTEA III — Cele 11 întrebări pentru contabil

Astea nu sunt decizii tehnice. Nu ți le poate răspunde niciun dezvoltator și niciun model de limbaj — depind de specificul firmei tale și de legislația în vigoare la momentul lansării.

**1. Când se emite factura fiscală?**
La încasare, la livrare, sau la plasarea comenzii? Diferă pe metodă de plată?
*De ce contează*: decide dacă jobul de facturare se declanșează la webhook-ul de plată, la generarea AWB-ului, sau la confirmarea livrării. Sunt trei implementări diferite.
*Ce e frecvent*: la confirmarea plății pentru card, la expediere pentru ramburs.

**2. Ce cotă de TVA se aplică produselor tale?**
Standard sau redusă? Ai produse cu cote diferite în același coș?
*De ce contează*: TVA-ul se stochează pe fiecare linie de comandă. Dacă ai cote mixte, calculul și factura sunt mai complexe.
*Atenție*: verifică valorile curente — cotele s-au schimbat în ultimii ani.

**3. Cum tratăm rambursul (plata la livrare)?**
Curierul încasează și îți virează banii peste câteva zile. Când se consideră factura încasată? Cine emite chitanța?
*De ce contează*: decide când marchezi comanda ca `paid` și când se eliberează produsele digitale dintr-o comandă mixtă.

**4. Proformă sau factură fiscală pentru transferul bancar?**
Clientul comandă și plătește prin OP. Îi emiți proformă și apoi factură la încasare, sau direct factură?
*De ce contează*: dacă e proformă, trebuie două documente și două stări de comandă.

**5. Care e procedura corectă de storno la retur?**
Factură de storno completă, parțială, sau notă de credit? Ce se întâmplă cu transportul returnat?
*De ce contează*: rambursarea parțială e frecventă (clientul returnează 1 din 3 produse). Trebuie să știu ce document se generează.

**6. Serie și numerotare facturi**
Le gestionează Oblio, sau ai serii proprii care trebuie respectate? Ai nevoie de serii separate pentru online și offline? Pentru eMAG?
*De ce contează*: numerotarea trebuie să fie fără goluri și thread-safe. Dacă Oblio o gestionează, e mult mai simplu.

**7. e-Factura: cine răspunde de transmitere și în ce termen?**
Oblio transmite automat? Ce faci dacă transmiterea eșuează? Care e termenul legal curent?
*De ce contează*: decide dacă am nevoie de un mecanism de retry cu alertă și de un ecran de monitorizare în admin.

**8. Voucherele cadou: cum se inregistreaza contabil?**
Un voucher nu e o reducere, e o **plata anticipata** — o datorie in bilant pana la utilizare. Pe factura finala apare ca metoda de plata, nu ca discount, si **nu reduce baza de TVA**.
*De ce conteaza*: decide daca voucherul intra in lantul de reduceri (gresit) sau la plata (corect). Vezi `14` Partea B §4.
*Intreaba si*: ce termen minim de valabilitate e legal si cum se trateaza soldul neutilizat la expirare.

**9. Punctele de loialitate: cum se trec pe factura?**
Reducerea din puncte e o reducere comerciala. Se trece pe linie sau ca discount global? Afecteaza baza de TVA?
*De ce conteaza*: decide unde intra in calcul si cum arata factura.

**10. Comandă de 0 lei, acoperită integral din puncte de loialitate**
Clientul poate acoperi întreaga valoare a produselor cu puncte. Rămâne de plată doar transportul — sau nimic, dacă e ridicare personală. Cum se facturează o comandă cu valoare zero? E acceptabil, sau trebuie să impun un minim de plată în bani?
*De ce contează*: dacă e problematic, pun o limită de utilizare a punctelor înainte de a implementa, nu după.

**11. Produsele digitale: cum se facturează și ce TVA au?**
Sunt „servicii prestate electronic". Se facturează diferit de bunuri? Ce se întâmplă dacă vinzi unui client din alt stat UE?
*De ce contează*: decide dacă blochez vânzarea digitală în afara României (recomandarea mea în Val 1) sau dacă construiesc suport OSS.

---

## Cum folosești acest fișier
1. Completează 🔴 înainte de Faza 1.
2. Completează 🟡 înainte de faza indicată.
3. Ține fișierul în `docs/` și spune-i lui Claude Code să-l citească la fiecare sesiune.
4. Când răspunzi, mută decizia în Partea I și șterge recomandarea — ca să nu existe ambiguitate peste 3 luni.
