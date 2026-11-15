# 21 — Referințe și plan de design pentru vitrină (Faza 6)

> **Statut:** document de lucru al Fazei 6, scris înainte de cod (2026-11-15). Conține: planul de design în formatul skill-ului `frontend-design`, verificat față de brief; analiza referințelor UX alese de utilizator (ce preluăm, ce evităm); nota despre skill; legătura cu cerințele SEO din `19` §1. Se actualizează după punctul de control.
> **Referințele sunt doar inspirație:** fără logo, texte, imagini sau design recognoscibil copiat; fără capturi din site-urile lor în repo. Nimic din identitatea Apple să nu se vadă.
> **Nu conține estimări de timp.**

## 1. Brief (decizia utilizatorului)

Magazin online white-label pentru echipamente de piscine (România), construit de la zero. Public: proprietari de case și instalatori; sarcina principală a vitrinei: să găsești produsul potrivit (filtre bune, în Faza 7) și să ai încredere să-l cumperi. Direcția vizuală: **«echilibrat»** = modern, aerisit și curat, carduri mari, tipografie mare, imagini în prim-plan, fără aglomerație, nici minimalist gol, nici catalog dens; trebuie să se simtă contemporan, nu ca un site din 2010.

Formula utilizatorului: aerisirea și cardurile curate ca la Apple + hero fotografic și tipografie mare ca la lumeapiscinelor.ro + funcționalitatea de magazin ca la totalwater.ro.

## 2. Planul de design (formatul skill-ului)

### 2.1 Culoare

Valorile intră **doar** în `packages/core/src/branding/presets.ts` (preseturile) și ajung în pagini prin variabile CSS generate pe server din `Branding`; componentele nu conțin nicio valoare. Fiecare cuplu text/fundal trece AA (4,5:1), inclusiv pe suprafața înclinată a cardurilor; testul din `branding.test.ts` o impune pentru toate cele 3 presets, în ambele teme.

Presetul **implicit, Minimal («echilibrat»)**, tema deschisă:

| Nume | Rol | Valoare | Contrast |
|---|---|---|---|
| Hârtie | pagina (`bg`) | `#ffffff` | – |
| Cerneală | text (`fg`) | `#12171c` | 18,0:1 pe pagină |
| Apă adâncă | acțiune principală, butoane, focus (`primary`) | `#0b5cad` | 6,7:1 cu text alb |
| Turcoaz | accent de expresie în titlul mare, detalii (`accent`) | `#0e7490` | 5,4:1 pe pagină |
| Ceață | text secundar (`muted`) | `#55606b` | 6,4:1 pe pagină, 5,9:1 pe card |
| Linie | borduri și fundalul cardurilor (derivat 35% din ea) (`border`) | `#dfe5ea` | – |

Succes `#15803d` și Pericol `#b91c1c` (comune, AA). Tema închisă: pagină `#0d1217`, text `#f1f5f8`, acțiune `#5aa9f2`, accent `#4fd1e0`.

### 2.2 Tipografie

Minimal: **o singură familie, Manrope**, jucând pe greutăți (titluri 700, corp 400/500); titlurile mari strânse (`letter-spacing` negativ mic). Bold: Montserrat 800 (titluri) + Open Sans (corp). Editorial: Playfair Display (titluri) + Inter (corp: specificațiile și tabelele rămân lizibile). Toate prin `next/font` (servite de pe domeniul magazinului, `19` §1), din lista permisă din `tokens.ts`. Scara e fluidă (`clamp`), cu titlul mare de până la ~4,5 rem pe desktop și ~2,5 rem pe telefon, corp 1 rem, linii sub 70 de caractere.

### 2.3 Layout

Concept: pagina e un **canvas luminos cu cardurile mari așezate pe el**; imaginea de produs e eroul fiecărui card; deasupra, un hero fotografic cu titlu mare. Aliniere: stânga (conținut, liste, footer); centrat doar în hero-ul de secțiune și în stările goale.

```
Desktop 1440
┌──────────────────────────────────────────────────────────────────────┐
│ bara de anunț (opțională, o linie)                                    │
│ [logo]   [   căutare centrată (dezactivată până la Faza 7)   ] ☎ cont ♡ coș │
│ Produse ▾  Categorie  Categorie  Categorie            (mega menu: listă │
│                                                        în stânga, subcat.│
│ ┌ hero fotografic, strat întunecat, meniu transparent peste el ───────┐ │ în dreapta)
│ │  Titlu foarte mare cu                                               │ │
│ │  o expresie în accent                                               │ │
│ │  [Buton pastilă]  [Buton secundar]                                  │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│  bandă de încredere: 4 repere într-un singur rând                        │
│ ┌ card ─┐ ┌ card ─┐ ┌ card ─┐ ┌ card ─┐   carduri mari, colțuri rotunjite   │
│ │ imag. │ │ imag. │ │ imag. │ │ imag. │                                  │
│ └───────┘ └───────┘ └───────┘ └───────┘                                  │
│ footer: coloane de linkuri, date firmă, ANPC / SAL                       │
└──────────────────────────────────────────────────────────────────────┘
Telefon 390: logo + pictograme (meniu, căutare, coș); hero cu titlu pe 3 rânduri;
cardurile pe un singur rând sau 2 coloane; meniul într-un drawer din stânga.
```

Componente de bază (Faza 6): container, buton (pastilă, plin / contur / fantomă / pe imagine), card și card de produs (doar structură: imagine, nume, preț primit ca text, stare), pastile de stare, câmp de căutare, hero, bandă de încredere, header cu mega menu, drawer de navigare, footer, bară de anunț, schelete, pagini 404 / 500 / mentenanță.

### 2.4 Principii

1. **Spunem «echilibrat» prin proporții, nu prin decor:** spațiu generos între secțiuni, carduri mari, o singură linie de text sub fiecare titlu, fără chenare dublate.
2. **O singură «șoaptă» tare pe pagină:** titlul mare din hero (cu expresia lui în accent). Restul rămâne calm.
3. **Forma urmează ierarhia:** raze diferite pentru carduri mari, butoane și câmpuri, nu o singură rază pe tot.
4. **Imaginea de produs e prima, textul al doilea;** prețul și starea sunt mereu vizibile în card.
5. **Funcționalitatea magazinului în față, aspectul în spate:** căutare centrată, meniu cu categorii, telefon la vedere, încredere (livrare, garanție, plată) în același loc.
6. **Conversia, accesibilitatea și performanța au prioritate peste «riscul estetic»** (regula utilizatorului).

### 2.5 Verificare față de brief, înainte de cod

Am confruntat planul cu ce aș produce pentru orice magazin de acest fel (alb, albastru, carduri rotunjite, hero cu degrade) și am schimbat patru lucruri:

1. **Albastrul «implicit de SaaS» + gri pe gri** devenea o paletă fără subiect. Am păstrat albastrul doar ca acțiune («apă adâncă», mai întunecat decât albastrul uzual, 6,7:1) și am adus **turcoazul** ca accent de expresie: vine din subiect (apa), nu din șablon.
2. **Editorial** era varianta cunoscută «hârtie cremă + serif + teracotă» (marcată în skill ca reflex generat). Am schimbat-o în **hârtie rece + bleumarin + alamă** (Playfair pentru titluri, Inter pentru corp), ca să nu semene cu un blog de lifestyle.
3. **Aceeași rază și aceeași umbră peste tot** (kitul de «carduri identice») → raze pe trepte (card mare, buton pastilă în Minimal, dreptunghiular în Editorial, câmp mic), **umbră doar la ce plutește** (meniu, drawer, dialog); cardurile stau pe fundal înclinat, fără umbră.
4. **Mizerii tipografice de șablon** (etichete cu majuscule deasupra fiecărui titlu, săgeți «→» pe butoane, șiruri cu puncte mediane, numere 01/02/03 fără o secvență reală): nu apar în componente.

## 3. Referințele UX analizate

Analizate pe 2026-11-15 cu browserul (pagini publice; nimic salvat în repo).

### 3.1 apple.com/shop (ex. `/shop/buy-iphone`)

**Preluăm:** pagina deschisă la culoare cu **carduri albe mari** (colțuri bine rotunjite) așezate pe un fundal ușor înclinat; titlul paginii foarte mare, urmat de o singură frază de ghidare; **produsul în prim-plan** (imagine mare, centrată), un nume scurt, o linie de preț, o acțiune; ierarhie clară prin mărime și greutate, nu prin borduri; rând de legături simple pentru «vederi» (Toate modelele / Selecții / …) în loc de meniuri dense.
**Evităm:** cardurile în carusel orizontal cu scroll ascuns (la noi grilă, ca să se vadă și fără JS și să se poată indexa); fotografia de studio izolată pe alb ca singură identitate; fontul, cromul și paleta lor; bara de nav minimalistă fără căutare vizibilă (la noi, căutarea e centrală); butonul albastru «Buy» ca formă identitară. **Nimic recognoscibil:** nici fundalul gri exact, nici tipografia sau animațiile lor.

### 3.2 lumeapiscinelor.ro

**Preluăm:** **hero fotografic pe toată lățimea**, cu strat întunecat pentru lizibilitate; **titlu foarte mare** (aprox. 100 px pe desktop) cu **o expresie în culoare de accent**; **meniul transparent peste hero**; **butoane pastilă / rotunjite**, unul plin și unul contur; **bară de cifre** sub hero (repere de încredere); un apel la acțiune pe calculator (la noi, mai târziu: alegerea pompei sau a filtrului după volumul piscinei, Faza 7).
**Evităm:** fundalul întunecat total și neonul turcoaz ca identitate (la noi presetul implicit e deschis); animația de intrare a paginii (la încărcare, prima imagine apare aproape neagră, cu fade-in; contra LCP și accesibilității); etichetele cu majuscule și numerele de pas, doar unde conținutul e într-adevăr o secvență; textul foarte mic al paragrafelor de pe imagine (la noi, minim 1 rem și contrast AA pe strat).

### 3.3 totalwater.ro (doar referință vizuală, nu sursă de date)

**Preluăm (doar funcționalitate):** **căutare centrată în header**; **mega menu** cu lista de categorii în stânga și subcategoriile în dreapta; **bandă de încredere** (consultanță, experiență, prețuri) sub hero; **telefoane vizibile în header**; coș cu total în header; **banner de cookie-uri cu «Refuz», «Preferințe» și «Accept tot»** de greutate egală (se potrivește cu consimțământul implicit «refuzat» din `19` §1).
**Evităm:** aglomerarea (trei telefoane, trei benzi, bannere suprapuse în primul ecran, două rânduri de navigare plus telefoane, texte mici); banner de cookie-uri care acoperă mega menu-ul; o pagină principală cu 10+ secțiuni de același nivel. **Nu copiem** logo, texte, imagini, adrese, telefoane sau structura de categorii.

### 3.4 Baymard Institute — liste de produse și filtre (public)

Surse: articolele publice «Product Listing Page (PLP) UX» (2026) și «What Is an Ecommerce Filter? UI Best Practices» de pe baymard.com; ghidurile complete sunt cu plată și **nu** sunt reproduse. Folosite ca **listă de reguli de UX**, nu ca aspect; se aplică în Faza 7 (PLP, filtre), iar cerințele de design (carduri, chip-uri) se pregătesc acum:

1. filtrele arată **numărul de rezultate** lângă fiecare opțiune;
2. **selecție multiplă** în aceeași grupă de filtre;
3. filtrele aplicate apar ca **chip-uri eliminabile**, vizibile deasupra grilei (28% dintre site-uri nu o fac);
4. filtre **specifice categoriei** (aici: debit, putere, volum piscină, cu slider; `15` și `06` Faza 7), nu doar generale;
5. pe desktop, **panou de filtre persistent**; pe telefon, **sertar de filtre** deschis dintr-un buton «Filtrează» fix;
6. cardul de produs e **ușor de scanat**: titlu proeminent, atributele separate de titlu, preț și atribute-cheie direct în listă, aceleași atribute pe produse similare;
7. **fiecare produs are miniatură**, care reprezintă ce se vinde (inclusiv ce conține pachetul);
8. **orientarea la navigare**: revenirea (Înapoi) păstrează poziția și filtrele.

### 3.5 Un al cincilea site (propunere pentru punctul de control)

Un magazin specializat de produse pentru piscine din altă piață, cu **ghid de alegere după volumul piscinei** (de exemplu leslies.com), pentru modul în care leagă calculatorul de produse. Propus, **neanalizat** până la aprobarea utilizatorului.

### 3.6 Direcția rezultată

«Echilibrat» = **aerisirea și cardurile curate din 3.1** + **hero fotografic, titlu mare cu expresie în accent, meniu transparent, pastile, bară de cifre din 3.2** + **căutare centrată, mega menu, bandă de încredere, telefon în header, consimțământ cu butoane egale din 3.3** + **regulile din 3.4**. Mărimile și raportul dintre ele sunt ale noastre (§2).

## 4. Skill-ul `frontend-design`: verificat integral, tensiuni și reguli de aplicare

Fișierul local (`.claude/skills/frontend-design/SKILL.md`, ignorat de git, necomis) a fost citit **integral**. Nu conține instrucțiuni de securitate, de acces la rețea sau de instalare; nu contrazice regulile de securitate din `CLAUDE.md`. Tensiuni cu proiectul și cum le rezolv:

| Ce spune skill-ul | Tensiune cu proiectul | Regula de aplicare |
|---|---|---|
| «Identitate distinctă, risc estetic» | produs **white-label**: nicio valoare de brand în componente (`CLAUDE.md`, regula #1) | identitatea stă **numai în valorile celor 3 presets** (`presets.ts`); componentele folosesc tokeni |
| «Gândește-ți textele, copy distinct» | nimic hardcodat; textele pot fi în română și pe mai multe instalări | textele stau în mesaje (`ro.ts`) sau în date de demo, **niciodată în componente**; componentele din `@ecom/ui` primesc etichetele prin props |
| «Alege fonturi neobișnuite» | fonturile se servesc de pe domeniul magazinului (`19` §1) și sunt din lista permisă | alegere doar din `FONT_FAMILIES`; perechi diferite pe preset, nu fonturi noi fără aprobare |
| «Evită accentul pe un singur cuvânt din titlu» | brief-ul utilizatorului (3.2) cere tocmai **o expresie în accent** în hero | brief-ul câștigă; expresia e **o frază, într-un singur loc (hero)**, configurabilă, nu un obicei pe toate titlurile |
| «Evită majusculele, numerotarea 01/02/03, săgeți → pe butoane» | – | respectate: nu apar în componente |
| «Același card / aceeași umbră peste tot = tell» | cardurile mari rotunjite sunt chiar în brief | raze pe trepte, fără umbră pe carduri, doar pe straturi plutitoare |
| «Mișcare rară și orchestrată» | accesibilitate și performanță | fără animații la intrare; tranziții scurte ca răspuns la acțiuni; `prefers-reduced-motion` respectat |
| «Cream + serif + teracotă = reflex generat» | presetul Editorial era chiar acesta | schimbat (2.5, punctul 2) |
| «Spune de ce ai schimbat planul» | – | §2.5 |

Reguli ale utilizatorului, aplicate: (a) identitatea vizuală stă în valorile celor 3 presets, nu în componente; (b) textul de umplutură în mesaje sau date de demo; (c) conversia, accesibilitatea și performanța au prioritate peste «riscul estetic»; (d) direcția «echilibrat» ca principiu al presetului implicit.

## 5. Cerințe SEO din `19` §1: ce intră în Faza 6 și ce nu

| Cerință | Faza | Cum |
|---|---|---|
| meniu cu `<a href>`, în HTML-ul de pe server | **6** | mega menu și drawer cu linkuri reale, în HTML și fără JS; test |
| un singur `h1` pe pagină | **6** | header, footer și meniu nu conțin `h1`; fiecare pagină are unul; test |
| 404 real (status 404, `noindex`) | **6** | `not-found` al vitrinei; test |
| linkuri legale în footer (termeni, confidențialitate, retur, ANPC/SAL, cookie-uri) | **6** | footer configurabil; test |
| consimțământ implicit «refuzat» | **6** | modul de consimțământ cu valoare implicită «refuzat»; butoane de greutate egală; test |
| imaginea LCP cu prioritate | **6** | componentele de imagine (hero, card) primesc `priority`; test |
| fonturi de pe domeniul magazinului | **6** | `next/font` (existent) |
| HTML complet pentru produs/categorie, canonical, 301, filtre `noindex`, paginare, JSON-LD de produs, sitemap cu imagini, slug-uri | **7** (și 16/17 pentru redirecturi, sitemap, `llms.txt`) | aparțin paginilor de catalog |
| texte unice, nume de brand consistent, pagini obligatorii (conținut) | **16** (CMS) și înainte de lansare | conținut |
| feed Merchant: preț = preț pe pagină, plafon | **17** | generatorul de feed |
