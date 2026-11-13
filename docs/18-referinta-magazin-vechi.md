# 18 — Referință: magazinul vechi (piscine-concept.ro / totalwater.ro)

> **Statut:** document de referință, nu specificație. Nu copiem cod din magazinul vechi. Preluăm regulile de business care s-au dovedit utile și evităm capcanele documentate de autorii lui.
> **Sursa:** arhiva `magazin next js.zip` (primită 2026-11-13), citită direct din zip. Fișierele utile sunt extrase în `local-data/arhiva-piscine-concept/` (în `.gitignore`; nu se comit, nu se tipăresc, nu se folosesc ca fixture-uri). `DEPLOY.md`, `.env`, logurile și `.claude/` din arhivă NU au fost extrase (conțin credențiale și date de server).
> **Document-pereche:** [19-seo-si-migrare-merchant.md](19-seo-si-migrare-merchant.md).
> **De reconciliat de Claude Code, la începutul fazei care folosește o regulă de mai jos:** cu `14-loializare-si-vouchere.md`, `15-specific-nisa-piscine.md`, `05-integrari-romania.md`, `09-preturi-si-parteneri.md`, `11-produse-digitale.md`. Dacă o regulă de aici contrazice un document existent, documentul existent câștigă până decide utilizatorul.

## 1. Ce este magazinul vechi

- Magazin full-stack, în producție pe un VPS propriu: backend Node.js + Express 5 + Prisma 7 peste MariaDB, frontend React 19 + Vite (SPA, fără randare pe server), panou de administrare propriu, JWT, două roluri (ADMIN, CUSTOMER).
- Plăți: Stripe, Netopia, PayU, EuPlătesc și TBI Bank (rate). Curieri: Cargus, DPD, FAN Courier, Sameday (inclusiv Easybox). Facturare/ERP: SmartBill, Oblio, FGO. Plus: loialitate, cupoane, pachete (bundle), recenzii, retururi, blog, constructor de pagini (Puck), feed-uri de produse (import/export), redirecturi, plugin-uri activabile, modul de revânzători cu oferte PDF.
- Funcțiile opționale sunt construite complet, dar **dezactivate implicit** și pornite din admin (registru de plugin-uri). Lecția: „construit" nu înseamnă „activ"; verifici starea înainte de a raporta o funcție ca live.
- Un set de planuri și audituri scrise de autorii lui (SEO, migrare Merchant, revânzători) este rezumat în acest document și în 19.

## 2. Reguli de business reutilizabile

Fiecare regulă are „Preluăm / Altfel la noi". Valorile numerice sunt cele din codul vechi și sunt **implicite propuse**, nu decizii. Decizia rămâne la utilizator, la faza respectivă.

### 2.1 Transport

Reguli în codul vechi:
- Greutatea unei unități: greutatea produsului → altfel greutatea implicită a celei mai grele categorii (proprie sau a părintelui) → altfel o greutate implicită globală din setări.
- Reguli de tarifare configurabile, de trei tipuri: după valoarea coșului (pragul cel mai mare atins câștigă; se folosește pentru transport gratuit sau redus), după greutate (de la o greutate în sus) și după categorie (supratarif). **Dacă se aplică și greutatea, și categoria, câștigă tariful mai mare.**
- Marfă paletizată (produse marcate): preț fix de paletizare, pragurile de transport gratuit nu se aplică, iar plata e permisă doar online sau prin transfer bancar (fără ramburs).
- Un colet nu depășește 31 kg la curier: peste, se propune împărțirea în mai multe colete, altfel curierul tarifează ca marfă grea.
- AWB-ul declară greutatea reală a comenzii (minimum 1 kg).
- Fiecare curier are același set de operații: test conexiune, creare AWB, PDF AWB, ștergere AWB; Sameday adaugă puncte de ridicare (pickup points), servicii și stare AWB; urmărire automată care poate trece comanda în COMPLETED la livrare.

Preluăm: ierarhia greutății, cele trei tipuri de reguli cu „câștigă tariful mai mare", regula de paletizare și plata permisă doar online sau prin transfer, plafonul de colet și împărțirea.
Altfel la noi: curierii sunt integrări în `packages/integrations`, nu cod în controllere; faza lor e în `05-integrari-romania.md`.

### 2.2 Plăți online

- Tranzițiile de plată sunt **comune** tuturor procesatoarelor și **atomice**: `updateMany` cu condiție pe starea curentă. Un webhook primit de două ori, sau un webhook plus verificarea la întoarcerea clientului, produc efectele (email, stoc, cupon, puncte) o singură dată.
- O comandă neplătită ține stocul blocat un timp limitat: 120 de minute pentru card, 7 zile pentru TBI (aprobarea creditului durează zile). La expirare comanda se anulează, iar stocul, cuponul și punctele revin.
- Jobul de expirare atinge doar comenzile expirate recent (fereastră de 2 zile). Comenzile mai vechi, sau rezolvate manual de admin, rămân neatinse.
- Plată sosită **după** anularea comenzii: stocul a fost deja returnat, deci comanda nu se reactivează automat. Se marchează plătită și primește o notă pentru admin, care decide (reactivare sau rambursare).
- Notele de admin au marcaj de timp și se adaugă, nu se suprascriu.
- Statusuri de comandă în sistemul vechi: PENDING, PROCESSING, SHIPPED, COMPLETED, **SUPPLIER** (comandă livrată de furnizor), CANCELLED, RETURNED. Metode de plată: CARD, COD, NETOPIA, PAYU, EUPLATESC, TBI, BANK_TRANSFER. Livrare: COURIER sau EASYBOX.

Preluăm: tranzițiile atomice idempotente pe stare, TTL-urile pe metodă, regula plății întârziate cu decizie manuală, nota de audit, statusul „la furnizor".
Altfel la noi: avem deja audit-log, tranzacții și teste de concurență; aceste reguli se verifică pe modelul nostru de plată, nu se copiază.

### 2.3 Loialitate (puncte)

- Rată implicită 2% din baza comenzii, setabilă. Baza = subtotal − reduceri − partea plătită deja cu puncte. **Transportul și taxele sunt excluse.**
- Punctele se acordă o singură dată, când comanda devine COMPLETED (manual sau automat la livrare).
- 1 punct = 1 leu la răscumpărare. Răscumpărarea se face **în tranzacția de checkout**, limitată la minimul dintre punctele cerute, soldul și suma răscumpărabilă a coșului.
- Expirare după 12 luni. La consum se folosește FIFO: se consumă întâi lotul cel mai apropiat de expirare.
- Anularea unei comenzi returnează punctele folosite (într-un lot nou, cu expirare nouă de 12 luni) și retrage ce a mai rămas din punctele câștigate.
- Istoric complet de tranzacții de tip EARNED, REDEEMED, EXPIRED, ADJUSTED, REVERSED, cu soldul după fiecare mișcare.

Preluăm: baza de calcul fără transport, acordarea la COMPLETED o singură dată, FIFO pe lot cu expirare, tranzacția de checkout, tipurile de mișcări.
Altfel la noi: designul complet al loializării și al voucherelor e în `14-loializare-si-vouchere.md`, care are prioritate.

### 2.4 Revânzători, oferte și recepții (B2B)

- Modul **complet izolat** de magazin. Modulul nu scrie în produsele și comenzile magazinului, cu o singură excepție intenționată: conversia unei oferte acceptate în comandă.
- Recepții de marfă (NIR) importate din PDF-ul „Raport recepții de la furnizori" din SmartBill. Capcane de parsare documentate de ei: NIR pe mai multe pagini cu antet repetat, denumiri rupte pe două rânduri, cantități zecimale (mp, ml, kg), coduri de produs eterogene, reimport idempotent pe numărul documentului.
- **Revizuire de arhitectură (2026-08-06) în codul lor:** legarea manuală a liniilor de recepție la catalogul magazinului a fost **înlocuită**. Fiecare linie devine automat un „produs de revânzare" propriu (furnizor + cod), fără legătură cu catalogul. Lecția: legarea manuală e fragilă.
- Grupuri de preț: adaos procentual peste cost, cu excepții per produs. Oferta ia prețul din cost + adaos, editabil pe linie, generează PDF și se poate converti în comandă. Oferta aplică TVA 21% peste subtotalul fără TVA.
- Lipsuri recunoscute de ei: nicio serie/numerotare formatată de ofertă (se folosea id-ul brut) și nicio setare „date firmă" (CUI, IBAN, sediu, logo) pentru antetul PDF-urilor.
- MVP-ul lor nu dă revânzătorilor cont propriu; revânzătorul e o entitate internă fără autentificare.

Preluăm: izolarea, parserul de NIR ca idee și capcanele lui, grupurile de preț cu excepții, numerotarea formatată și datele firmei ca cerințe de la început.
Altfel la noi: fază separată (`09-preturi-si-parteneri.md`), cu cont de partener, dacă decide utilizatorul.

### 2.5 Facturare și contabilitate

- Facturare automată la COMPLETED, dacă setarea este pornită (Oblio în codul lor), o singură dată: nu se emite dacă există deja un număr de factură.
- SmartBill: emitere factură, estimate/proformă, PDF, serii, mapare produse, protecție la limita de cereri (rate limit); FGO are același set de operații.
- Efectele secundare la COMPLETED (puncte, factură) sunt într-un singur serviciu de „efecte la finalizare", apelat și din admin, și din livrarea automată.

Preluăm: un singur punct de efecte la finalizare, idempotență pe numărul de factură.
Altfel la noi: SmartBill e integrarea principală (`05-integrari-romania.md`); regulile de rotunjire și TVA așteaptă răspunsurile din `INTREBARI-CONTABIL.md`.

### 2.6 Coș abandonat

Email către utilizatorul autentificat cu coș nemodificat de N ore (implicit 2), cel mult unul la 7 zile per utilizator, doar dacă nu a comandat între timp, pornit doar dacă setarea e activă.

Preluăm: pragul, intervalul minim, excluderea celor care au comandat. Cerință GDPR/consimțământ: de decis cu `INTREBARI-AVOCAT.md`.

### 2.7 Cupoane

Tip procent sau sumă fixă, comandă minimă, limită de utilizări, expirare, activ/inactiv. Cuponul revine la expirarea comenzii neplătite (vezi 2.2).

## 3. Capcane documentate de autorii magazinului vechi

1. **SPA fără randare pe server:** HTML-ul brut al paginilor era un schelet gol. Crawlerele AI și parțial Google nu vedeau produsele. De aici nevoia unui magazin cu randare pe server (aceasta este deja baza Next.js a proiectului nostru).
2. **Preț greșit în feed:** un produs apărea cu un preț de ordinul milioanelor de lei (eroare de unitate), cu risc de suspendare a contului Merchant. Detalii în secțiunea 4.
3. **Descrieri preluate de la furnizori** (prin scrape) → risc de conținut duplicat față de alți revânzători.
4. **Slug-uri cu diacritice tăiate** în loc de transliterate (`cldur`, `n-funcie`).
5. **Mai multe adrese pentru același produs** și produs mutat între categorii fără redirect.
6. **Redeploy fragil:** serverul citea `index.html` o singură dată, iar un build fără restart lăsa site-ul alb. Nu se aplică la noi, dar arată de ce deploy-ul trebuie să fie un singur pas verificat.
7. **Schema modificată cu `db push`, nu cu migrări** (drift de FK în baza locală). La noi: doar migrări Prisma, versionate.
8. Statusul unei funcții trebuie verificat în baza de date, nu presupus din cod (vezi 1).

## 4. Datele produselor (pentru 15d și produsele demo)

**Locație:** `local-data/arhiva-piscine-concept/backend/exports/` și `.../backend/uploads/products/`. Nu se comit, nu se tipăresc în loguri, nu se folosesc ca fixture-uri de test.

**Export de produse** (`feeed-nou-produse.csv`, UTF-8): **1.327 produse**, coloane: `name, price, stock, sku, imageUrl, productUrl, availability, id, shortDescription, description, brand, category, ean, salePrice, isActive`.

Constatări de curățat înainte de orice import:

| # | Constatare | Efect / regulă |
|---|---|---|
| 1 | **15 produse au prețul > 100.000 RON** (de ex. două produse „Spa" cu zeci de milioane, o pompă de căldură cu ~4,5 milioane). Pare o eroare de scară (unitate sau factor), nu un preț real. | **Nu se importă nicio valoare din coloana `price` fără confirmarea utilizatorului**; prețurile reale se iau din sursa lui de adevăr. |
| 2 | 83 de produse „out of stock", 1.244 „in stock" | Stocul real vine din SmartBill (Faza 5), nu din export. |
| 3 | 198 de produse au `salePrice` | Reducerile se modelează ca promoții, nu ca preț suprascris. |
| 4 | **5 SKU-uri duplicate** | SKU unic la noi: se rezolvă manual înainte de import. |
| 5 | 42 de produse fără brand, 29 fără categorie | De completat sau marcat. |
| 6 | **776 de descrieri au `&amp;nbsp;`** (entități HTML duble) și nicio descriere nu conține etichete HTML (text cu tab-uri) | Trec prin `sanitizeRichHtml()` și normalizare de entități; nu se scriu direct în `Product.description`. |
| 7 | `shortDescription` și `ean` sunt goale la toate | De la zero. |
| 8 | 80 de categorii, 76 de branduri (AstralPool 339, Total Water 167, Harvia 79 etc.) | Arborele de categorii se confirmă cu utilizatorul înainte de import. |
| 9 | `imageUrl` indică `totalwater.ro/api/uploads/products/{id}/…` | Imaginile externe se descarcă în media prin `safeFetchImage` (15d), nu rămân hotlink. Copia locală din arhivă acoperă o parte din ele. |

**Fișierul Google Merchant** (`google-feed.xml`, 1.327 `<item>`): conține aceleași produse în format Merchant (id = SKU). Servește la validarea migrării (vezi 19).

**Imagini:** arhiva conține imaginile a ~1.400 de produse, în mai multe dimensiuni WebP per produs. **Nu le extragem pe toate**: pentru lucru, avem doar cele ale celor 29 de produse demo (mai jos). Restul rămân în arhivă și se descarcă din site-ul live prin `safeFetchImage` (15d), nu din arhivă. Pipeline-ul nostru generează propriile variante, nu le folosim pe cele vechi.

**Set de lucru de 29 de produse** (`local-data/arhiva-piscine-concept/demo/`):
- `demo-candidati.csv`: lista (id, SKU, nume, categorie, brand, preț din export, preț redus, stoc, disponibilitate, motiv, număr de fișiere imagine).
- `demo-produse-complet.csv`: aceleași produse, cu toate coloanele din export (inclusiv descrierile).
- `backend/uploads/products/{id}/`: imaginile celor 29 de produse.

Alcătuire: 24 de produse „curate" din categorii diferite (filtre, pompe, mozaic, liner, electroliză, sobe, adezivi, tubulatură etc.), 3 cu preț redus, 2 fără stoc. Toate au SKU unic, brand, categorie, descriere și imagine locală.

**Atenție:** prețurile din export sunt **neverificate**. Am exclus doar valorile evident absurde (peste 20.000 RON sau sub 20 RON); o eroare de scară mai mică nu se vede de la distanță. Prețurile demo se confirmă cu utilizatorul înainte de import și nu se scriu în nicio bază din exportul brut.

## 5. Ce NU preluăm

- Codul de interfață (React/Vite, componente „shadcn-like") și stilurile: designul nostru este în `17-design-sistem-admin.md` și, pentru magazin, în Faza 6.
- Gateway-urile de plată vechi ca implementare. Vom reface integrările pe modelul nostru, cu teste.
- `DEPLOY.md`, `.env`, loguri, `.claude/`: conțin date de server și credențiale. **Recomandare pentru utilizator:** schimbă parolele bazei de date menționate în `DEPLOY.md` și verifică dacă acel fișier a fost vreodată într-un repo GitHub.
