# Faza 4 — acoperirea testelor față de cerințe

Întocmit la punctul (16), pe codul de la închiderea fazei. Fiecare rând: cerința (din `docs/06-todo-master.md` și `docs/04`) → testul care o apără.
Tipuri: **U** unitar · **I** integrare (baza reală de test) · **E** E2E (browser, build de producție) · **A** test de arhitectură (citește sursa). Fișierele sunt date fără cale; se găsesc cu `git ls-files | grep <nume>`.

Golurile găsite la această trecere sunt marcate **GOL → umplut** și au testul adăugat (fără nicio schimbare de comportament). Golurile care rămân deschise sunt la finalul documentului.

## 1. Schema și constrângerile bazei de date

| Cerință | Test |
| --- | --- |
| `shippingClass` doar `standard`/`oversized`/`pallet`; status, tip, stoc: enum-uri CHECK | I `catalog-schema` (enum-uri, constante = CHECK-uri) |
| Sume nenegative, promoție ≤ preț, fereastră de promoție inversă, EAN 8–14 cifre, dimensiuni nenule, garanție ≥ 0 | I `catalog-schema` |
| SKU unic, cel mult o variantă implicită, slug unic pe TOATE produsele (și șterse), categoria primară unică | I `catalog-schema` |
| `legacyId` unic pe produs/categorie/brand, mai multe NULL permise | I `catalog-schema`, `product-lifecycle` |
| Media: FK `Restrict` (un fișier folosit nu se șterge din bază), media pe variantă doar a aceluiași produs | I `catalog-schema`, `media-usage` |
| Istoric de preț: un punct per variantă și moment, preț nenegativ | I `catalog-schema` |
| Istoric de cost: sumă nenegativă, sursă `manual`/`import` | **GOL → umplut** I `catalog-schema` («constrângeri completate…») |
| Adâncimea categoriei 0–10 în bază (serviciul: max 4) | **GOL → umplut** I `catalog-schema` |
| Cod de clasă de taxare (litere mici, cifre, `_`) | **GOL → umplut** I `catalog-schema` |
| Opțiuni/valori: o valoare per opțiune, valoarea a opțiunii indicate, opțiunea și varianta ale aceluiași produs, nume unice | I `catalog-options` |
| Atribute: cod stabil, unitate doar la numerice, valoare numerică exactă + filtrare pe interval, trigger «tip valoare = tip atribut», select cu opțiunile atributului | I `catalog-options`, `catalog-editor` |
| Relații: 6 tipuri, fără auto-relație, fără dubluri, dispar cu produsul | I `catalog-options`, `catalog-editor` |
| Clase/cote de taxare pregătite, nehardcodate (cota = `tax.standardRate`), o singură clasă implicită, 0–10000 bps | I `catalog-options` |
| Documente: tip, MIME, mărime, limbă; GPSR, energie și EPREL (https); hotspot (număr, poziție) | I `catalog-niche` |
| Canale: `web` de sistem nu se șterge (trigger), ofertă per variantă și canal, promoție cere preț (una setată/una nulă), mapare de categorii | I `channels` |
| Sarcini de imagini (15b): stare, poziție, rând, hash, motiv; `Media.sourceHash` unic | I `woo-images` («tabela sarcinilor») |
| Importuri: stare, format, mărime, rânduri, delimitator, cheie de stocare unică | I `import-service` |
| Audit append-only (fără UPDATE/DELETE), rezultat permis | U `append-only`; I `audit-service*` |

## 2. Permisiuni, ProductUpdateGuard, cost

| Cerință | Test |
| --- | --- |
| `products.content.write`: Editor, Manager, Admin, Owner; `products.write`, `products.export`, `catalog.legacy.edit` pe roluri | **GOL → umplut** U `rbac/catalog` (lista exactă de roluri) + U `matrix` (matricea din `docs/04` §6 = catalogul) |
| Prețul de achiziție: `cost.view` (Owner, Admin, Manager, Contabil), `cost.edit` (Owner, Admin) | U `rbac/catalog`, `can` |
| `ProductUpdateGuard`: deny-by-default, cerere mixtă respinsă întreagă, 403 cu numele câmpurilor, audit `denied` fără valori | U `product-write`, `product-service`; E `product-editor`, `products` |
| Orice acțiune/rută care scrie produse trece prin `withPermission("products.*")` (probă cu acțiune neîncadrată) | A `product-write-guard` |
| Rutele de scriere verifică Origin + permisiune | A `upload-route` |
| Paginile din admin cer permisiune; rutele `api/admin` la fel | A `admin-pages-guard`, `admin-routes-guard` |
| Costul: proiecție admin (câmp ABSENT fără `view`), proiecție publică pe listă albă, scrierea cere `edit` ȘI `view` | U `cost-price`; I `cost-price` |
| Costul nu ajunge în suprafețe publice, componente client, export, import, audit, loguri | A `cost-exposure`; U `cost-price`, `redact`, `logger`; I `export-service`; E `product-editor`, `products`, `product-export`, `product-import*` |
| Editorul nu vede costul în HTML; Managerul îl vede doar pentru citire; Owner îl editează cu istoric | E `product-editor` |

## 3. Reguli de produs

| Cerință | Test |
| --- | --- |
| Slug (diacritice RO), adresă unică cu sufix, conflict cu produsele șterse | U `slug`, `product-service`; I `catalog-schema`, `product-lifecycle` |
| Generator de variante: produs cartezian, limite, SKU-uri unice, plan de sincronizare fără ștergeri tăcute | U `variant-generator`, `product-service`; I `catalog-editor`; E `product-catalog-data` |
| Istoric de preț la schimbarea prețului; Omnibus (cel mai mic preț în 30 de zile) | U `price-history`, `product-service`; I `catalog-schema` |
| Activare: garanția implicită din setare; EAN și brand NU sunt obligatorii | U `product-service`; E `product-editor` |
| Publicare pe canal: EAN/brand obligatorii doar unde canalul le cere | U `publication`; I `channels` |
| Editare în masă: max 50, tranzacție unică, confirmare explicită, audit agregat; preț ±% fără zero/negativ/plafon | U `product-service`; E `products` |
| Duplicare (fără cost, EAN, stoc, documente, identificatori vechi), arhivare, coș, restaurare, ștergere definitivă doar din coș | U `product-lifecycle`, `product-lifecycle-rules`; I `product-lifecycle`; E `product-lifecycle` |
| Categorii: arbore, mutare validată (cicluri, adâncime, frați), ștergere refuzată cu numărul de produse; «>» și «\|» interzise în nume | U `category-service`, `category-tree`; I `category-brand`; E `categories` |
| Brand: CRUD, logo, ștergere refuzată cât are produse | I `category-brand`, `catalog-schema`; E `categories` |
| Atribute pe produs cu valori numerice exacte, relații din ambele părți | U `attributes`, `product-relations`; E `product-catalog-data` |

## 4. Listă, editor, media

| Cerință | Test |
| --- | --- |
| Listă: căutare titlu/SKU/EAN/cod producător, filtre (categorie cu subcategorii, brand, stare, livrare, stoc), sortare, paginare pe server | U `product-list`; I `product-list`; E `products` |
| Listă: doar `thumb`, doar pentru fișiere gata; fără cost în rânduri/URL/props | I `product-list`; E `products` |
| Editor pe taburi (General, Prețuri, Variante, Stoc, Atribute, Categorii, Media, SEO, GPSR, Asociate, Documente), nesalvat → dialog propriu | E `product-editor`; U `pricing-form` |
| Tab Media cu `MediaPicker`; media atașată în ordine, prima principală | U `product-assignments`; I `product-assignments`; E `media-picker`, `product-editor` |
| Provider de utilizare media (produs, categorie, brand, fișă): fișier folosit nu se șterge, după scoatere se poate; test care pică dacă lipsește providerul | I `media-usage`, `media-usage-wiring`; E `categories`, `media-picker`, `parts-diagrams` |
| Biblioteca media: upload, tipuri din octeți, limită de pixeli, variante, servire publică/semnată, S3 | U `image`, `media-service`, `upload-handler`, `serve`, `processing`, `variants`; I `media-upload`, `library`, `serve` (S3), `media-queue` (S3); E `media`, `media-s3` |

## 5. Documente, GPSR, fișe explodate

| Cerință | Test |
| --- | --- |
| Documente: Origin, sesiune, `content.write`, rate limit, limită pe flux, tip din octeți, PDF cu conținut activ refuzat, cheie generată de server, audit | U `product-document-handler`, `product-documents`; I `product-documents`; E `product-documents` |
| Descărcare cu link semnat și antete de securitate; ștergere/înlocuire fără orfani; `docs:sweep-orphans` strict pe prefix | U `product-documents`; E `product-documents` |
| Conformitate: GPSR, clasă energetică, EPREL doar https; Editorul doar citire | I `catalog-niche`; E `product-documents` |
| Fișă explodată în spatele flag-ului `partsDiagrams` (meniu, rută 404, serviciu); hotspot în puncte-bază; imagine protejată; imagine mare (10–20 MB) | U `parts-diagram-service`; A `parts-diagram-flag`; I `parts-diagram`, `catalog-niche`; E `parts-diagrams` |

## 6. Import și export

| Cerință | Test |
| --- | --- |
| Încărcare: Origin, sesiune, `products.write`, rate limit, limită pe flux, format din octeți | U `import-handler`; E `product-import` |
| CSV: delimitator, `sep=`, Windows-1250 din Excel, BOM; XLSX: prima foaie, fără macro-uri, bombe zip | U `import-file`, `import-service`; E `product-import` |
| CSV generat doar prin funcția comună (UTF-16LE + BOM + TAB, fără `sep=`) | A `csv-generation`; U `import-file` (toCsv) |
| Injecție de formule: neutralizare la export, restaurare la import, dus-întors | U `cell-safety`, `import-plan` |
| Planificare: câmpuri, mapare automată, upsert pe SKU, `-` șterge, arhivate/șterse ignorate, preț în lei → bani exact | U `import-plan`, `import-service` |
| Dry-run fără scrieri; aplicare legată de amprentă; un singur eveniment de audit; idempotență; job în fundal | I `import-service`; E `product-import` |
| Prețul de achiziție nu se importă (coloană blocată, mapare refuzată) | U `import-plan`; E `product-import` |
| WooCommerce: coloane, simple/variabile/variații, categorii/branduri/atribute create doar după confirmare, relații, HTML → text, unități exacte, `legacyId` | U `woo-plan`, `html-to-text`; I `woo-import`; E `product-import-woo` |
| Imagini din adrese (15b): fără rețea la verificare, descărcare în fundal, idempotență, reatașare, eșec pe imagine, drepturi, ordinea, utilizare media | U `woo-plan-images`; I `woo-images`; E `product-import-woo` (15b) |
| SSRF: adresă (https/443/IP/lista), DNS public pentru toate adresele, conexiune fixată, redirecturi, limite; rețeaua doar prin `safeFetchImage`; fără comutator | U `safe-fetch`, `ip-guard`; A `network-access`; I `woo-images` |
| Imagini din adrese pe stocarea S3/MinIO | **GOL → umplut** I `woo-images` («pe stocarea S3 reală») |
| Setarea `imageImport.allowedHosts` validată (IP, port, wildcard, schemă refuzate), citită fără cache, eșuează la valoare invalidă | **GOL → umplut** U `registry`, `settings-service.more` |
| Istoric de importuri: listă, detalii, retenție, importuri întrerupte, permisiuni | I `import-history`; E `product-import-history` |
| Export CSV/XLSX: domeniu (selecție/filtre/tot), fără cost, formule neutralizate, dus-întors cu importul, limită, flux, `products.export`, POST | U `export-rows`, `export-handler`; I `export-service`; E `product-export` |

## 7. Goluri rămase deschise

- **Import de 5.000 de rânduri (timp și memorie):** nu există încă un test automat, fiindcă durata nu are loc într-o suită obișnuită; se măsoară cu scriptul din Blocul B și numerele intră în PROGRESS.
- **Interogările din listă și filtre (planuri `EXPLAIN`, indexuri):** se verifică în Blocul B.
- **Import de imagini de pe un domeniu real și un fișier WooCommerce real:** doar manual (confirmat de utilizator la 15b).
