# 16 — Ghid de execuție: ce ceri, când, și cum nu deraiezi

Acesta e fișierul pe care îl ții deschis în timp ce lucrezi. Fișierul 13 spune *cum* raportează Claude Code. Ăsta spune *ce îi ceri și în ce ordine*.

---

## 1. Anatomia unei sesiuni

O sesiune = o conversație nouă în Claude Code = **2-4 ore de lucru**. Nu mai mult. Când conversația devine lungă, calitatea codului scade vizibil.

```
┌─ 1. DESCHIZI o conversație NOUĂ
│
├─ 2. LIPEȘTI textul de start (§4). Întotdeauna același, schimbi doar promptul.
│
├─ 3. CLAUDE CODE citește documentația și îți spune unde suntem.
│     👉 Tu verifici că a înțeles corect. Dacă nu, corectezi ACUM, nu după 2 ore.
│
├─ 4. CLAUDE CODE îți dă PLANUL, cu puncte numerotate.
│     👉 Tu îl citești. Dacă e prea mare, ceri să-l taie. Apoi spui „ok, începe".
│
├─ 5. LUCRU, punct cu punct:
│     🟢 ÎNCEP → cod → ✅ GATA → tu verifici în browser → următorul punct
│
├─ 6. Când simți că răspunsurile devin lente sau confuze → OPREȘTE.
│     „Actualizează progresul și pregătește-mă pentru sesiunea următoare."
│
└─ 7. Închizi conversația. Sesiunea următoare pornește curat.
```

**Regula cea mai importantă din tot documentul**: nu continua într-o conversație care a devenit lungă. Deschide una nouă. `PROGRESS.md` e memoria, nu conversația.

---

## 2. Harta sesiunilor

Fiecare fază are mai multe sesiuni. Estimările sunt orientative — unele vor merge mai repede, altele mai greu.

| Faza | Sesiuni | Prompt | Ce ai la final |
|---|---|---|---|
| **1** Fundație | 2-3 | 1 | `pnpm dev` pornește, Docker ridică Postgres/Redis/MinIO/Mailpit, CI verde |
| **2** Setări și branding | 2-3 | 2 | Setările se citesc din bază, cheile se criptează, feature flags funcționează |
| **2** Autentificare | 2 | 3 | Te loghezi în `/admin`, roluri funcționale |
| **3** Media | 2 | 4 | Încarci o imagine, se procesează, o vezi în bibliotecă |
| **4** Catalog | 5-6 | 5 | Creezi un produs cu variante, imagini, atribute, documente |
| **4** Import | 2 | 6 | **Imporți produsele din site-ul vechi** prin CSV |
| **5** Stoc | 2 | 7 | Bifa de gestiune stoc funcționează în ambele moduri |
| **6** Design system | 3 | 8 | Header, footer, temă din admin, culori care se schimbă |
| **7** Storefront | 4-5 | 9 | Vezi produsele pe site, filtrezi, deschizi o pagină de produs |
| **8** Prețuri și coș | 3-4 | 10 | Adaugi în coș, prețul e corect în toate cazurile |
| **9** Checkout | 4-5 | 11 | ✅ **Plasezi prima comandă reală, cu ramburs** |
| **10** Plăți | 3-4 | 12 | ✅ **Plătești cu card în sandbox, statusul se schimbă** |
| **11** Admin comenzi | 3 | 13 | Procesezi o comandă din admin, cap-coadă |
| **11** Emailuri | 2 | 14 | Primești emailurile în Mailpit |
| **12** AWB | 3 | 15 | Generezi un AWB și descarci eticheta |
| **13** Facturare | 2-3 | 16 | Emiți o factură în Oblio, o descarci în PDF |
| **14** Cont și retururi | 3 | 17 | Clientul își vede comenzile, cere retur |
| **14b** Produse digitale | 3 | 21d | Cumperi un tutorial, îl vizionezi din cont |
| **15** Grupuri de clienți | 2 | 21 | Un client Partener vede prețuri reduse |
| **15b** Loialitate | 3 | 21f | Primești puncte, le folosești, voucherele funcționează |
| **16** CMS | 3-4 | 18 | Construiești homepage-ul din blocuri, din admin |
| **17** Marketing și SEO | 3 | 19, 20 | Cupoane, recenzii, sitemap, structured data |
| **18** Instalator | 3 | 21b | ✅ **Instalezi de la zero pe o bază goală** |
| **19** Extensii și update | 2 | 21c | Scriptul de update funcționează cu rollback |
| **20** Rapoarte | 2 | 22 | Dashboard cu cifre reale |
| **21** Împachetare | 2-3 | 23 | Instalezi pe un VPS gol, cronometrat |
| **22** Testare finală | 2-3 | 24 | Suita E2E trece complet |
| **22b** eMAG | 4-5 | 21e | Oferte publicate, comenzi importate |

**Total: ~75-90 de sesiuni.** La 3-4 sesiuni pe săptămână, asta înseamnă 5-7 luni. Cu ritm mai intens, mai puțin.

Sesiunile marcate ✅ sunt **punctele de control majore**. Nu trece mai departe până nu funcționează perfect.

---

## 3. Primele trei sesiuni, în detaliu

Astea dau tonul întregului proiect. Merită să le faci încet.

### 🔹 Sesiunea 1 — Scheletul

**Ce lipești:**
```
Am un folder docs/ cu specificația completă a proiectului și un CLAUDE.md în rădăcină.

Citește CLAUDE.md, docs/README.md și docs/01-arhitectura-si-decizii.md.
Apoi execută Promptul 1 din docs/07-prompturi-claude-code.md.

Fă ÎNTÂI planul, cu puncte numerotate, și așteaptă „ok" de la mine înainte
să scrii cod. Respectă protocolul de raportare din docs/13-protocol-de-lucru.md.
```

**Ce ar trebui să vezi**: un plan de 8-12 puncte. Dacă îți dă 30, spune: *„Prea mult pentru o sesiune. Împarte-l în două și fă doar prima parte azi."*

**Când e gata**: `docker compose -f docker/docker-compose.dev.yml up -d` ridică patru servicii, `pnpm dev` pornește, `http://localhost:3000` afișează ceva, `/api/health` întoarce ok.

**Semnal de alarmă**: dacă începe să scrie componente de produs sau schema de comenzi în Sesiunea 1, oprește-l: *„Faza 1 e doar infrastructură. Fără logică de business. Revino la plan."*

### 🔹 Sesiunea 2 — Setările

**Ce lipești:** același text, dar cu **Promptul 2** și în plus `docs/10-decizii-deschise.md`.

**De ce contează cel mai mult**: aici se decide dacă pachetul e cu adevărat white-label. Dacă setările nu sunt bine făcute acum, în 3 luni vei avea numele magazinului tău scris în 40 de fișiere.

**Testul de acceptanță, la final:**
> „Schimbă numele magazinului și culoarea principală din baza de date, direct cu SQL. Dă refresh. S-au schimbat peste tot în interfață?"

Dacă răspunsul e nu, nu treci mai departe.

### 🔹 Sesiunea 3 — Autentificarea

**Promptul 3.** La final trebuie să te poți loga în `/admin` cu contul din seed, să-ți schimbi parola, să ieși și să reintri.

**Testul de acceptanță:**
> „Creează un al doilea utilizator cu rolul Suport. Loghează-te cu el. Poate șterge un produs? Trebuie să nu poată — și nu doar prin butonul ascuns, ci și dacă apelează direct server action-ul."

---

## 4. Textul de copiat la fiecare sesiune

Salvează-l undeva la îndemână. Schimbi doar numărul promptului.

```
Citește, în ordine:
1. CLAUDE.md
2. docs/PROGRESS.md — unde am rămas
3. docs/06-todo-master.md — starea bifelor
4. docs/10-decizii-deschise.md — deciziile luate
5. docs/13-protocol-de-lucru.md — cum raportezi

Apoi:
- Spune-mi într-un paragraf unde suntem și ce urmează.
- Verifică dacă a rămas ceva marcat [~] sau [!] din sesiunea trecută.
- Execută Promptul #___ din docs/07-prompturi-claude-code.md.
- Fă ÎNTÂI planul, cu puncte numerotate, și așteaptă „ok" de la mine.
- Respectă protocolul de raportare: 🟢 ÎNCEP / ✅ GATA / 🏁 FAZĂ / 🛑 STOP.
- Un singur punct [~] în lucru la un moment dat.
```

Pentru fazele cu documentație suplimentară, adaugă fișierul relevant:

| Prompt | Adaugă la lectură |
|---|---|
| 5, 6 | `docs/15-specific-nisa-piscine.md` |
| 9, 10, 11 | `docs/09-preturi-si-parteneri.md`, `docs/15-...` |
| 12, 15, 16 | `docs/05-integrari-romania.md` |
| 21, 21f | `docs/09-...`, `docs/14-loializare-si-vouchere.md` |
| 21d | `docs/11-produse-digitale.md` |
| 21b, 21c, 23 | `docs/08-instalare-si-distributie.md` |
| 21e | `docs/12-emag-marketplace.md` |

---

## 5. Semnale că deraiem — și ce spui ca să corectezi

| Ce observi | Ce înseamnă | Ce spui |
|---|---|---|
| Planul are 30 de puncte | Prea mult pentru o sesiune | *„Prea mare. Împarte-l în două și fă doar prima parte azi."* |
| Scrie cod fără să anunțe 🟢 ÎNCEP | A uitat protocolul | *„Recitește docs/13-protocol-de-lucru.md §2 și reia cu anunțul corect."* |
| Sare peste un punct din TODO | Optimizează pe cont propriu | *„Nu sări peste puncte. Revino la punctul N și fă-l."* |
| Adaugă o librărie nouă fără să întrebe | Încalcă CLAUDE.md | *„Nu instala nimic fără acordul meu. De ce e nevoie de asta? Se poate fără?"* |
| Modifică fișiere pe care nu le-ai cerut | Refactorizează necerut | *„Arată-mi `git diff`. Explică fiecare fișier modificat care nu ține de punctul curent."* |
| Zice „testele vor trece" fără să le ruleze | Presupune | *„Rulează testele acum și arată-mi rezultatul."* |
| Zice „o să repar asta mai târziu" | Datorie tehnică ascunsă | *„Nu. Ori reparăm acum, ori scriem în PROGRESS.md la datorie tehnică. Alege."* |
| Răspunsurile devin vagi sau se repetă | Contextul e plin | Oprești sesiunea. Actualizezi progresul. Conversație nouă. |
| Îți dă cod care „ar trebui să funcționeze" | N-a verificat | *„L-ai rulat? Ce ai văzut concret?"* |
| Inventează un câmp sau o funcție care nu există | Confabulează | *„Verifică în cod că există. Dacă nu, spune-mi."* |
| Rescrie ceva ce funcționa deja | Îmbunătățește necerut | *„Funcționa. De ce l-ai schimbat? Revino la versiunea anterioară dacă nu ai un motiv bun."* |

---

## 6. Zece reguli de aur

1. **O fază pe sesiune.** Când conversația se lungește, deschizi una nouă.
2. **Plan înainte de cod.** Întotdeauna. Fără excepții.
3. **Verifici în browser înainte să bifezi.** Testele care trec nu înseamnă că funcționează.
4. **Un commit per punct.** Nu accepta un commit uriaș la final de zi.
5. **Nu accepta cod pe care nu-l înțelegi.** Cere explicații simple. Tu ești responsabil.
6. **Nu sări faze.** Ordinea din TODO nu e decorativă — fiecare pas depinde de cel dinainte.
7. **`PROGRESS.md` se actualizează la final de fiecare sesiune.** E singura memorie între conversații.
8. **Backup la baza de date** înainte de fazele care schimbă masiv schema (4, 9, 15b).
9. **La prețuri, stoc și checkout nu se sar testele.** Acolo se pierd bani reali.
10. **Cere manualul de admin pe parcurs**, la finalul fiecărei faze, nu la sfârșit.

---

## 7. Când te blochezi

**Ceva nu merge:**
```
Am rulat [comanda]. Am primit:
[textul complet al erorii, inclusiv stack trace]
Am încercat deja: [ce ai încercat]
Nu ghici — investighează întâi și spune-mi ce ai găsit.
```

**Mergea și acum nu mai merge:**
```
Ultimul commit la care funcționa: [hash]
Rulează `git log --oneline` și `git diff [hash] HEAD`.
Spune-mi ce a stricat-o ÎNAINTE să repari ceva.
```

**Nu înțelegi ce a scris:**
```
Explică-mi asta ca și cum n-aș fi programator.
Ce face, de ce e nevoie de el, ce se strică dacă îl scot.
```

**Ai impresia că s-a complicat inutil:**
```
Se poate mai simplu? Arată-mi varianta minimă care rezolvă aceeași problemă.
Dacă nu se poate, explică-mi de ce.
```

**Vrei să verifici că respectă specificația:**
```
Compară ce ai implementat cu docs/[fișierul relevant].
Ce lipsește? Ce ai făcut diferit și de ce?
```

---

## 8. Rutina săptămânală (15 minute, duminică seara)

```
[ ] Citesc PROGRESS.md — unde am ajuns față de unde credeam
[ ] Verific TODO — câte puncte am bifat săptămâna asta
[ ] Deschid magazinul și fac un tur: mai merge tot ce mergea?
[ ] Rulez `pnpm test` — trec toate?
[ ] Verific lista de datorie tehnică din PROGRESS.md — crește?
[ ] Backup la baza de date locală
[ ] Planific sesiunile săptămânii următoare
```

Dacă datoria tehnică crește două săptămâni la rând, oprește-te și dedică o sesiune curățeniei. Altfel se acumulează până când fiecare funcționalitate nouă devine dureroasă.

---

## 9. Momentele în care să te oprești și să nu mergi mai departe

Sunt cinci puncte din tot proiectul unde e mai bine să pierzi două zile decât să continui pe ceva stricat:

1. **După Faza 2** — dacă setările nu controlează cu adevărat tot, oprește-te. Nu e white-label.
2. **După Faza 8** — dacă motorul de prețuri nu dă rezultate corecte în toate cazurile testate, oprește-te. Totul se sprijină pe el.
3. **După Faza 9** — dacă o comandă cu ramburs nu merge perfect cap-coadă, nu adăuga plăți online peste.
4. **După Faza 10** — dacă webhook-ul de plată nu e idempotent și verificat prin semnătură, oprește-te. Aici se pierd bani.
5. **După Faza 18** — dacă instalarea de la zero nu merge într-un singur pas, nu e un pachet, e un proiect.

---

## 10. Ce faci în paralel cu dezvoltarea

Nu sta să aștepți codul. Astea nu depind de Claude Code și îți economisesc luni:

| Când | Ce faci |
|---|---|
| Săptămâna 1 | Cele 11 întrebări pentru contabil. Deschizi conturile de test. |
| Săptămânile 1-4 | **Exporți produsele din site-ul vechi** și le pregătești în format CSV |
| Săptămânile 2-8 | Descrieri, fotografii, specificații tehnice, fișe tehnice, etichete energetice |
| Săptămânile 4-8 | Filmezi tutorialele video |
| Săptămâna 8+ | Textele legale la avocat, pornind de la template-urile generate |
| Înainte de Faza 12 | Întrebi wootPRO despre limitele de greutate |
| Înainte de Faza 21 | Cumperi VPS-ul, cu IP fix |

**Conținutul e cel mai frecvent motiv pentru care lansările se amână.** Codul poate fi gata și tot să nu poți lansa, pentru că n-ai descrieri la 500 de produse.
