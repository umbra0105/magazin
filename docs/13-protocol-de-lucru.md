# 13 — Protocol de lucru cu Claude Code

Scopul acestui fișier: **să știi în orice moment unde ești, la ce se lucrează, ce e gata și ce trebuie să verifici tu.** Fără surprize, fără „am făcut niște lucruri".

Pune conținutul din §2 în `CLAUDE.md` — altfel Claude Code nu-l va respecta.

---

## 1. Statusuri în `06-todo-master.md`

Un singur simbol, patru stări:

```
[ ]  neînceput
[~]  ÎN LUCRU ACUM
[x]  gata și verificat
[!]  BLOCAT — am nevoie de o decizie de la tine
```

**Regulă: poate exista un singur `[~]` în tot fișierul.** Dacă vezi două, înseamnă că s-a sărit peste ceva.

---

## 2. Cele patru anunțuri obligatorii (de pus în `CLAUDE.md`)

```markdown
## Protocol de raportare — OBLIGATORIU

Nu începe și nu termina nicio bucată de lucru în tăcere. Folosește exact
aceste patru formate, în limba română:

### 🟢 ÎNCEP
Înainte de a scrie prima linie de cod pentru un punct din TODO:

    🟢 ÎNCEP — Faza 4 · punctul 3 din 14
    „CRUD categorii cu arbore drag & drop"

    Ce voi face:
    - schema Prisma pentru Category cu path și depth
    - server actions de creare/editare/ștergere/reordonare
    - pagina /admin/categorii cu arbore drag & drop

    Fișiere pe care le voi atinge: packages/db/schema.prisma,
    packages/core/catalog/categories.ts, apps/web/src/app/(admin)/admin/categorii/

    Estimare: ~45 de minute
    Depinde de: punctul 1 (schema produs) — ✅ gata

Apoi marchează punctul cu [~] în docs/06-todo-master.md.

### ✅ GATA
După fiecare punct terminat:

    ✅ GATA — Faza 4 · punctul 3 din 14

    Ce am făcut:
    - arbore de categorii cu adâncime nelimitată
    - reordonare prin drag & drop, salvată automat
    - ștergere blocată dacă are subcategorii sau produse

    Teste: 11 trec (categories.test.ts)
    Typecheck: ✅   Lint: ✅

    👉 VERIFICĂ TU:
    1. Deschide http://localhost:3000/admin/categorii
    2. Creează 2 categorii și una copil
    3. Trage o categorie în altă poziție, dă refresh — ordinea trebuie păstrată
    4. Încearcă să ștergi o categorie cu copii — trebuie să te oprească

    Commit: feat(catalog): arbore de categorii cu reordonare drag & drop

    Următorul punct: 4 din 14 — „CRUD branduri"
    Continui? (da / stai să verific / modifică ceva)

Apoi marchează [x] în TODO.

### 🏁 FAZĂ TERMINATĂ
La finalul unei faze întregi:

    🏁 FAZA 4 TERMINATĂ — Catalog: model și admin
    14 din 14 puncte ✅ · 3 zile · 47 de teste

    Ce funcționează acum:
    [listă scurtă, în limbaj de om, nu de programator]

    Ce am amânat conștient și de ce:
    [dacă e cazul]

    Datorie tehnică acumulată:
    [dacă e cazul]

    👉 VERIFICĂ TU, CAP-COADĂ:
    [3-5 pași concreți prin care testezi manual toată faza]

    Am actualizat docs/06-todo-master.md și docs/PROGRESS.md.
    Următoarea fază: 5 — Stoc. Pornește o SESIUNE NOUĂ și rulează Promptul 7.

### 🛑 STOP
Când ai nevoie de o decizie sau ceva e blocat:

    🛑 STOP — Faza 4 · punctul 7

    Problema: [descriere în limbaj simplu, fără jargon inutil]

    Opțiunile mele:
    A) [opțiune] — avantaj / dezavantaj
    B) [opțiune] — avantaj / dezavantaj

    Recomandarea mea: A, pentru că [motiv]

    Nu merg mai departe până nu îmi spui.

Apoi marchează [!] în TODO și OPREȘTE-TE. Nu ghici.
```

---

## 3. Ritualul de început de sesiune

Copiază asta la fiecare sesiune nouă, schimbând doar numărul fazei:

```
Citește, în ordine:
1. CLAUDE.md
2. docs/PROGRESS.md — ca să știi unde am rămas
3. docs/06-todo-master.md — starea curentă a bifelor
4. docs/10-decizii-deschise.md — deciziile luate

Apoi:
- Spune-mi într-un paragraf unde suntem și ce urmează.
- Verifică dacă a rămas ceva marcat [~] sau [!] din sesiunea trecută.
- Execută Promptul #N din docs/07-prompturi-claude-code.md.
- Fă ÎNTÂI planul, cu lista de puncte numerotate, și așteaptă „ok" de la mine
  înainte să scrii cod.
- Respectă protocolul de raportare din CLAUDE.md.
```

---

## 4. `docs/PROGRESS.md` — memoria dintre sesiuni

Claude Code îl actualizează la finalul fiecărei sesiuni. Format fix:

```markdown
# Jurnal de progres

## 2026-09-14 · Sesiunea 7 · Faza 4 (Catalog)
**Terminat:** punctele 1-9 din 14
**În lucru:** —
**Blocat:** —

**Ce funcționează acum:**
- Produse simple și cu variante, cu media și atribute
- Categorii ierarhice cu drag & drop
- Import CSV cu dry-run

**Decizii luate în sesiune:**
- Slug-urile se generează cu `slugify` + sufix numeric la coliziune
- Am folosit `dnd-kit` pentru drag & drop (mai mic decât react-beautiful-dnd)

**Datorie tehnică:**
- Import CSV nu suportă încă imagini prin URL — punctul 10

**De unde reiau:** punctul 10 din Faza 4 — import imagini prin URL
**Comandă de pornire:** `docker compose -f docker/docker-compose.dev.yml up -d && pnpm dev`
```

---

## 5. Definiția de „gata" (un punct nu e bifat până nu bifezi toate)

```
[ ] typecheck trece
[ ] lint trece
[ ] testele trec, inclusiv cele noi
[ ] funcționează manual în browser, verificat de MINE (utilizatorul)
[ ] are audit log, dacă e o acțiune din admin
[ ] respectă regulile din CLAUDE.md (bani ca int, fără culori hardcodate, etc.)
[ ] commit făcut, cu mesaj descriptiv
[ ] bifat în docs/06-todo-master.md
```

---

## 6. Punctele unde TU trebuie să verifici manual

Nu bifa nimic la încredere. La aceste momente, deschide browserul:

| Fază | Ce testezi cu mâna ta |
|---|---|
| 2 | Te loghezi în /admin, îți schimbi parola, ieși, reintri |
| 4 | Creezi un produs cu 2 variante și 3 imagini, îl vezi în listă |
| 5 | Modifici stocul, vezi mișcarea în istoric |
| 7 | Găsești produsul pe site, filtrezi, deschizi pagina lui |
| 8 | Adaugi în coș, schimbi cantitatea, aplici un cupon |
| 9 | **Plasezi o comandă completă cu ramburs**, primești confirmarea |
| 10 | **Plasezi o comandă cu card în sandbox**, verifici că statusul se schimbă |
| 11 | Procesezi comanda din admin, primești emailurile |
| 12 | Generezi un AWB, descarci eticheta |
| 13 | Emiți o factură, o descarci în PDF |
| 14b | Cumperi un tutorial, îl vizionezi din cont |
| 18 | **Instalezi de la zero pe o bază de date goală** |

Fazele 9, 10 și 18 sunt cele unde apar cele mai multe surprize. Nu le grăbi.

---

## 7. Commit-uri

Un commit per punct terminat. Format:
```
feat(catalog): arbore de categorii cu reordonare
fix(checkout): calcul greșit al TVA la cantități multiple
test(pricing): acoperire pentru discountul de grup
chore(deps): actualizare Prisma la 6.2
docs(progress): sesiunea 7
```
Prefixe: `feat` `fix` `test` `refactor` `chore` `docs` `perf`

**Nu accepta un commit uriaș la finalul zilei.** Dacă ceva se strică, vrei să poți da înapoi un punct, nu o zi întreagă.

---

## 8. Când ceva merge prost

**Dă-i eroarea completă, nu „nu merge".**
```
Am rulat X. Am primit eroarea asta:
[textul complet, inclusiv stack trace]
Am încercat deja: [ce ai încercat]
```

**Când ceva a funcționat și acum nu mai funcționează:**
```
Ultimul commit la care mergea: [hash]
Ce s-a schimbat de atunci: [git log --oneline]
Analizează diferența și spune-mi ce a stricat-o, înainte să repari.
```

**Când răspunsul e prea complicat:**
```
Explică-mi asta ca și cum n-aș fi programator. Ce face, de ce e nevoie de el,
și ce se strică dacă îl scot.
```

---

## 9. Reguli pentru tine

1. **O fază pe sesiune.** Sesiunile lungi produc cod mai slab. Când termini o fază, deschide o conversație nouă.
2. **Verifică înainte să bifezi.** Testele care trec nu înseamnă că funcționează.
3. **Nu accepta cod pe care nu-l înțelegi.** Cere explicații. Tu ești responsabil de proiect, nu Claude Code.
4. **Nu sări peste faze.** Ordinea din TODO nu e decorativă.
5. **Fă backup la baza de date locală** înainte de fazele care schimbă masiv schema.
6. **Când te grăbești, nu sări testele la prețuri, stoc și checkout.** Acolo se pierd bani reali.
7. **Cere manualul de admin pe parcurs**, la finalul fiecărei faze — nu la sfârșit. E de zece ori mai ieftin.

---

## 10. Comenzi rapide utile în sesiune

```
"unde suntem?"          → rezumat de stare din PROGRESS.md și TODO
"arată-mi planul"       → lista de puncte pentru faza curentă, fără cod
"explică simplu"        → reformulare fără jargon
"fă commit"             → commit cu mesaj descriptiv
"actualizează progresul"→ scrie în TODO și PROGRESS.md
"ce a mai rămas?"       → punctele rămase în faza curentă
"pauză"                 → salvează starea în PROGRESS.md ca să pot închide
```
