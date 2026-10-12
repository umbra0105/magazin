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
- **Protecții:** după 5 încercări greșite contul se blochează 15 minute (cu mesaj în română și numărul de minute);
  cererile sunt limitate pe IP; toate sesiunile se închid la schimbarea parolei.

## Pentru administrator

- **Contul de Owner se creează din linia de comandă** (`pnpm admin:create`), cu parola tastată în terminal. Nu
  există nicio parolă implicită nicăieri. Recuperare fără email: `pnpm admin:set-password <email>`.
- **Zona de admin** (`/admin`): meniu lateral și bară de sus, „pesmeți” (breadcrumbs), mod întunecat, tastatură,
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

- Paginile de editare din admin (setări, branding, integrări): acțiunile de scriere există și sunt testate, dar fără
  interfață; vin în Fazele 6 și 16.
- Autentificarea în doi pași (TOTP) pentru admin: Faza 21.
- Contul de client (comenzi, adrese): Faza 14. Pagina `/cont` doar confirmă sesiunea.

## Cum verifici rapid

```bash
pnpm check:local          # typecheck, lint, format, teste unitare
pnpm test:integration     # Postgres + Redis de test
pnpm test:e2e             # browser, pe baza de test
```
