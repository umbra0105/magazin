# Faza 2 — ce funcționează acum

Rezumat în limbaj simplu, pentru cine nu citește codul. Detaliile tehnice sunt în `PROGRESS.md`.

## Pentru un vizitator / client

- **Își poate face cont** (`/inregistrare`) cu nume, email și o parolă de cel puțin 12 caractere. Contul e mereu de
  client: oricâte câmpuri „de rol” ar trimite cineva, serverul le ignoră.
- **Primește un email de confirmare** (valabil 24 de ore, folosibil o singură dată). Până îl confirmă, nu se poate
  autentifica și vede un mesaj clar.
- **Se autentifică** (`/autentificare`) și ajunge în contul lui (`/cont`). Poate să se deconecteze.
- **Și-a uitat parola?** Cere un link de resetare (valabil 1 oră, o singură dată). Mesajul e același, indiferent
  dacă emailul există, ca nimeni să nu poată afla cine are cont.
- **Protecții la autentificare** (valorile sunt setări, implicit cele de mai jos):
  - **Blocarea la autentificare** (regulile de mai jos sunt cele de după Blocul C din Faza 4; înainte existau o
    «limită» de 5 încercări și o «blocare a contului» la 10 parole greșite, pe email, de la orice adresă):
    - **Se numără doar parolele greșite.** Conectările reușite, limitările și emailul neverificat nu contează; cinci
      conectări corecte la rând nu blochează pe nimeni. O conectare reușită șterge greșelile acelei perechi.
    - **(a) Pe pereche (email, adresă IP):** 5 parole greșite în 15 minute (`auth.loginMaxAttempts`,
      `auth.loginWindowMinutes`) → perechea se blochează 15 minute (`auth.lockoutMinutes`). Cât e blocată, orice
      încercare (și cu parola corectă) primește „Prea multe încercări” (HTTP 429) cu numărul de minute. La blocări
      repetate în 24 de ore durata se **dublează** (15, 30, 60 … până la 24 de ore). Se deblochează singură sau cu
      `pnpm admin:unlock <email>`.
    - **(b) Pe adresă IP:** 30 de parole greșite în 15 minute de la aceeași adresă (`auth.loginIpMaxAttempts`,
      pentru orice email) → adresa se blochează progresiv, la fel. În plus, un ritm maxim de 120 de încercări pe minut
      pe adresă (`auth.loginRatePerMinutePerIp`), reușitele incluse.
    - **Nu există blocare globală pe email.** Parolele greșite pentru același email de la **adrese diferite** nu
      blochează contul; doar produc o alertă în jurnalul de audit (`auth.login_suspicious`, la
      `auth.lockoutThreshold` = 10). Un străin nu poate bloca contul unui administrator de pe altă adresă.
    - **Ce schimbă `auth.trustedProxyHops`** (numărul de servere intermediare de încredere dintre internet și
      aplicație; 0 = fără proxy, 1 = un proxy ca Caddy). Adresa clientului se citește din `X-Forwarded-For` doar
      dacă valoarea e mai mare ca 0:
      - **`trustedProxyHops = 1` (sau mai mult), în spatele proxy-ului:** adresa clientului e cunoscută, deci se
        aplică regulile (a) și (b) întocmai: prag 5, blocare 15 minute progresivă, blocare pe adresă.
      - **`trustedProxyHops = 0` (valoarea implicită din seed; dezvoltare locală sau fără proxy):** adresa nu e de
        încredere, deci toți utilizatorii partajează «adresa necunoscută». Perechea devine (email, «-»), pragul se
        **triplează** (15 parole greșite), blocarea se **plafonează la 1 minut**, nu există blocare pe adresă, iar
        ritmul pe «adresa necunoscută» e de 1.200 de încercări pe minut. Un străin poate cel mult să încetinească
        conectările unui email, un minut o dată. Aplicația scrie un avertisment la pornire în producție dacă rulează
        astfel. Instalatorul trebuie să seteze 1 în spatele Caddy (Faza 18).
      - O valoare **prea mare** față de realitate lasă clientul să-și aleagă singur adresa din antet: nu o mări
        fără motiv.
  - Cererile sunt limitate și pe IP la înregistrare, resetare și confirmarea emailului; toate sesiunile se închid
    la schimbarea sau resetarea parolei.

## Pentru administrator

- **Contul de Owner se creează din linia de comandă** (`pnpm admin:create`), cu parola tastată în terminal. Nu
  există nicio parolă implicită nicăieri. Recuperare fără email: `pnpm admin:set-password <email>`.
- **Zona de admin** (`/admin`): meniu lateral și bară de sus, calea de navigare (breadcrumbs), mod întunecat, tastatură,
  telefon. Meniul arată doar ce are voie utilizatorul și doar funcțiile pornite (feature flags).
- **Sesiunea de admin expiră** după numărul de ore din setări, cu mesajul „Sesiunea a expirat”.
- **Roluri:** Owner, Admin, Manager, Editor, Suport, Depozit, Contabil. Fiecare are exact permisiunile din tabelul
  din `docs/04-backend-admin.md` §6. Fără permisiunea `admin.access` nu se intră în admin, oricâte alte permisiuni
  ar exista. Verificarea se face pe server la fiecare acțiune, nu doar prin ascunderea butoanelor.
- **Jurnal de audit** (nu se poate șterge sau modifica): fiecare scriere din admin înregistrează cine a făcut-o, când,
  ce s-a schimbat (doar diferențele) și rezultatul. Parolele, cheile și tokenurile nu apar niciodată. O încercare
  refuzată nu modifică nimic, dar se înregistrează ca „refuzată”.
- **Emailurile** pleacă printr-o coadă (nu blochează pagina) și se încearcă din nou dacă serverul de email nu
  răspunde. Serverul SMTP se configurează din setări (parola e criptată). În dezvoltare, emailurile se văd în
  Mailpit (`http://localhost:8025`).

## Ce NU există încă

- **Setările, flag-urile și brandingul nu se pot edita încă din interfață**: se schimbă doar prin CLI/seed. Acțiunile
  de scriere există și sunt testate (cu audit), dar fără interfață; paginile de editare vin în Fazele 6 și 16.
- Paginile `/admin/*` (în afară de panou) arată „Secțiune în construire” până în Fazele 6 și 16.
- Autentificarea în doi pași (TOTP) pentru admin: Faza 21.
- Contul de client (comenzi, adrese): Faza 14. Pagina `/cont` doar confirmă sesiunea.

## Ca să meargă local

- **Docker trebuie să ruleze** (Postgres, Redis, Mailpit): `docker compose -f docker/docker-compose.dev.yml up -d`.
- **Emailurile cer SMTP.** În dezvoltare pornești `pnpm dev:mail` (configurează SMTP-ul către Mailpit), iar mesajele
  se văd în Mailpit la http://localhost:8025.
- **Windows cu turbo blocat:** pornești cu `pnpm dev:web` (nu `pnpm dev`).

## Cum verifici rapid

```bash
pnpm check:local          # typecheck, lint, format, teste unitare
pnpm test:integration     # Postgres + Redis de test
pnpm test:e2e             # browser, pe baza de test
```
