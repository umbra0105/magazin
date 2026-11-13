# 19 — SEO și migrarea feed-ului Google Merchant (bază pentru Faza 6 și lansare)

> **Statut:** bază de cerințe, nu plan de execuție. Preia constatările auditurilor scrise pentru magazinul vechi (`SEO_AUDIT_SI_PLAN.md` din 2026-08-25, `PLAN-SEO.md` din 2026-10-21, `MIGRARE_TOTALWATER.md`) și le transformă în cerințe pentru magazinul nostru. Sursele sunt în `local-data/arhiva-piscine-concept/` (nu se comit). Hărțile de implementare ale magazinului vechi (Express + React SPA) **nu se aplică**; aici se păstrează doar *ce trebuie să fie adevărat* în produsul final.
> **Document-pereche:** [18-referinta-magazin-vechi.md](18-referinta-magazin-vechi.md).
> **Nu conține estimări de timp.** Estimările din documentele vechi sunt ignorate.

## 1. Cerințe SEO pentru magazinul nostru (Faza 6)

Magazinul nostru e Next.js cu randare pe server, deci cea mai gravă problemă a celui vechi (HTML brut gol) dispare **dacă păstrăm disciplina de mai jos**. Fiecare rând are ID-ul constatării din auditul vechi, ca să se poată verifica.

| Cerință | De ce (constatarea veche) | Cum verificăm |
|---|---|---|
| **HTML complet în răspunsul inițial**: meniu cu linkuri `<a href>`, un singur H1 vizibil, nume, preț, disponibilitate, descriere și specificații pe produs; subcategorii, descrierea categoriei și linkuri de paginare pe categorie | F01–F04: crawlerele AI nu execută JavaScript; Google randează JS într-un al doilea val, mai lent | `curl` cu user-agent de crawler pe home, categorie, produs, blog: textul și linkurile apar fără JS |
| **404 real** (status HTTP 404) pentru orice adresă necunoscută, nu 200 cu pagina de start; `noindex` pe stările de eroare | F05: soft-404 indexabil | test automat: o adresă inexistentă întoarce 404 |
| **O singură adresă canonică per produs**, cu redirect 301 de la celelalte forme; o singură formă pentru catalog (nu `/produse` și `/products`) | F08, F11 | test: toate variantele ajung la canonical prin 301 |
| **Redirect 301 automat la mutarea unui produs/categorii** (istoric de adrese) | F12 | test la schimbarea categoriei/slug-ului |
| **Filtre și căutare internă**: `noindex` (sau canonical către pagina fără parametri); căutarea internă nu se indexează | F13 | test pe `?brand=…&sort=…` |
| **Paginare**: canonical auto-referențial pe fiecare pagină, linkuri reale către pagina următoare/anterioară | F14 | test |
| **Sitemap**: `lastmod` real pe toate tipurile, imagini principale (`image:image`), fără `priority`/`changefreq` (ignorate de Google), împărțit dacă depășește limitele | F09, F10; auditul vechi, faza „sitemap cu imagini" | validare + verificare în Search Console |
| **robots.txt**: `Disallow` pe cont, coș, finalizare comandă, autentificare, resetare parolă, confirmare comandă, admin; plus `noindex` pe acele pagini | auditul vechi, faza „robots" | test |
| **JSON-LD complet pe server** (nu doar în client): `Product` + `Offer` (preț, disponibilitate, `priceValidUntil`), `BreadcrumbList`, `AggregateRating`/`Review` când există, `shippingDetails` și `hasMerchantReturnPolicy`; `ItemList` pe categorie; `Organization` cu adresă; `WebSite` cu `SearchAction` care țintește adresa reală de căutare; `FAQPage` unde există FAQ; `LocalBusiness` pe contact; `BlogPosting` pe articol | F20, F22, F23 | Rich Results Test |
| **Nu amestecăm microdata cu JSON-LD** pentru aceeași entitate | F21: entități `Product` duplicate | verificare manuală |
| **Dimensiuni și text alternativ pentru imaginea Open Graph** în HTML-ul servit | F15, F16 | `curl` |
| **Slug-uri**: transliterare corectă (ă→a, â→a, î→i, ș→s, ț→t), niciodată caractere tăiate; dacă un slug se schimbă, 301 | F26; scriptul vechi `fix-diacritic-slugs.js` | test unitar de transliterare |
| **Imaginea LCP a produsului** cu prioritate de încărcare (preload) și dimensiuni explicite | F19 | Lighthouse |
| **Texte unice**: descrierile produselor nu se copiază de pe site-urile furnizorilor; categoriile au text propriu vizibil în HTML-ul brut (nu doar în `<meta>`) | F17, F25 | verificare manuală pe eșantion |
| **Nume de brand consistent** (titlu, `og:site_name`, JSON-LD) | F35 | verificare |
| **`/llms.txt`** generat din date reale | auditul vechi, faza „semnale pentru AI" | test |
| **Pagini obligatorii pentru un magazin online din România**: termeni, confidențialitate, retur și drept de retragere, ANPC/SAL, cookie-uri; toate în sitemap | F27, F28 | listă de control |
| **Nu promitem ce nu există**: meta descrierea nu menționează servicii (construcție, renovare) fără pagini care să le acopere | F24 | verificare |
| **Fonturi**: se servesc din domeniul magazinului (deja decis pentru admin) | F31 | build |
| **Consent pentru scripturile terțe** (analitice, reclame) cu stare implicită „refuzat" | F32 | verificare |

Monitorizare după lansare: înscrierea domeniului în Google Search Console și Bing Webmaster Tools, trimiterea sitemap-ului, urmărirea acoperirii de indexare; Core Web Vitals din date de teren (nu doar Lighthouse local); verificare periodică cu `curl` că randarea pe server întoarce conținut complet.

## 2. Migrarea feed-ului Google Merchant fără pierderea istoricului

Scopul: Merchant Center să **nu** vadă „produse noi", iar campaniile să nu-și piardă istoricul. Reguli (din `MIGRARE_TOTALWATER.md`):

1. **Același identificator**: `SKU` produs = `g:id` din feed-ul vechi (de exemplu `Xhp60`). Nu se generează id-uri noi.
2. **Aceeași adresă de feed**: feed-ul nou răspunde la aceeași adresă ca cel vechi (în vechiul sistem `/feed/gm-adwords.xml`, feed-ul se numea `gm-adwords`). Include produsele active **și** cele fără stoc (feed-ul vechi le trimitea).
3. **Aceleași adrese de produs** acolo unde slug-ul vechi este valid (litere mici, cifre, cratime); restul primesc 301. Produsele fără SKU potrivit merg într-un raport de rezolvat manual. Categoriile, paginile și blogul au nevoie de o hartă de redirecturi separată.
4. **Aceleași etichete** `custom_label_*` și aceeași hartă categorie → `google_product_category` (derivată din feed-ul vechi cu scriptul `derive-google-category-map.js`).
5. **Verificare înainte de comutarea DNS**, cu un script de comparare între feed-ul vechi și cel nou (`compare-merchant-feeds.js` îl face în sistemul vechi). Criterii de trecere:
   - 0 id-uri lipsă;
   - 0 prețuri suspecte (vezi mai jos);
   - 0 duplicate în feed-ul nou;
   - toate adresele vechi răspund 200 sau 301 (niciodată 404);
   - toate linkurile din feed-ul nou răspund 200;
   - acoperirea atributelor cel puțin egală cu cea veche.
6. **După comutare**: reîncărcarea feed-ului în Merchant Center și urmărirea secțiunii „Diagnosticare" în primele zile; retrimiterea sitemap-ului în Search Console; urmărirea erorilor 404; **site-ul vechi rămâne accesibil ca rezervă** până când totul e verificat.

### Controlul prețurilor (urgent, independent de migrare)

În exportul de produse din arhivă, **15 produse au prețuri de ordinul zecilor de mii până al zecilor de milioane de lei** (de exemplu `Xhp60`, `TW1294`, `TW1295`), iar în `google-feed.xml` aceleași valori apar ca `<g:price>`. Un preț greșit într-un feed poate duce la suspendarea întregului cont Merchant, nu doar la respingerea produsului.

Reguli pentru magazinul nostru:
- Feed-ul se generează **din prețurile noastre verificate**, niciodată din exportul vechi.
- Generatorul de feed are un **plafon de plauzibilitate** configurabil (alertă și excludere din feed peste o valoare), plus un raport de produse excluse.
- Prețul din feed trebuie să fie egal cu prețul afișat pe pagina de produs (test automat).
- Cauza erorii vechi nu e stabilită: probabil eroare de scară sau de unitate la import. Se cere confirmarea prețurilor reale de la utilizator.

## 3. Întrebări deschise pentru utilizator (cer decizie înainte de lansare)

1. **Care este site-ul sursă al migrării Merchant**: vechiul site OpenCart de pe `totalwater.ro` (cum spune documentul de migrare) sau platforma construită anterior (adresele de imagini din export arată `totalwater.ro/api/uploads/...`)? De la el vin adresele și feed-ul de redirecționat.
2. **Structura adreselor de produs** în noul magazin: cu categorie în adresă (ca în vechiul sistem, cu 301 din restul) sau fără categorie? Decizia afectează redirecturile.
3. Prețurile reale ale celor 15 produse cu valori suspecte.
4. Există **servicii** (construcție, renovare, întreținere) care trebuie să aibă pagini proprii?
5. Paginile legale necesare, cu `INTREBARI-AVOCAT.md`.
