# 15 — Funcționalități cerute de nișă (configurate pentru piscine)

> ⚠️ **Principiu, după observația ta corectă**: pachetul e white-label și va rula și pe alte nișe.
> Deci **nimic din acest fișier nu se scrie ca „funcționalitate pentru piscine"**. Tot ce urmează se construiește ca **funcționalitate generică în spatele unui feature flag**, pe care o configurezi pentru magazinul tău.
> Un magazin de mobilă va folosi aceleași clase de transport și același buton „cere ofertă instalare". Un magazin de biciclete va folosi aceeași fișă explodată.
>
> Ce e prea specific pentru core — cum e selectorul „ce pompă îmi trebuie" — **se face ca extensie** în `/extensions`. Exact pentru asta există sistemul din fișierul 08.

---

## 1. Transport pentru produse grele și voluminoase

### ✅ Simplificare: prețul vine din API-ul curierului, nu din tabele

Observația ta e corectă și taie mult din plan. O pompă de 60 kg, 120×50×60 cm înseamnă **72 kg volumetric** ((120×50×60)/5000). Dacă Sameday cere ~280-310 lei și transportul paletizat cere la fel, **nu ai nevoie de o metodă de livrare separată**.

**Deci: ceri prețul în timp real de la API-ul agregatorului**, trimițând greutatea reală și dimensiunile. Curierul calculează, tu afișezi. Zero tabele de tarife de întreținut, zero discrepanțe între ce afișezi și ce plătești.

**De la patru clase de transport rămân două:**

| Clasă | Ce înseamnă |
|---|---|
| `standard` | Merge la easybox și la curier normal |
| `oversized` | **Doar la adresă** — easybox-ul se ascunde automat. Prețul vine tot din API |

Bifa `oversized` rămâne necesară indiferent de preț: o pompă de 60 kg nu încape într-un locker, oricât de ieftin ar fi transportul.

### ⚠️ Două lucruri de verificat înainte să renunți complet la varianta „cere ofertă"

**1. Limita maximă a agregatorului.** Curierii din România au o limită pentru serviciul standard — frecvent în jur de 30-50 kg per colet și ~150 cm pe latura cea mai lungă. Peste asta, unii rutează automat către un serviciu de marfă și îți dau preț, alții returnează eroare.

👉 **Întreabă agregatorul, exact așa**: *„Ce se întâmplă dacă cer un tarif pentru 90 kg, 160×80×80 cm? Primesc preț sau eroare?"*
- Primești preț → perfect, rămâi cu două clase și ai terminat.
- Primești eroare → ai nevoie de o singură ramură de rezervă: când API-ul refuză, produsul afișează „transport calculat individual", comanda se plasează fără cost de transport, iar tu îl adaugi manual din admin și trimiți link de plată. Cost ~1 zi, și o construiești **doar dacă e nevoie**.

**2. Pragul de transport gratuit.** Dacă ai „livrare gratuită peste 500 lei" și cineva cumpără o pompă de căldură de 8.000 de lei, plătești 300 de lei din marjă.
*Recomandare: pragul de transport gratuit **dezactivabil per clasă de transport și per produs**. Pentru `oversized`, implicit dezactivat.* Costă ~2 ore și acoperă o gaură reală în profit.

### Ce rămâne de făcut
- `weight` și `dimensions` obligatorii pe variantă
- Calcul de greutate volumetrică, pentru estimare și validare
- Bifa `oversized` → ascunde easybox
- Tarife cerute în timp real de la API, cu cache scurt și **fallback pe o taxă fixă dacă API-ul e picat** (nu bloca niciodată checkout-ul)
- Prag de transport gratuit dezactivabil per clasă
- Mesaj explicit: livrarea se face la adresă, la nivelul solului; descărcarea și manipularea sunt în sarcina clientului

**Economie față de planul anterior: ~2 zile.**

---

## 2. Etichetare energetică și documente de produs

### ✅ Varianta ta: bifă + încărcare manuală

Ai dreptate că nu se poate automatiza — datele vin de la producători, în formate diferite. Dar în loc de câmpuri fixe pentru etichetă energetică, recomand ceva **generic și mai util**:

**Un tab „Documente" pe fiecare produs**, cu încărcare de fișiere, fiecare având un tip:

```
ProductDocument
  productId
  type      'energy_label' | 'product_sheet' | 'manual' | 'ce_declaration'
            | 'datasheet' | 'warranty' | 'other'
  title     "Etichetă energetică" / "Manual de utilizare"
  fileUrl
  language  'ro' | 'en'
  position
  showInTab bool     apare în tabul de descărcări de pe pagina de produs
```

Plus câmpurile specifice pentru afișarea vizuală a clasei energetice:
```
Product
  + energyClass    'A+++' ... 'G' | null
  + eprelUrl       link către înregistrarea EPREL, dacă există
```

**De ce așa și nu doar câmpuri fixe**: un magazin de electrocasnice va vrea manual + etichetă + fișă. Un magazin de scule va vrea declarație CE + certificat. Un magazin de cosmetice nu va vrea niciunul. Cu tabul de documente, toate cazurile funcționează fără cod nou. Costul e același.

**Pe frontend:**
- Dacă `energyClass` are valoare → se afișează săgeata colorată pe card, pe pagina de produs și în coș, **înainte de finalizarea comenzii**
- Tab „Descărcări" cu toate documentele marcate `showInTab`
- Link către EPREL, dacă e completat

⚠️ Verifică cu un consultant exact ce categorii din portofoliul tău intră sub obligația de etichetare energetică și ce cere reglementarea curentă. Amenzile ANPC pentru etichetare sunt reale. Tot aici: **GPSR** (date producător / persoană responsabilă UE), marcaj CE, instrucțiuni în română.

---

## 3. Atribute și filtre tehnice

La echipamente tehnice, filtrele sunt principalul mod de navigare, nu un moft.

| Categorie | Atribute filtrabile |
|---|---|
| Pompe de apă | debit (m³/h), putere (kW), înălțime de refulare (m), diametru racord, mono/trifazic |
| Filtre | tip (nisip/cartuș/diatomit), debit, diametru vas, tip vană |
| Pompe de căldură | putere termică (kW), COP, volum piscină recomandat (m³), agent frigorific |
| Dezumidificatoare | capacitate (l/24h), suprafață acoperită (m²), debit de aer |

**Ce trebuie (toate generice):**
- Atribute cu **tip numeric** și **unitate de măsură**, filtrabile pe interval (slider), nu doar pe valoare exactă
- **Tabel de specificații structurat** pe pagina de produs, generat din atribute — nu text liber
- Atributele se definesc per categorie, ca să nu ai 200 de atribute irelevante peste tot

---

## 4. Cerere de ofertă pentru instalare — varianta simplă

Ai simplificat corect. **Nu e un produs, nu are preț, nu are programare, nu intră în comandă.** E doar un semnal că acel client vrea să fie sunat.

**Renunțăm complet la tipul de produs `service`.** Economie: ~3 zile.

```
Product
  + requiresInstallation   bool     bifă în fișa produsului din admin

Order
  + installationRequested  bool
  + installationNote       text?    observații de la client
  + installationStatus     'requested' | 'contacted' | 'scheduled' | 'done' | 'declined'
```

**Pe pagina produsului**: dacă bifa e activă, apare o mențiune vizibilă —
> „Acest produs necesită instalare de specialitate. Poți cere o ofertă la finalizarea comenzii."

**În checkout**: dacă în coș există cel puțin un produs cu bifa, apare o secțiune:
> ☐ **Doresc ofertă pentru instalare**
> Vă contactăm telefonic după plasarea comenzii, cu o ofertă personalizată.
> Instalarea se facturează separat și nu este inclusă în această comandă.
> *[câmp opțional: observații — tip de piscină, locație, acces]*

Nebifată implicit. Nu blochează nimic. Nu modifică totalul comenzii.

**În admin:**
- Badge pe comandă și filtru în listă: „cereri de instalare"
- Notificare pe email către echipă la plasarea unei astfel de comenzi
- Status de urmărire, ca să nu se piardă cererile
- Raport: câte cereri, câte convertite

**Cost: ~0,5 zile** în loc de 3.

> 💡 Generic, în spatele flag-ului `installationRequests`. Un magazin de mobilă, de aer condiționat sau de electrocasnice încorporabile îl folosește identic.

---

## 5. Piese de schimb și fișa explodată

### 5.1 Codurile de producător — o capcană tehnică

```
ProductVariant
  + manufacturerPartNumber
  + manufacturerName
```

⚠️ **Căutarea full-text din Postgres rupe codurile de piese.** Un cod ca `SP-1400-X2` e tokenizat în bucăți și căutarea nu îl găsește.

**Soluția**: căutare pe două căi — potrivire exactă și `ILIKE` cu index trigram pe `manufacturerPartNumber` și `sku`, **înaintea** căutării normale în text. Dacă se potrivește un cod, rezultatul acela urcă primul.

E o jumătate de zi care face diferența între „instalatorul găsește piesa în 5 secunde" și „instalatorul te sună".

### 5.2 Fișa explodată

```
PartsDiagram              entitate proprie, reutilizabilă
  title                   "Pompă seria XYZ — vedere explodată"
  imageUrl                imaginea de la producător
  productIds[]            se poate atașa la mai multe produse din aceeași familie

PartsDiagramHotspot
  diagramId
  number                  numărul de pe desen: 1, 2, 3...
  x, y                    poziția în procente, ca să fie responsive
  productId               produsul din catalog
  label                   opțional, dacă vrei alt nume decât cel al produsului
```

**Două variante de implementat — alege:**

| | Ce vede clientul | Efort |
|---|---|---|
| **A. Simplă** | Imaginea + un tabel numerotat alături (nr., denumire, cod, preț, „adaugă în coș"). Numerele din tabel corespund celor tipărite pe desenul producătorului | **~1 zi** |
| **B. Cu hotspot-uri** | Ca A, plus puncte marcate pe imagine. Click pe punct → evidențiază rândul sau duce la produs. În admin, plasezi punctele dând click pe imagine | **~2,5 zile** |

### ✅ DECIS: varianta A, cu structura pregătită pentru B

Construim imaginea + tabelul numerotat (~1 zi). **Dar tabela `PartsDiagramHotspot` se creează de la început**, chiar dacă nu o folosim încă. Când vrei hotspot-uri, adaugi doar editorul din admin și marcajele pe imagine — fără migrație de date, fără rescriere. Diferența: ~1,5 zile atunci, în loc de 2,5 acum.

**Detaliu care contează**: fă `PartsDiagram` o entitate proprie, atașabilă la mai multe produse. O familie de pompe are aceeași fișă explodată pentru 6 modele. Altfel o încarci de 6 ori.

**Pe frontend**: tab „Piese de schimb" pe pagina produsului, cu imaginea și tabelul. Fiecare rând duce la produsul respectiv, cu buton de adăugare directă în coș.

> 💡 Generic, în spatele flag-ului `partsDiagrams`. Biciclete, scule, electrocasnice, utilaje — toate îl folosesc.

---

## 6. Sezonalitate

Vânzările vor fi concentrate în martie-august, cu vârf în mai-iunie.

- **Stocul** se pregătește din februarie. Rapoartele de rotație și alertele de stoc mic contează mai mult decât la un magazin obișnuit
- **Produse „la comandă"** în extrasezon: bifa `manageStock = false` cu status „la comandă" și termen de livrare afișat e exact ce îți trebuie
- **Precomandă** devine relevantă în februarie-martie — infrastructura e deja pregătită
- Campanii de deschidere și de închidere de sezon
- Traficul crește de 5-10× în vârf → **testul de încărcare din Faza 20 nu e opțional**

---

## 7. Clienții „Partener" se potrivesc perfect

Piscinierii, constructorii și firmele de service cumpără repetat. Grupurile „Partener 1/2/3" (prețul de achiziție + adaos, plafonat la prețul public) sunt exact instrumentul potrivit, fără B2B complicat.

Ieftin și util în plus:
- **Comandă repetată** din istoric („comandă din nou") — ~0,5 zile
- Facturare pe firmă la checkout — deja în plan
- Descărcarea documentelor de produs — deja acoperită de tabul „Documente"

---

## 8. Conținut care vinde în nișa asta

Ghiduri („Cum alegi pompa de filtrare", „Iernarea piscinei pas cu pas") · calculatoare · manuale și fișe tehnice pe fiecare produs · video de instalare — **care se leagă direct de tutorialele tale digitale**. Poți vinde un curs de întreținere piscină ca produs digital, exact ce ai planificat.

Asta justifică blogul: în nișa asta conținutul tehnic aduce trafic organic constant și de calitate.

---

## 9. Recapitulare cost, după simplificări

| Adăugare | Fază | Cost |
|---|---|---|
| Clase de transport + greutate volumetrică + tarife din API | 4 + 9 | +1 zi |
| Blocare easybox pentru `oversized` + prag gratuit per clasă | 9 + 12 | +0,5 zile |
| Tab „Documente" pe produs + afișare clasă energetică | 4 + 7 | +1,5 zile |
| Atribute numerice cu unități + filtre pe interval | 7 | +1 zi |
| Cerere de ofertă instalare | 4 + 9 + 11 | +0,5 zile |
| Căutare pe cod de piesă (trigram + potrivire exactă) | 7 | +0,5 zile |
| Fișă explodată, varianta A | 4 + 7 | +1 zi |
| Fișă explodată, varianta B (hotspot-uri, ulterior) | Val 2 | +1,5 zile |
| Comandă repetată din istoric | 14 | +0,5 zile |

**Total: ~6,5 zile.**

Față de versiunea anterioară a acestui fișier (~10,5 zile), simplificările tale au tăiat **~4 zile**.

### Amânate, ca extensii sau Val 2
- **Selector de produs** („ce pompă îmi trebuie") → prea specific pentru core. Se face ca **extensie** în `/extensions`, când vrei. Rămâne cea mai bună investiție pentru conversie în nișa ta, dar nu în pachetul de bază.
- **Comparare de produse** → Val 2, ~2 zile.
