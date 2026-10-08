# 08 — Instalare, distribuție și actualizări

**Acesta e fișierul care lipsea complet din planul inițial.** E ceea ce transformă un magazin online într-un *produs* pe care îl poți instala de 20 de ori.

---

## 1. Realitatea: Next.js nu e PHP

„Urc arhiva pe server și gata" funcționează la WordPress pentru că PHP e interpretat de Apache. Next.js are nevoie de: Node.js 24 LTS (Node 20 nu mai primește actualizări de securitate din 30 aprilie 2026), un proces care rulează permanent, un build, PostgreSQL, Redis, un reverse proxy și un process manager. Nu merge pe hosting partajat.

### Trei variante reale de distribuție

#### 🥇 Varianta A — Pachet Docker (recomandată)
Livrezi un folder cu: `docker-compose.yml`, `.env.example`, `install.sh`, `update.sh`, `backup.sh` + imaginile aplicației (din registry privat sau ca `.tar` exportat).

```
magazin-package-v1.4.2/
├─ docker-compose.yml
├─ .env.example
├─ install.sh
├─ update.sh
├─ backup.sh
├─ Caddyfile
├─ extensions/          ← personalizările clientului, nu se suprascriu
└─ README.md
```
Client: `./install.sh` → răspunde la 3 întrebări → deschide `https://domeniu.ro/install` → wizard.

- ✅ Reproductibil, identic peste tot, actualizare într-o comandă
- ✅ Postgres + Redis + app + Caddy cu SSL automat, într-un bloc
- ✅ Rollback la versiunea anterioară e trivial
- ❌ Necesită un VPS cu Docker (nu e o problemă reală în 2026)

#### 🥈 Varianta B — Arhivă cu build standalone
`next build` cu `output: 'standalone'` produce un folder auto-conținut. Arhivezi `.next/standalone` + `.next/static` + `public` + `prisma` + scripturi. Clientul rulează cu PM2 sau systemd.

- ✅ Fără Docker, arhivă „clasică"
- ❌ Trebuie să instalezi manual Node, Postgres, Redis, PM2, Nginx
- ❌ Diferențe între servere → suport greu

#### 🥉 Varianta C — Repo Git privat + script de deploy
Cel mai simplu pentru tine, dar clientul vede codul sursă. Bun dacă vinzi „la cheie", nu ca produs.

### 👉 Recomandare
**A pentru livrare, B ca fallback pentru clienții care refuză Docker.** Construiește pentru A; B iese aproape gratis dintr-un `output: 'standalone'` bine configurat.

---

## 2. Wizard de instalare (`/install`)

Prima impresie a produsului tău. Trebuie să dureze sub 5 minute.

### Pași

```
0. Gate         Dacă există deja instalare (flag în DB sau install.lock) → 404 permanent
1. Cerințe      ✓ Node 24+  ✓ Postgres reachable  ✓ Redis reachable
                ✓ extensii pg (pg_trgm, uuid-ossp)  ✓ permisiuni scriere pe storage
                ✓ APP_KEY prezent  → afișare verde/roșu, nu treci mai departe cu roșu
2. Bază de date host, port, user, parolă, nume DB → buton „Testează conexiunea"
                → rulează migrațiile cu progres vizibil
3. Magazin      nume, URL, monedă (RON), limbă (RO), fus orar (Europe/Bucharest),
                cotă TVA standard (implicit 21%), țări permise la vânzare (implicit RO)
4. Firmă        denumire, formă juridică, CUI, Reg. Com., sediu, capital social,
                email, telefon, IBAN, bancă
                → folosite automat în footer, facturi, emailuri, pagini legale
5. Administrator nume, email, parolă (cu cerințe de complexitate)
6. Aspect       alege preset temă (Minimal / Bold / Editorial), culoare principală,
                upload logo + favicon → preview live
7. Conținut     [ ] Generează paginile legale template (TC, confidențialitate,
                    cookie-uri, retur, GDPR, ANPC) precompletate cu datele firmei
                [ ] Creează meniurile implicite
                [ ] Instalează date demo (20 produse, 5 categorii) — util la testare
8. Finalizare   Scrie flag de instalare, invalidează /install, generează cheile
                interne, pornește worker-ul → redirect la /admin cu un checklist
                de „primii pași"
```

### Detalii care contează
- Wizard-ul scrie în `.env` doar dacă are permisiuni; altfel afișează conținutul de copiat manual.
- `APP_KEY` se generează automat dacă lipsește. **Dacă se pierde, cheile de integrare criptate devin ilizibile** — avertizează explicit și oferă-l la descărcare.
- Erorile trebuie să fie umane: „Nu mă pot conecta la baza de date. Verifică dacă serviciul rulează și dacă parola e corectă." — nu un stack trace.
- Paginile legale generate au un banner în admin: „Text template. Consultă un avocat înainte de lansare."
- După instalare: checklist de onboarding în dashboard (adaugă primul produs, configurează plăți, configurează livrare, testează un email, adaugă date de facturare).

---

## 3. Mecanism de actualizare

Fără asta, la a cincea instalare devii prizonierul propriului produs.

### Principii
1. **Nu modifici niciodată core-ul per client.** Fără excepții. Prima excepție e începutul sfârșitului.
2. **Migrațiile sunt versionate, idempotente și niciodată distructive** într-un release minor.
3. **Versiune semantică** stocată în `packages/config/version.ts` și în DB (`Setting: app_version`).
4. **Backup automat înainte de orice update.**

### Fluxul de update
```bash
./update.sh
  1. verifică versiunea curentă vs. cea disponibilă
  2. backup DB + storage → ./backups/2026-09-06-v1.4.1.tar.gz
  3. docker compose pull
  4. docker compose up -d --no-deps app worker
  5. rulează migrațiile (prisma migrate deploy)
  6. golește cache-ul, reindexează search
  7. health check → dacă eșuează: rollback automat la imaginea anterioară + restore DB
  8. scrie versiunea nouă în DB, afișează changelog-ul în admin
```

### În admin: „Sistem → Actualizări"
- Versiune instalată, versiune disponibilă, changelog
- Buton „Verifică actualizări" (opțional: ping către un endpoint al tău)
- Istoric de actualizări cu status
- Avertisment dacă există fișiere modificate în core (checksum) — semn că cineva a făcut hack

### Compatibilitate
- Documentează **breaking changes** în `CHANGELOG.md` la fiecare release major
- Migrațiile de date (nu doar de schemă) rulează ca joburi, cu progres
- Testează update-ul de la fiecare versiune anterioară minoră către cea nouă, automat în CI

---

## 4. Sistem de extensii (personalizare fără fork)

Clientul X vrea un câmp în plus la checkout. Clientul Y vrea o secțiune specială pe homepage. Dacă rezolvi asta modificând core-ul, ai terminat produsul. Soluția:

### 4.1 Feature flags
Prima linie de apărare. 80% din cereri sunt „vreau/nu vreau funcția asta".

### 4.2 Blocuri CMS custom
Homepage-ul și paginile sunt construite din blocuri. Un bloc nou = un fișier în `/extensions/blocks/`, înregistrat automat. Nu atinge core-ul.

### 4.3 Registry de hooks
```ts
// packages/extensions/registry.ts
hooks.on('order.before_place', async (ctx) => { ... })
hooks.on('order.placed', async (order) => { ... })
hooks.on('product.saved', async (product) => { ... })
hooks.filter('checkout.fields', (fields) => [...fields, customField])
hooks.filter('price.calculate', (price, ctx) => price)
hooks.filter('email.template', (tpl, key) => tpl)
```
Extensiile din `/extensions` se încarcă la boot. Folderul e exclus din update.

### 4.4 Override de componente
```ts
// extensions/overrides.ts
export default {
  'storefront/ProductCard': () => import('./MyProductCard'),
  'storefront/Footer': () => import('./MyFooter'),
}
```
Registry-ul rezolvă componenta din override dacă există, altfel folosește implicitul.

### 4.5 CSS custom + JS custom din admin
Câmp în Setări → Aspect pentru CSS și pentru scripturi în `<head>`/`<body>`. Rezolvă alte 10% din cereri fără cod.

### 4.6 Webhook-uri și API v1
Restul integrărilor specifice se fac din exterior, nu în cod.

---

## 5. Licențiere (opțional)

Dacă vinzi pachetul ca produs:
- Cheie de licență introdusă la instalare, validată online (grație de 14 zile dacă serverul tău de licențe e indisponibil — **niciodată nu opri magazinul clientului**)
- Cheia deblochează: actualizări, suport, module premium
- Fără licență validă: magazinul funcționează, dar nu primește update-uri și afișează un avertisment în admin
- ⚠️ Nu face DRM agresiv. Un magazin oprit din cauza licenței îți distruge reputația mai repede decât pirateria.

Alternativa curată: vinzi *instalarea și mentenanța*, nu codul. Abonament lunar pentru update-uri și suport.

---

## 6. Neutralitatea pachetului (checklist)

Un pachet proaspăt instalat, fără nicio setare, trebuie să:
```
[ ] Nu afișeze nicăieri numele companiei tale
[ ] Aibă un logo placeholder neutru
[ ] Aibă titlul „Magazin online" și culori neutre
[ ] Nu conțină niciun link către site-ul tău în frontend
[ ] Nu trimită niciun email către tine
[ ] Nu conțină niciun ID de analytics hardcodat
[ ] Nu aibă niciun text în engleză vizibil clientului final
[ ] Aibă toate textele din UI-ul de admin într-un fișier de traduceri
```
Un credit discret („Powered by X") e acceptabil, dar **fă-l dezactivabil din setări**.

---

## 7. Documentație de livrat cu pachetul

| Document | Pentru cine |
|---|---|
| `README.md` — cerințe server, instalare pas cu pas | Cine instalează |
| `MANUAL-ADMIN.md` — cum administrezi magazinul, cu capturi | Clientul final |
| `CHANGELOG.md` | Toți |
| `RUNBOOK.md` — ce faci când pică plata/curierul/DB-ul | Suport |
| `EXTENSIONS.md` — cum scrii o extensie, ce hooks există | Dezvoltatori |
| `LEGAL.md` — ce trebuie completat înainte de lansare | Client |
| Video de 10 min: primii pași după instalare | Client |

Documentația nu e opțională la un produs instalabil. E jumătate din valoare.

---

## 8. Configurația VPS recomandată per instalare

| Magazin | vCPU | RAM | Disk |
|---|---|---|---|
| Mic (sub 1.000 produse, sub 100 comenzi/lună) | 2 | 4 GB | 40 GB |
| Mediu | 4 | 8 GB | 80 GB |
| Mare (peste 10.000 produse) | 8 | 16 GB | 160 GB + storage separat |

Servicii pe VPS: `app` (Next.js), `worker` (BullMQ), `postgres`, `redis`, `caddy`.
Hardening obligatoriu: user non-root, SSH keys only, UFW, fail2ban, unattended-upgrades, swap, backup off-site.
