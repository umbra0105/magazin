# Finisaje și probleme deschise (mod autonom)

Lista acumulată în timpul unei faze autonome (`docs/20-mod-autonom.md` §2 și §8): **S3** (aspect, text, aliniere, finisaje) se notează aici, într-o linie, iar lucrul continuă. Se rezolvă într-o trecere separată, la final de fază sau înainte de lansare. **S1** și **S2** nu se notează aici ca să fie amânate: S1 oprește lucrul (🛑), S2 se repară pe loc; o intrare S1 sau S2 deschisă aici blochează poarta de îmbinare.

## Format

O intrare e o linie care începe cu căsuța de stare, apoi severitatea ca prim cuvânt, apoi câmpurile separate prin `|`:

```
- [ ] S3 | ecran | ce nu e în regulă | captură (cale sau nume)
- [x] S3 | ecran | ce a fost în regulă după repară | captură
```

- `[ ]` = deschisă, `[x]` = rezolvată. Orice altă căsuță (`[~]`, `[!]`) se socotește deschisă.
- Severitatea e `S1`, `S2` sau `S3`. O intrare deschisă fără severitate recunoscută se socotește **S2** (la îndoială, nivelul mai grav).
- Poarta de îmbinare (`npm.cmd run gate:merge`) se oprește la orice intrare **S1 sau S2 deschisă**; S3 deschise nu o opresc.
- Exemplele din blocurile de cod (ca cele de mai sus) nu se numără.

## Deschise

- [ ] S3 | Import WooCommerce, imagini din descrieri (15d) | cât o imagine din descriere e în așteptare sau a eșuat, în editorul de descriere se vede marcajul `{{img:…}}` ca text (cumpărătorii nu îl văd: se scoate la randare); de decis dacă editorul îl arată ca un chip «imagine în așteptare» | -
- [ ] S3 | Import WooCommerce, istoric (15d) | nu există buton de renunțare pentru o imagine de descriere eșuată: marcajul rămâne până la reluare («Reia imaginile») sau până îl șterge editorul de mână | -

- [ ] S3 | Editor Aspect (Faza 6) | logo, favicon și imaginea de partajare se introduc doar ca adresă (https:// sau /cale), nu se aleg din biblioteca media; selectorul de media dă astăzi adrese `http://` în dezvoltare, respinse de schema temei | -
- [ ] S3 | Editor Aspect (Faza 6) | previzualizarea e lungă (hero, carduri, footer), nu rămâne fixată pe ecran cât editezi culorile de jos și nu arată o fotografie în hero | local-data/capturi-faza6/editor/editor-aspect.png
- [ ] S3 | Editor Aspect și Mentenanță (Faza 6) | selecturile sunt cele native ale browserului (datorie cunoscută din CLAUDE.md, tratată înainte de lansare) | -
- [ ] S3 | Footer (Faza 6) | textul «Realizat cu …» (`showPoweredBy`) nu e implementat; paginile legale din footer dau 404 până în Faza 16 | -
- [ ] S3 | Mentenanță (Faza 6) | în timpul mentenanței nici administratorii nu pot vedea vitrina (nu există ocolire); adminul rămâne accesibil | -
- [ ] S3 | Consimțământ cookie (Faza 6) | categoriile Statistici și Marketing sunt structură: încă nu există funcții care să depindă de ele (se leagă când apar, în fazele lor) | -
- [ ] S3 | Galeria de design (Faza 6) | fără fișiere în `local-data/foto-hero/` (nu se comit), galeria folosește ca hero cea mai bună imagine de produs din baza de dezvoltare (doar în galerie, nu în producție); aspectul final al hero-ului și al header-ului «sticlă» se judecă cu o fotografie reală a magazinului, nu cu o fotografie de produs | local-data/capturi-faza6/final/minimal-deschisa-sticla-1440.png

## Rezolvate

- [x] S3 | Mega meniu, plăci de categorie (Faza 6) | plăcile aveau cadre diferite (una cu fundal rotunjit, alta fără; imaginile tăiate cu `object-cover`) și stăteau în rânduri improvizate; acum toate au același cadru 4:3 pe «masa foto» din token, imaginea întreagă (`object-contain`) cu umplutură, într-o grilă cu 3 coloane fixe, iar categoriile text stau sub o linie fină pe aceleași coloane (test E2E pe dimensiuni, culoare, umplutură, încadrare și coloane, în 3 presets × 2 teme) | local-data/capturi-faza6/final/minimal-deschisa-meniu-1440.png
- [x] S3 | Carduri de produs, zona de imagine (Faza 6) | zona de imagine avea culoarea paginii, deci fotografiile cu fundal alb apăreau ca pătrate albe pe un card colorat; acum o suprafață unică din token (`--sf-media-surface`, gri deschis, L 0,94, aceeași în toate presets și în ambele teme), imaginile amestecate prin `multiply` (albul fotografiei devine culoarea mesei, fără dreptunghi alb), același raport, aceeași umplutură și încadrare întreagă (test unitar pe markup și E2E pe culoare identică în 6 combinații și pe `multiply`) | local-data/capturi-faza6/final/minimal-deschisa-1440.png
- [x] S3 | Header «sticlă» (Faza 6) | peste un hero închis ieșea un gri murdar; acum umplutura, estomparea, saturația și marginea sunt tokeni (`--sf-glass-*`: culoarea paginii la 90%, estompare 1 rem cu saturație 1,8, margine fină), cu contrast AA verificat în test pe cea mai proastă fotografie (negru în tema deschisă, alb în cea închisă) și cu umplutură opacă unde nu există `backdrop-filter` | local-data/capturi-faza6/final/minimal-deschisa-sticla-1440.png

- [x] S3 | Meniul de pe telefon (Faza 6) | în captura de la punctul de control apărea o fâșie întunecată jos-dreapta: panoul avea lățimea maximă 24 rem, iar pagina de sub el rămânea derulabilă; acum acoperă tot ecranul sub 40 rem și pagina e blocată cât panoul e deschis (test E2E) | local-data/capturi-faza6/checkpoint/minimal-panou-390.png
- [x] S3 | Preset Bold (Faza 6) | degradeul cărămiziu spre turcoaz din hero și carduri (reflexul «teracotă») scos; fundal rece, accent portocaliu păstrat (test pe valorile presetului și E2E fără degrade) | local-data/capturi-faza6/scene/bold-deschisa-1440.png
- [x] S3 | 404 public (Faza 6) | pagina 404 stă acum în cadrul vitrinei (header, footer, un singur H1), nu pe suprafața adminului; paginile de autentificare rămân pe suprafața adminului | local-data/capturi-faza6/scene/404-1440.png
- [x] S3 | Faza redesign-finisaje | pluralul din raportul Woo și din mesaje, breadcrumb-ul 404, inelul de focus al alertelor de autentificare, stepperul și selecturile importului pe telefon, istoricul exporturilor paginat, eticheta «Rând» pe cardurile de telefon, ținta tactilă a legăturii «Detalii» | local-data/capturi-redesign/finisaje-dupa
- [x] S3 | Fișe explodate, lista pe telefon | numărătorile «N hotspot-uri» și «N produse» din card sunt în culoarea textului principal; în `docs/17` valorile de context sunt `text-ink-secondary` | local-data/capturi-redesign/lot3b2-dupa/fise-lista-light-390.png
- [x] S3 | Import, raportul de verificare | coloana SKU e îngustă și un cod scurt se rupe în mijloc («E2E-218C25-BA / D»); coloana Motiv ia aproape tot locul | local-data/capturi-redesign/lot3b2-dupa/import-3-verificare-dark-1440.png
- [x] S3 | Autentificare și 404 public | paginile publice stau pe suprafața adminului (tokeni, tema sistemului) până când vitrina (Faza 7) își face propria suprafață; decizie notată în `docs/17` §8, punctul 1e, nu un defect | local-data/capturi-redesign/lot4-dupa/404-public-light-1440.png
