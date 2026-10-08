# 02 — Lista „COMPLET" și lista „FUNCȚIONAL"

Două liste diferite, pe care lumea le confundă:

- **COMPLET** = ce vede și folosește omul. Funcționalități.
- **FUNCȚIONAL** = ce trebuie să existe ca magazinul să chiar meargă în producție și să poată fi operat zilnic. Infrastructură, conturi, procese, conformitate.

Un magazin poate fi „complet" și totuși nefuncțional (n-are cont de procesator de plăți). Și invers.

Legendă prioritate: **[MVP]** = fără asta nu poți vinde · **[Val 1]** = în primul lansat · **[Val 2]** = val ulterior

---

# PARTEA A — COMPLET (funcționalități)

## A1. Catalog
- [MVP] Produse simple (titlu, slug, descriere, preț, SKU, imagini, stoc)
- [MVP] Categorii ierarhice (nelimitat pe adâncime)
- [MVP] Galerie de imagini + imagine principală, alt-text
- [MVP] Stoc și disponibilitate (în stoc / stoc limitat / stoc epuizat / la comandă)
- [MVP] Preț de listă + preț redus + calcul procent reducere
- [V1] Variante (mărime, culoare, capacitate) cu stoc și preț per variantă
- [V1] Atribute și specificații tehnice (structurate, filtrabile)
- [V1] Branduri / producători cu pagini proprii
- [V1] Colecții / campanii (curatoriate manual sau prin reguli)
- [V1] Produse asociate: similare, accesorii, „se cumpără împreună", upsell/cross-sell
- [V1] Etichete / badge-uri (Nou, Bestseller, Resigilat, Ultimele bucăți)
- [V1] Produse digitale (fișier + link de descărcare limitat în timp/număr)
- [V2] Bundle-uri / kituri cu preț propriu și stoc derivat
- [V2] Produse configurabile (personalizare: gravură, text, upload fișier)
- [V2] Abonamente / livrare recurentă
- [V2] Produse pe bază de rezervare / programare
- [V2] Video pe pagina de produs, 360°, ghid de mărimi

## A2. Navigare, căutare, descoperire
- [MVP] Pagină de listare (PLP) cu paginare
- [MVP] Sortare (relevanță, preț, noutate, popularitate)
- [MVP] Căutare text
- [V1] Filtre faceted (preț, brand, atribute, disponibilitate, reducere) cu contorizări
- [V1] Autocomplete în search (produse, categorii, sugestii)
- [V1] Corectare typo, sinonime, redirect-uri de search
- [V1] Breadcrumbs
- [V1] Vizualizate recent
- [V2] Comparare produse
- [V2] Recomandări personalizate

## A3. Coș și checkout
- [MVP] Adăugare/modificare/ștergere din coș, cu persistență
- [MVP] Coș pentru vizitator (cookie) + merge la login
- [MVP] Mini-cart / drawer
- [MVP] Checkout ca vizitator (guest) — **nu forța crearea de cont**
- [MVP] Adresă de livrare + adresă de facturare distinctă
- [MVP] Alegere metodă de livrare cu cost calculat
- [MVP] Alegere metodă de plată
- [MVP] Sumar comandă cu subtotal, transport, TVA, total
- [MVP] Acceptare termeni + confirmare comandă
- [MVP] Pagină „mulțumim" cu detaliile comenzii
- [V1] Facturare pe firmă (CUI, Reg. Com., bancă, IBAN) cu validare CUI
- [V1] Cupoane / coduri de reducere în checkout
- [V1] Selectare easybox / punct de ridicare pe hartă
- [V1] Validare adresă + autocomplete
- [V1] Recuperare coș abandonat (email la 1h / 24h / 72h)
- [V1] Transport gratuit peste prag (cu indicator „mai ai X lei")
- [V2] Card gift / bon valoric
- [V2] Cumpărare rapidă (Apple Pay / Google Pay / one-click)
- [V2] BNPL (plată în rate fără dobândă)
- [V2] Livrare programată pe interval orar

## A4. Cont de client
- [MVP] Înregistrare, login, logout, resetare parolă
- [MVP] Confirmare adresă de email
- [MVP] Istoric comenzi + detaliu comandă
- [MVP] Agendă de adrese
- [V1] Login social (Google) și/sau magic link
- [V1] Tracking comandă (și pentru guest, pe bază de nr. comandă + email)
- [V1] Wishlist / favorite
- [V1] Inițiere retur din cont + status retur
- [V1] Descărcare facturi PDF
- [V1] Preferințe de comunicare (newsletter, SMS) + dezabonare
- [V1] Export date personale + ștergere cont (GDPR)
- [V2] Puncte de loialitate / cashback
- [V1] **Grup de client cu discount procentual** (Partener, Client fidel) — vezi `09`
- [V2] Plată la termen prin ordin de plată, cu limită de credit
- [V2] Alertă „anunță-mă când revine în stoc"

## A5. Conținut și pagini
- [MVP] Homepage editabil din admin (secțiuni drag & drop)
- [MVP] Pagini statice: Despre noi, Contact, Livrare, Plată
- [MVP] Pagini legale: Termeni și condiții, Politica de confidențialitate, Politica de cookie-uri, Politica de retur, GDPR, ANPC/SOL
- [MVP] Formular de contact funcțional
- [MVP] 404 / 500 personalizate
- [V1] Blog / articole cu categorii și autori
- [V1] FAQ cu categorii și căutare
- [V1] Bannere și pop-up-uri programabile
- [V1] Meniuri configurabile (header, footer, mobil)
- [V1] Landing pages de campanie
- [V2] Multi-limbă cu traduceri per câmp
- [V2] Test A/B pe secțiuni de homepage

## A6. Încredere și social proof
- [V1] Recenzii de produs cu rating, moderare, „achiziție verificată"
- [V1] Solicitare automată de recenzie la X zile după livrare
- [V1] Întrebări și răspunsuri pe pagina de produs
- [V1] Afișare rating agregat + rich snippets
- [V2] Foto/video în recenzii
- [V2] Badge extern de încredere (Trusted.ro, Google Customer Reviews)
- [V2] User-generated content pe homepage

## A7. Marketing
- [V1] Newsletter (înscriere, dublu opt-in, dezabonare)
- [V1] Cupoane: procent, sumă fixă, transport gratuit, cu condiții (valoare minimă, produse/categorii, prima comandă, per client, limită de utilizări, interval)
- [V1] Reguli automate de reducere (2+1 gratis, X% la a doua bucată, reducere pe categorie)
- [V1] Feed Google Merchant Center + Facebook Catalog
- [V1] Pixeli & tracking: GA4, Meta, TikTok, Google Ads — cu evenimente eCommerce complete
- [V1] Consent Mode v2 + banner de cookie-uri granular
- [V2] Program de recomandare (referral)
- [V2] Segmente de clienți + campanii automate
- [V2] Notificări push web

## A8. Panou de administrare
Detaliat în fișierul 04. Pe scurt: Dashboard · Comenzi · Clienți · Produse · Stoc · Categorii · Reduceri · Retururi · Recenzii · CMS · Media · Marketing · SEO · Rapoarte · Setări · Integrări · Utilizatori & Roluri · Jurnal audit · Aspect/Temă · Developer.

## A9. Specific white-label (pachet instalabil)
- [MVP] **Wizard de instalare** în browser (sub 5 minute de la zero la magazin funcțional)
- [MVP] Branding complet din admin: nume, logo, favicon, OG, culori, fonturi, radius
- [MVP] Date firmă într-un singur loc, propagate în footer, facturi, emailuri, pagini legale
- [MVP] Presets de temă + preview live
- [MVP] Zero hardcodare: pachetul proaspăt instalat e complet neutru
- [V1] Feature flags pentru funcțiile opționale (blog, recenzii, wishlist, multi-depozit)
- [V1] CSS custom și scripturi custom din setări
- [V1] Generator de pagini legale precompletate cu datele firmei
- [V1] Mecanism de actualizare cu backup automat și rollback
- [V1] Sistem de extensii (hooks, override de componente, blocuri CMS custom)
- [V2] Licențiere opțională
- [V2] Multi-limbă pentru interfața de admin

## A10. Grupuri de clienți și prețuri de partener
Vezi `09-preturi-si-parteneri.md`. Pe scurt: un preț public unic, cu TVA inclus, identic
pentru toți · clienții marcați ca Partener sau Client fidel văd același preț minus X% ·
niciun preț nu se ascunde · regulă configurabilă de cumulare cu promoțiile publice ·
produse și categorii excludabile din discount · atribuire de grup în masă din admin.

---

# PARTEA B — FUNCȚIONAL (ce trebuie să existe ca să meargă cu adevărat)

## B1. Fundație tehnică
- [ ] Repo Git + branch strategy + `.env.example` + `.gitignore` corect
- [ ] `docker-compose.dev.yml`: Postgres, Redis, MinIO, Mailpit, (Meilisearch)
- [ ] Schema de env validată cu Zod — aplicația **refuză să pornească** dacă lipsește o variabilă
- [ ] Migrații versionate + script de seed cu date demo realiste
- [ ] TypeScript strict, ESLint, Prettier, Husky + lint-staged
- [ ] CI: typecheck + lint + test + build la fiecare PR
- [ ] Health check endpoint (`/api/health`) care verifică DB + Redis
- [ ] Sistem de loguri structurate cu `requestId`
- [ ] Sentry configurat cu source maps

## B2. Date și integritate
- [ ] Model de date complet (fișierul 04), cu indexuri corecte
- [ ] Constrângeri la nivel de DB: unique, foreign keys, check constraints
- [ ] Tranzacții atomice pe: plasare comandă, decrement stoc, anulare, retur
- [ ] Blocare optimistă/pesimistă pe stoc (evită vânzarea aceluiași ultim produs de 2 ori)
- [ ] Rezervare de stoc cu expirare
- [ ] Snapshot imutabil al comenzii
- [ ] Soft delete + `deletedAt` pe entitățile de business
- [ ] Backup automat zilnic (dump + upload off-site) + **procedură testată de restore**

## B3. Autentificare și permisiuni
- [ ] Sesiuni sigure, expirare, revocare
- [ ] Hashing parole (argon2id / bcrypt cost ≥12)
- [ ] Verificare email, resetare parolă cu token cu expirare
- [ ] RBAC: roluri (Owner, Admin, Manager, Editor, Suport, Depozit) + permisiuni granulare
- [ ] 2FA pentru admini
- [ ] Rate limiting + blocare temporară după N încercări eșuate
- [ ] Instalare blocată permanent după setup (`/install` → 404)

## B4. Comerț — logica critică
- [ ] **Motor de prețuri**: preț de bază → listă de prețuri (grup client) → promoții → cupon → TVA. Ordine deterministă și testată.
- [ ] **Motor de TVA**: cote configurabile per produs, TVA extras din prețul brut, rotunjire pe linie
- [ ] **Motor de transport**: zone (județ/localitate), praguri de greutate/valoare, gratuit peste X, transport per produs, ramburs
- [ ] **Motor de promoții**: reguli, condiții, cumulare, prioritate, excludere
- [ ] **State machine de comandă** cu tranziții permise explicit (vezi fișierul 04)
- [ ] **Idempotență** pe plasare comandă și pe webhook-uri de plată
- [ ] Numerotare comenzi și facturi fără goluri, thread-safe
- [ ] Reconciliere plăți: ce e în procesator = ce e în DB

## B5. Conturi și servicii externe (le deschizi TU, nu se scriu în cod)
- [ ] Procesator de plăți: cont + contract + chei test și live + webhook URL declarat
- [ ] Cont curier (Sameday / FAN / Cargus / DPD) + credențiale API + contract
- [ ] Furnizor de facturare (Oblio / SmartBill / FGO) + cont + serie facturi
- [ ] **e-Factura ANAF**: certificat digital calificat + înrolare SPV + aplicație OAuth
- [ ] Domeniu + DNS + certificat SSL
- [ ] Serviciu de email tranzacțional + **SPF, DKIM, DMARC configurate** (altfel ajungi în spam)
- [ ] Storage S3/R2 bucket + CDN
- [ ] Google Search Console + Google Analytics + Google Merchant Center
- [ ] Meta Business + Pixel + Conversions API
- [ ] VPS (min. 4 vCPU / 8 GB RAM / 80 GB SSD pentru început) + firewall + fail2ban
- [ ] Serviciu de backup off-site
- [ ] Uptime monitoring (UptimeRobot / BetterStack)

## B6. Conformitate legală (România/UE) — **fără astea nu ai voie să vinzi**
Detaliat în fișierul 05. Minim:
- [ ] Date complete firmă în footer și pe facturi (denumire, CUI, Reg. Com., sediu, capital, contact)
- [ ] Link ANPC + link platforma SOL/ODR + SAL în footer
- [ ] Termeni și condiții, drept de retragere 14 zile + formular de retur tip
- [ ] Politica de confidențialitate + politica de cookie-uri + banner de consimțământ real (blocare scripturi până la accept)
- [ ] Registru de prelucrări GDPR, procedură de ștergere/export date
- [ ] Prețuri cu TVA inclus pentru B2C + preț pe unitate de măsură unde e cazul
- [ ] **Directiva Omnibus**: la reduceri, afișarea celui mai mic preț din ultimele 30 de zile
- [ ] **GPSR**: date producător / persoană responsabilă în UE, pe fiecare produs
- [ ] Garanție legală de conformitate (2 ani) menționată
- [ ] Confirmare de comandă pe email cu toate informațiile precontractuale

## B7. Operare zilnică (ce face omul care ține magazinul)
- [ ] Un operator poate procesa o comandă cap-coadă din admin, fără SQL
- [ ] Generare AWB dintr-un click + printare etichetă
- [ ] Emitere factură automată la plată confirmată
- [ ] Anulare, rambursare parțială/totală, editare comandă
- [ ] Import/export produse CSV/XLSX cu raport de erori pe rând
- [ ] Actualizare stoc în masă
- [ ] Căutare rapidă globală în admin (comenzi, clienți, produse)
- [ ] Notificări pentru echipă (comandă nouă, stoc mic, plată eșuată)
- [ ] Jurnal de audit: cine, ce, când a modificat
- [ ] Rapoarte: vânzări pe zi/produs/categorie/canal, AOV, rata de conversie, retururi

## B8. Emailuri tranzacționale (lista completă minimă)
Confirmare comandă · Proformă (transfer bancar) · Plată primită · Plată eșuată · Comandă în procesare · Comandă expediată + AWB · Comandă livrată · Comandă anulată · Rambursare procesată · Retur primit/aprobat/respins · Bun venit · Verificare email · Resetare parolă · Coș abandonat (×3) · Cerere de recenzie · Produs revenit în stoc · Newsletter · Notificare internă comandă nouă · Notificare internă stoc epuizat.

Toate: versiune HTML + text, branding din setări, preheader, link de dezabonare unde e cazul.

## B9. Performanță și SEO
- [ ] Core Web Vitals: LCP < 2.5s, INP < 200ms, CLS < 0.1 pe mobil
- [ ] `next/image` cu AVIF/WebP, dimensiuni corecte, lazy loading
- [ ] ISR/cache pe PLP și PDP + invalidare la modificare produs
- [ ] Sitemap.xml dinamic (produse, categorii, pagini, blog) + robots.txt
- [ ] Structured data: Product, Offer, AggregateRating, BreadcrumbList, Organization, FAQPage
- [ ] Meta title/description editabile per entitate + fallback-uri
- [ ] Canonical, hreflang (dacă multi-limbă), paginare corectă
- [ ] Redirect-uri 301 gestionabile din admin
- [ ] Fără CLS pe pagina de produs (rezervă spațiu pentru imagini)

## B10. Testare (minimul care te salvează)
- [ ] Unit: motor de prețuri, TVA, promoții, transport, state machine
- [ ] Integrare: plasare comandă, webhook plată, decrement stoc
- [ ] E2E Playwright: **fluxul complet de cumpărare** (guest + logat), retur, admin creează produs
- [ ] Test de instalare curată (wizard de la zero pe DB goală)
- [ ] Test de idempotență webhook (același eveniment de 3 ori = un singur efect)
- [ ] Test de concurență pe stoc (10 cereri simultane pe ultimul produs)

## B11. Deploy și producție
- [ ] Dockerfile multi-stage optimizat (`output: 'standalone'`)
- [ ] `docker-compose.prod.yml` + reverse proxy (Caddy/Nginx) + SSL automat
- [ ] Migrații rulate automat, controlat, la deploy
- [ ] Zero-downtime deploy sau fereastră de mentenanță anunțată
- [ ] Variabile de mediu gestionate securizat (nu în repo)
- [ ] Worker separat pentru joburi + cron-uri
- [ ] Rotire loguri, limite de resurse, restart policy
- [ ] Runbook: ce faci când pică plata / curierul / DB-ul
