# Faza 3 — verificare manuală cap-coadă

Parcurs în browser, de la zero, pentru cine verifică Faza 3 (fișiere media). Fiecare pas are „Aștepți” = ce trebuie
să vezi. Timp estimat: 20–30 de minute. Comenzile sunt pentru PowerShell pe Windows (`npm.cmd`, nu `npm`).
Parolele le alegi tu la rulare; nu le scrie în fișiere sau în chat.

Ai nevoie de câteva imagini de test: 3–4 fișiere JPEG/PNG/WebP (oricare), un fișier text redenumit `fals.jpg`
și, dacă ai, o imagine mai mare de 20 MB.

## 0. Pornirea serviciilor

1. Docker Desktop pornit. În rădăcina proiectului:

   ```powershell
   docker compose -f docker/docker-compose.dev.yml up -d
   ```

   **Aștepți:** `docker compose -f docker/docker-compose.dev.yml ps` arată postgres, redis, minio, mailpit „healthy”;
   `minio-init` apare „Exited (0)”.

2. `npm.cmd run storage:init`. **Aștepți:** „Bucketul „ecom” există deja.” și „Politica de citire anonimă pe
   public/* era deja aplicată.” (la prima rulare: „a fost creat” / „a fost aplicată”). A doua rulare dă același
   rezultat, fără eroare.
3. `npm.cmd run dev:web`. **Aștepți:** <http://localhost:3000/api/health> răspunde 200 (Postgres și Redis).
4. Există un cont Owner (din Faza 2). Dacă nu: `npm.cmd run admin:create`.

## 1. Biblioteca goală și permisiuni

1. Autentifică-te ca Owner și deschide <http://localhost:3000/admin/media>. **Aștepți:** titlul „Biblioteca
   media”, în meniu apare „Media”, panoul „Încarcă imagini” și „Foldere”. Dacă biblioteca e goală: „Biblioteca
   este goală. Încarcă prima imagine.”

## 2. Încărcare, procesare și variante

1. Trage 3 imagini în zona „Trage imaginile aici”. **Aștepți:** fiecare rând are bară de progres, cel mult 2
   se încarcă deodată; la final „3 din 3 încărcate”.
2. **Aștepți:** cardurile apar cu starea „În așteptare” / „Se procesează”, apoi trec **singure** la „Gata”
   (fără reîncărcare), cu miniatura imaginii. Cât se procesează se vede un fundal neclar.
3. Click dreapta pe o miniatură → „Deschide imaginea într-o filă nouă”. **Aștepți:** adresa are forma
   `…/media/<uuid>/thumb.<8 caractere>.webp` (sau `.avif`/`.jpg`), **nu** conține numele fișierului tău și nu
   conține „original”.
4. Încearcă `fals.jpg`. **Aștepți:** „Tip de fișier neacceptat…”. Cu fișierul peste 20 MB: „Fișierul depășește
   mărimea maximă permisă.”

## 3. MinIO: public / privat

1. Deschide consola MinIO <http://localhost:9001> (utilizatorul și parola sunt cele din `.env`, `S3_ACCESS_KEY_ID`
   și `S3_SECRET_ACCESS_KEY`). Bucketul `ecom` → `public/media/`. **Aștepți:** câte un folder per imagine, cu
   `original.*` și variantele `thumb.*`, `medium.*`, `large.*`.
2. În fereastră privată de browser (fără sesiune), deschide `http://localhost:9000/ecom/public/media/` + calea
   unei variante `thumb` din consolă. **Aștepți:** imaginea se vede.
3. Deschide `http://localhost:9000/ecom/` (rădăcina bucketului). **Aștepți:** `AccessDenied` (bucketul nu se
   poate lista anonim).
4. Dacă ai creat un obiect sub `private/` din consolă (Upload → un fișier la calea `private/test.txt`), deschide
   `http://localhost:9000/ecom/private/test.txt` anonim. **Aștepți:** `AccessDenied`.

## 4. Detalii, alt-text, taguri, foldere, căutare

1. Deschide o imagine. **Aștepți:** „Recomandat: descrie în 1–2 propoziții…”. Completează „Text alternativ” și
   „Taguri” (`piscina, promo`), „Salvează”. **Aștepți:** „Salvat.”
2. Caută `promo` în câmpul de căutare. **Aștepți:** doar fișierul cu acel tag. Caută o parte din textul
   alternativ: la fel.
3. „Folder nou” → `Produse test` → „Salvează”. Deschide o imagine, alege folderul, „Salvează”. **Aștepți:** în
   folderul `Produse test` apare 1 fișier; filtrul „toate” le arată pe toate.
4. Un al doilea folder cu același nume. **Aștepți:** „Există deja un folder cu acest nume în acest loc.”

## 5. Regenerare și `failed` cu original lipsă

1. În MinIO, șterge fișierul `original.*` al unei imagini (folderul ei din `public/media/`). Notează care
   imagine e (cea mai recentă dintr-un folder pe care o recunoști după dată).
2. În aplicație, deschide acea imagine și apasă „Regenerează variantele”. **Aștepți:** „Regenerarea a început.”,
   starea trece la „Se procesează”, iar în cel mult un minut la „Eșuat”, cu „Fișierul original lipsește din
   stocare. Încarcă-l din nou.” (fără chei sau adrese tehnice în mesaj).
3. Șterge acea imagine din bibliotecă (pasul 6). Pentru o imagine sănătoasă, „Regenerează variantele” o duce din
   nou la „Gata”.

## 6. Ștergere

1. Deschide o imagine → „Șterge…”. **Aștepți:** fereastra „Ștergi acest fișier?”, cu „Șterge definitiv” și
   „Anulează”. „Anulează” nu șterge nimic.
2. „Șterge definitiv”. **Aștepți:** „Fișierul a fost șters.”; în MinIO folderul imaginii a dispărut.
3. Verificarea de utilizare: nu are încă ce să refere fișiere (apare în Faza 4); verificarea e acoperită de
   teste automate.

## 7. Drepturile pe roluri

1. Creează un cont de client la `/inregistrare`, confirmă emailul în Mailpit (<http://localhost:8025>) și dă-i
   rolul Manager (Prisma Studio: `npm.cmd run db:studio` → tabela `user_role`, un rând nou cu utilizatorul și
   rolul `manager`). Autentifică-te cu el.
2. `/admin/media`. **Aștepți:** biblioteca se vede, dar fără panou „Încarcă imagini”, fără „Folder nou”, fără
   „Șterge…” / „Salvează” în detalii.
3. Un rol fără `media.read` (ex. Suport): `/admin/media`. **Aștepți:** „Acces interzis”.
4. Jurnalul de audit (Prisma Studio, tabela `audit_log`): rânduri `media.upload`, `media.update`,
   `media.delete`, `media.regenerate`, iar încercările refuzate apar cu rezultatul `denied`.

## 8. Selectorul pentru formulare

Selectorul nu are pagină în aplicație (niciun formular nu-l folosește încă). Se verifică prin testele care îl
exercită într-o pagină doar-pentru-teste:

```powershell
npm.cmd run test:e2e -- e2e/media-picker.spec.ts
```

**Aștepți:** `6 passed`. (Opțional, cu browser vizibil: `npx.cmd playwright test e2e/media-picker.spec.ts --headed`.)

## 9. Telefon și mod întunecat

1. În `/admin/media`, fereastră îngustă (375 px, F12 → mod dispozitiv). **Aștepți:** fără scroll orizontal;
   grila trece pe o coloană/două; paginarea nu iese din ecran.
2. Meniul utilizatorului → „Întunecat”. **Aștepți:** biblioteca și ferestrele de detalii rămân lizibile (text
   deschis pe fond închis).
3. Tastatură: Tab până la grilă; săgețile mută focusul între miniaturi; Enter deschide detaliile; Escape le
   închide și întoarce focusul.

## 10. Testele automate (opțional, câteva minute)

```powershell
npm.cmd run test:integration
npm.cmd run test:e2e
npm.cmd run test:e2e:s3
```

**Aștepți:** integrare verde (cu MinIO pornit), E2E verde, iar `test:e2e:s3` (`media-s3.spec.ts`, încărcare
pe S3) `1 passed`. Prima rulare după o pauză poate dura peste 2 minute (compilarea la rece).

## Dacă ceva nu iese

- „Stocarea fișierelor nu este disponibilă”: MinIO nu rulează sau bucketul lipsește → `npm.cmd run storage:init`.
- Fișierele rămân la „Se procesează”: workerul pornește odată cu `npm.cmd run dev:web`; verifică Redis.
- `npm` nu rulează în PowerShell (`npm.ps1` blocat): folosește `npm.cmd`.
