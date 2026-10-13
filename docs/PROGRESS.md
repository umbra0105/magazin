# Jurnal de progres

## 2026-10-12 · Sesiunea 4 · Faza 3 (Media), Promptul 4 — ÎN LUCRU
**Terminat (confirmat de utilizator):** punctele 1 (schema, migrația, `media.read`), 2 (adaptor de storage, MinIO în CI), 4 (procesare în queue; CI verde pe cfebd5b) și 3 (upload prin server; verificat în browser: 201 pending, 503 fără bucket, 415, 413, 401/403, audit success/denied/failed)
**Terminat și confirmat:** și punctele 5, 6, 7 (MediaPicker, confirmat de utilizator; E2E picker + bibliotecă 10/10)
**În lucru:** punctul 8 (E2E pe S3, documentație, închiderea fazei)
**Starea punctului 8 (scrisă după o cădere a sesiunii, cod 3221226505, în timpul rulării specului S3):**
- Fișierele punctului 8 sunt complete (verificate după cădere) și vor intra într-un singur commit, împreună cu restaurarea `apps/web/tsconfig.json`. Verificări (node / `npm.cmd`, un singur server de test pe rând): typecheck ✔ (10 pachete), lint ✔, lint:root ✔, format ✔, unitare ✔ 587, integrare ✔ 194 (cu MinIO), E2E obișnuit ✔ 41, E2E S3 (`test:e2e:s3`) ✔ 1. CI-ul pe commitul punctului 8 urmează să fie confirmat de utilizator.
**Blocat:** —

**Mediu (Windows-ul utilizatorului): `pnpm.exe` poate fi blocat de Smart App Control / Device Guard.** În sesiunea din 2026-10-13, la ~09:33, `pnpm.exe` (nesemnat, din `C:\Users\Admin\AppData\Local\pnpm\global\v11\<hash>\node_modules\pnpm\`) a fost blocat de Code Integrity (evenimente 3077/3033/3118). Folderul există din 2026-10-08, deci blocarea e nouă, nu o descărcare recentă. Pachetul pnpm 12.10.1 conține DOAR `pnpm.exe` (fără intrare JavaScript). **Decizie utilizator:** verificările locale rulează prin `node` direct, pe uneltele din `node_modules`-ul proiectului; nu se schimbă și nu se ocolesc politicile Windows; dacă `node.exe` sau un modul nativ (esbuild, sharp, rollup, SWC, argon2) e blocat → 🛑. Comenzi de zi cu zi, din rădăcina repo-ului `X:\360\magazin`. **`npm run <script>` funcționează pentru toate** (npm se lansează prin node, nu e blocat), la fel ca `pnpm <script>`; argumentele se dau după `--` (ex. `npm run media:regenerate -- --failed`, `npm run dev:web -- -p 3101`). Scripturile care apelau `pnpm --filter` sau `turbo` au fost rescrise să ruleze prin node (`scripts/in.mjs`, `scripts/run-all.mjs`), deci merg la fel cu pnpm, npm și în CI; variantele turbo au rămas ca `turbo:lint`, `turbo:typecheck`, `turbo:build`.

| Ce vrei | Comandă | Verificat |
|---|---|---|
| Pornește aplicația + workerii (dev) | `npm run dev:web` (`-- -p 3101` pentru alt port) | da: `/api/health` 200, `.env` încărcat, workerii porniți |
| Worker separat (emailuri + media) | `npm run worker` | aceeași cale ca `dev:web`; neexecutat |
| Teste unitare / integrare | `npm run test` / `npm run test:integration` | da (526 / 166 trec) |
| Teste E2E | `npm run test:e2e` | da: `-- --list` (31 teste); serverul E2E pornește prin node |
| Typecheck / lint / format | `npm run typecheck` / `npm run lint` / `npm run lint:root` / `npm run format:check` | da |
| Tot ce ținea de `check:local` | `npm run check:local` | prin componentele de mai sus |
| Build de probă (nu atinge `.next`) | `NEXT_DIST_DIR=.next-probe npm run build:web`, apoi ștergi `apps/web/.next-probe` și `git checkout -- apps/web/tsconfig.json apps/web/next-env.d.ts` | da (direct cu node) |
| Seed de pachet | `npm run db:seed` | da (idempotent) |
| Migrații dev / Studio | `npm run db:migrate` / `npm run db:studio` | studio: da (pornește pe un port afișat în consolă, ex. 49152); migrate: neexecutat (interactiv; același prisma ca `migrate deploy`) |
| Bucket S3 | `npm run storage:init` | da |
| Cont admin | `npm run admin:create`, `admin:set-password <email>`, `admin:unlock <email>` | da (refuz fără terminal / mesaj de folosire) |
| Media: regenerare | `npm run media:regenerate -- <id, --failed, --stale, --all>` | da (mesaj de folosire; regenerarea e acoperită de teste) |
| Media: ultimele 5 (doar citire) | `npm run media:recent` | da |
| SMTP local / preset temă / seed magazin | `npm run dev:mail` / `dev:preset` / `db:seed:store` | neexecutate (modifică configurarea din baza de dev); aceeași formă `node --import tsx` ca restul |

**PowerShell pe Windows-ul utilizatorului: `npm run ...` pică cu „running scripts is disabled on this system” (execution policy blochează `npm.ps1`).** Soluție fără schimbarea politicii: `npm.cmd run <script>` (shim `.cmd`), sau Command Prompt / Git Bash cu `npm run <script>`. Politica de execuție PowerShell nu se modifică. Nu a fost nevoie de funcții PowerShell. Testele de integrare nu mai depind de `pnpm` (`prepare-test-database.ts` lansează Prisma cu node), iar hook-urile Git (`.husky/pre-commit`, `.husky/commit-msg`) rulează acum `lint-staged` și `commitlint` direct cu node (commit `chore(husky)`).

**Incident în sesiune (raportat):** la verificarea punctului 3 am pornit `next start` pe portul 3000, deja ocupat de un proces al utilizatorului (cel mai probabil serverul de dezvoltare, `pnpm dev:web`). Apoi am oprit după linia de comandă un proces `next` care, probabil, era chiar acel server; `next start` mi-a stricat și folderul `.next` (build de producție peste cel de dezvoltare). Nu am atins baza de date. Utilizatorul trebuie să repornească `pnpm dev:web`. De acum probele mele rulează doar pe porturi proprii (3101), pornite și oprite după PID, și verific mai întâi ce ascultă pe port

**Defect găsit la verificarea punctului 3 (de utilizator) și reparat:** POST /api/media dădea 500 cu corp gol pe `pnpm dev:web`. Cauza confirmată: bucketul de dev `ecom` nu exista în MinIO (conținea doar `ecom-test`, creat de teste); SDK-ul răspundea `NoSuchBucket`, status 404. De ce n-a prins-o niciun test: testele de integrare creează singure bucketul de test, iar E2E rulează cu `STORAGE_DRIVER=local`. Reparat prin: (1) ruta întoarce 503 `MEDIA_STORAGE_UNAVAILABLE` (și 500 JSON `MEDIA_UPLOAD_FAILED` la erori neașteptate), cu `audit_log.outcome = 'failed'` (migrația `audit_log_outcome_failed`: constrângerea permitea doar `success`/`denied`); (2) `pnpm storage:init` și serviciul `minio-init` din docker compose; (3) test E2E de upload pe driverul S3 în CI, planificat la punctul 8

**Decizii în sesiune (toate ale utilizatorului):**
- **Utilizator (după punctul 3):** originalul re-codificat (nu identic bit cu bit) e acceptat
- **Utilizator (după punctul 3):** Managerul rămâne FĂRĂ `media.write` (are `media.read`). De reluat la Faza 16 dacă vrem upload și pentru Manager (notat în TODO, Faza 16)
- **Utilizator (regulă permanentă, acum în `CLAUDE.md`):** nu opresc procese pe care nu le-am pornit eu; probele rulează doar pe port propriu, pornite și oprite după PID; dacă un port e ocupat aleg alt port; build-urile pentru probe nu scriu peste `.next` (director separat, `NEXT_DIST_DIR`)
- **Utilizator:** driverul de storage rămâne în `.env` (`STORAGE_DRIVER` + `S3_*`), nu în Setări; formularea din TODO corectată
- **Utilizator:** upload prin server, cu stream, pentru ambele drivere; presigned URL doar când apar fișiere mari
- **Utilizator:** dependențe aprobate: `sharp`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `file-type`, `blurhash`. Modificarea din `allowBuilds` (dacă e nevoie) se arată înainte. Instalate până acum: `@aws-sdk/client-s3` și `@aws-sdk/s3-request-presigner` la `3.1149.0` (punctul 2); `sharp` `0.35.5` și `file-type` `22.1.1` în `@ecom/core` (punctul 3), versiuni exacte. `sharp` se încarcă pe Windows-ul utilizatorului fără modificare în `allowBuilds` (binarul vine prebuilt, fără script de build); `blurhash` vine la punctul 4
- **Utilizator:** limită implicită 20 MB/fișier și ~40 megapixeli la intrare, editabile din setări; tipuri JPEG, PNG, WebP, AVIF (fără GIF; SVG respins); taguri `String[]`
- **Utilizator:** `media.read` nou (matricea din `docs/04` §6 actualizată în același commit); originalul se păstrează fără EXIF/GPS lângă variante
- **Utilizator:** ruta de upload (API route, nu server action) își face singură: sesiune, `media.write`, Origin, rate limit, audit (și refuzuri), mărime în timpul stream-ului — cu test de refuz
- **Utilizator:** teste MinIO pe bucket separat de test, cu gardă („test" în nume); MinIO în `ci.yml`; migrația fără reset (altfel 🛑); dacă `sharp` nu se încarcă din cauza Application Control → 🛑, fără ocolirea securității Windows
- **Utilizator:** alegerea storage-ului de producție mutată la **Faza 18** (`docs/10` Partea I, „Deschise")
- **Claude (punctul 2):** vizibilitatea e STRUCTURALĂ: cheia începe cu `public/` sau `private/` (validat în `keys.ts`); `publicUrl` refuză cheile private. Fără parametru de vizibilitate care să se poată uita
- **Claude (punctul 2):** `publicUrl` fără `S3_PUBLIC_URL` trece prin ruta aplicației `/media/...` (se construiește la punctul 5), pentru ambele drivere; cu `S3_PUBLIC_URL` (CDN/bucket public) arată direct acolo. Nu depindem de politici de bucket pentru dezvoltare
- **Claude (punctul 2):** `put` primește `Buffer` (dimensiunea e limitată de ruta de upload; fără `@aws-sdk/lib-storage`); `get` întoarce stream. Pe local, scriere atomică (temp + rename) și metadate într-un fișier `<cheie>.meta.json` (sufix rezervat)
- **Claude (punctul 2):** linkurile semnate locale sunt HMAC-SHA256 cu cheie HKDF din `APP_KEY` (context separat de criptarea credențialelor); ruta care le servește (verificare cu `verifyClaims`) vine la Faza 14b
- **Claude (punctul 2):** `STORAGE_LOCAL_PATH` relativ se ancorează la rădăcina monorepo-ului (primul `pnpm-workspace.yaml`), ca web (cwd `apps/web`) și worker (cwd rădăcină) să vadă același director. În producție: cale absolută. `/storage` e în `.gitignore`
- **Claude (punctul 2):** în CI, MinIO pornește cu `docker run` într-un pas (nu `services:`, care nu permite comanda `server /data`), aceeași imagine pe digest ca în docker compose; aplicația rămâne cu `STORAGE_DRIVER=local`, variabilele `S3_*` le citesc doar testele de storage
- **Claude (punctul 5):** două rute: `/media/<cale>` (public) și `/storage/signed/<cheie>?exp&sig&dl` (privat, driverul local; pe S3 linkurile semnate sunt cele native). Logica e în `@ecom/core` (`servePublicObject`, `serveSignedObject`), iar rutele din `apps/web` doar o leagă. Din `/media` prefixul `public/` îl pune serverul, deci `private/` nu poate fi atins, iar cheile cu `..`, `%`, `\`, NUL, segmente goale sau sufixe rezervate dau 404. Se servesc doar tipurile `image/avif|webp|jpeg|png` (restul 404, chiar sub `public/`). Antete: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: public, max-age=31536000, immutable` (public) / `private, no-store` (privat)
- **Claude (punctul 7):** `MediaPicker` (`apps/web/src/components/admin/media/media-picker.tsx`) e un dialog (`@ecom/ui` `Dialog`, `<dialog>` nativ: focus capturat, Escape, revenire a focusului) cu props `open`, `onClose`, `onConfirm(ids)`, `mode` (`single`/`multiple`), `max` (implicit 10, între 1 și 50; la `single` mereu 1), `initialSelectedIds`, `title`. **Contractul de ieșire e DOAR o listă de id-uri, în ordinea alegerii**: nicio cheie de storage, nicio adresă de original. Logica selecției e pură și testată separat (`apps/web/src/lib/media-selection.ts`)
- **Claude (punctul 7):** selectorul arată DOAR fișiere `ready`: filtrul de stare e impus pe server în acțiunea `listPickerMedia` (nu vine din cerere), 12 pe pagină, cu varianta `thumb`; o selecție inițială cu fișiere care nu mai sunt `ready` le elimină. Cere `media.read` (`withPermission`, audit `media.pick`); încărcarea apare în selector doar când `canWrite` (`media.write`), iar serverul o refuză oricum fără permisiune
- **Claude (punctul 7):** fără cod duplicat față de bibliotecă: din `media-library.tsx` s-au extras `MediaGrid` (navigare cu săgeți/Home/End), `MediaFilterFields` (căutare, folder, stare), `useMediaUploads` (coada `UploadQueue`, max 2 simultan) și `useStatusPolling`; biblioteca și selectorul le folosesc pe aceleași. `MediaCard` primește opțional `selection` (`aria-pressed`, ordinea, blocat la limită). Comportamentul, textele și permisiunile bibliotecii sunt neschimbate (testele de integrare și `e2e/media.spec.ts` rămân verzi)
- **Claude (punctul 7):** harness DOAR pentru teste, fără rută de dezvoltare în producție: pagina `admin/e2e-harness/media-picker/page.e2e.tsx` există în build doar când `E2E_HARNESS=1` (`pageExtensions` din `next.config.ts` include `e2e.tsx` numai atunci; setat doar de `playwright.config.ts`), plus gardă `notFound()` în pagină. Verificat: build de producție fără variabilă nu conține ruta. Selectorul nu e legat încă de niciun formular real; primul consumator vine la Faza 4 (imaginile produsului)
- **Claude (punctul 7):** defecte găsite de testele E2E și corectate: (1) `id="media-folder"` duplicat între filtrul paginii și dialogul de detalii strica asocierea label ↔ câmp (prefix `media-filter`); (2) închiderea programatică a dialogului declanșa `onClose` al părintelui (`openRef` în `Dialog`); (3) `instanceof MediaError` eșua între copiile modulelor din Next și dădea 500 sub încărcare: clasificare structurală după `code` (`isMediaError`, `failure()` în acțiuni, verificarea de rate limit în `upload-handler`); (4) paginarea depășea lățimea pe telefon (`flex-wrap`)
- **Claude (punctul 7):** `e2e/media-picker.spec.ts` (6 teste: doar `ready` + doar `thumb` + id-uri fără chei; multiplă cu ordine, maxim, scoatere, persistență la căutare; tastatură + focus capturat + Escape; selecție inițială; Owner încarcă în selector, Manager fără încărcare; telefon 375 px + mod întunecat). Specurile media rulează în mod `serial`, fiindcă încărcările paralele concurează pentru cele 2 sloturi de decodare. `insertE2eMedia` în `e2e-support.ts` inserează rânduri `pending`/`failed` fără fișiere
- **Claude (punctul 6):** pagina `/admin/media` (cere `media.read`) e server component: căutarea, filtrele (folder, stare) și pagina sunt în URL (formular GET), deci merg și fără JavaScript și se pot trimite ca link. Partea interactivă (încărcări, detalii, foldere, actualizare automată de status) e client component. Grid-ul folosește DOAR varianta `thumb` (WebP, altfel JPEG/AVIF) și un placeholder PNG de 16×16 calculat pe server din blurhash (fără bibliotecă de decodare în browser); nicio cheie de storage nu ajunge în browser
- **Claude (punctul 6):** `MediaLibraryService` (core) verifică singur `media.read` / `media.write` (a doua barieră, după `withPermission`) și scrie în audit: `media.update` (doar diferențele), `media.delete`, `media.regenerate`, `media_folder.create|rename|move`. Ștergerea întreabă `MediaUsageRegistry` (toți providerii; unul căzut = ștergerea eșuează, fail-closed), apoi șterge rândul și TOATE obiectele (original + variante); obiectele rămase dacă storage-ul cade se raportează în log. Registrul nu are încă niciun provider: Faza 4 (produse) și Faza 16 (pagini, bannere) își înregistrează unul, prin `getMediaUsageRegistry()` din `apps/web/src/lib/media.ts`
- **Claude (punctul 6):** încărcările din browser: `UploadQueue` (`apps/web/src/lib/media-uploader.ts`, testat fără React) cu max. 2 simultan, progres prin XMLHttpRequest, reîncercare automată după `Retry-After` la `503 MEDIA_BUSY` (cel mult 5 ori, apoi mesaj), mesaje în română pentru 413/415/429/503/401/403 etc. Foldere: creare, redenumire, mutare (fără cicluri, adâncime max. 5, nume unic în același părinte, fără diferență de majuscule); ștergerea de foldere NU e în acest punct
- **Claude (punctul 6):** componente noi în `@ecom/ui`: `Badge`, `Progress`, `Select`, `Textarea`, `Dialog` (pe `<dialog>` nativ: focus capturat, Escape, restaurare focus; închiderea programatică nu mai declanșează `onClose`, defect găsit de E2E). Intrare nouă „Media” în meniul de admin (`media.read`)
- **Claude (punctul 6):** E2E nou `e2e/media.spec.ts` (4 teste: Owner cap-coadă, Manager citire-doar, tastatură, telefon + mod întunecat). Serverul E2E folosește acum storage LOCAL într-un director temporar (șters de global-teardown) și `NEXT_DIST_DIR=.next-e2e`, ca să nu scrie peste `.next`; testul E2E pe S3 rămâne la punctul 8. Teardown-ul șterge și rândurile `Media` ale conturilor de test. Testele de integrare nu mai presupun jurnal de audit gol (E2E scrie în el): asertează pe diferențe
- **Claude (punctul 5):** `storage:init` aplică pe bucket politica de citire anonimă DOAR pe `arn:aws:s3:::<bucket>/public/*` (`s3:GetObject`, Sid `EcomPublicRead`): fără listare, scriere sau ștergere anonimă. Idempotent; o politică existentă care nu e a noastră NU se suprascrie (rezultat `foreign`, cu avertisment). `S3_PUBLIC_URL` = baza adreselor publice (în dev `http://localhost:9000/ecom`, în `.env.example`; în producție domeniul CDN/R2). MinIO trimite el însuși `X-Content-Type-Options: nosniff`; pe alți furnizori sau CDN antetul se setează la CDN (runbook, Faza 18/21), fiindcă pe un obiect S3 nu se pot stoca antete arbitrare
- **Claude (punctul 4):** limită GLOBALĂ de decodări de imagini = 2: semafor în Redis (ZSET de lease-uri cu expirare 120 s, ceasul Redis, script Lua), aceeași cheie în aplicație și în worker; dacă Redis cade, rezervă în memorie per proces (fail-closed). La upload: fără loc → `503 MEDIA_BUSY` + `Retry-After: 5`, înainte de decodare, auditat `failed`. În worker: fără loc → jobul trece în `delayed` (±25% jitter) și NU consumă o încercare. Locul se ia DUPĂ citirea corpului (altfel un client lent ar ține locuri) și se eliberează înainte de scrierile în storage
- **Claude (punctul 4):** coada `media` (BullMQ): 5 încercări, backoff exponențial 10 s, job `media-<id>`; în Redis stă doar `{mediaId}`. Reușita șterge jobul, eșecul îl păstrează 24 h. `failedReason` și `Media.processingError` conțin doar un COD (`STORAGE_UNAVAILABLE`, `IMAGE_TOO_LARGE`, `IMAGE_CORRUPT`, `ORIGINAL_MISSING`, `UNEXPECTED`); mesajul erorii originale nu se persistă nicăieri. Erorile definitive (imagine coruptă sau prea mare, original lipsă) nu se reîncearcă
- **Claude (punctul 4):** limita de pixeli (`media.maxInputPixels`, citită la fiecare procesare) se aplică din antet, înainte de decodare, și la procesare, nu doar la upload
- **Claude (punctul 4):** variante thumb/medium/large (lățimi 320/800/1600 din setări) × AVIF/WebP/JPEG; imaginea nu se mărește (o țintă ≥ originalul se generează o singură dată, la mărimea originalului); JPEG din imagine cu transparență se așază pe alb. Cheia variantei conține hash-ul conținutului (`<nume>.<hash8>.<ext>`), deci un URL nu-și schimbă niciodată conținutul și cache-ul `immutable` rămâne corect; la regenerare, cheile vechi nefolosite se scot din storage abia după ce rândul a fost actualizat
- **Claude (punctul 4):** regenerare cerută cât jobul încă rulează (defect găsit de un test): `add` cu același id era ignorat și cererea se pierdea. Acum: job `media-<id>-rerun` adăugat o singură dată când cel principal e activ, plus lock per fișier în Redis (`SET NX PX`) care le face să ruleze pe rând; lock ocupat = `busy` (amânat, fără încercare consumată)
- **Claude (punctul 4):** `pnpm media:regenerate <id | --failed | --stale | --all>` (CLI, audit `media.regenerate` ca `cli`); butonul din UI vine la punctul 6. `MediaService.onCreated` pune în coadă după upload; dacă punerea în coadă eșuează, fișierul rămâne `pending`, iar `--stale` îl reia
- **Claude (punctul 4):** `blurhash` 2.0.5 adăugat în `@ecom/core` (aprobat). `sharp`, `file-type` și `blurhash` se importă leneș. Dependențe workspace noi: `@ecom/integrations` în `@ecom/jobs` și `@ecom/core`, `@ecom/config` în `@ecom/core`
- **Claude (punctul 3):** ruta `POST /api/media` primește fișierul ca CORP brut (nu multipart), cu `X-File-Name` (percent-encoded) și `?folderId=&alt=`: așa mărimea se poate limita în timpul stream-ului fără parser multipart. Toată logica e în `handleMediaUpload` (`@ecom/core`, testabil fără Next); ruta din `apps/web` doar o leagă. Ordinea: origine → sesiune → `media.write` → rate limit → mărime în stream → tip real/pixeli/curățare → storage + DB → audit
- **Claude (punctul 3):** originalul păstrat NU e identic bit cu bit: se decodează și se re-codifică (JPEG 4:4:4 calitate 95, PNG fără pierderi, WebP 95, AVIF 90). Asta scoate EXIF/GPS/XMP și conținutul poliglot și aplică orientarea; e aproape fără pierderi. Imaginile animate păstrează doar primul cadru
- **Claude (punctul 3):** `sharp` și `file-type` se importă leneș în `sanitizeImage`: `@ecom/core` se încarcă peste tot, deci un modul nativ care nu se poate încărca pe o mașină strică doar upload-ul de imagini, nu toată aplicația
- **Claude (punctul 3):** refuzurile se auditează cu rezultat `denied` și doar motivul (fără nume, fără conținut). Înregistrările refuzate sunt limitate pe IP (`media.refusedAuditMaxAttempts`, ×10 în bucket comun fără IP de încredere), ca o buclă anonimă să nu umple un jurnal care nu se poate șterge. Dacă auditul de succes eșuează, răspunsul e `500 AUDIT_WRITE_FAILED` cu `mediaId` (aceeași politică ca `withAudit`; fișierul rămâne salvat)
- **Utilizator (după verificarea punctului 3):** politica de acces public pentru prefixul `public/` (citire anonimă) se stabilește la **punctul 5** (servire fișiere), împreună cu `S3_PUBLIC_URL`. `pnpm storage:init` creează doar bucketul; nu schimbă politici
- **Claude (după verificarea punctului 3):** `audit_log.outcome` primește valoarea `failed` (acțiune autorizată, eșuată din defecțiune), separată de `denied`, ca rapoartele de securitate să nu se amestece cu defecțiunile. Eșecurile de storage folosesc aceeași limită de înregistrare ca refuzurile (un storage căzut nu umple jurnalul)
- **Claude (punctul 3):** setări noi în grupul `media`: `maxUploadBytes` (20 MB, plafon 50 MB: trece prin memorie), `maxInputPixels` (40 MP), `allowedMimeTypes` (doar din cele 4 suportate), `uploadMaxAttempts`/`uploadWindowMinutes` (60 / 10 min), `refusedAuditMaxAttempts` (20)
- **Claude (punctul 3):** rândul `Media` se creează `pending`; procesarea în queue (variante, blurhash) vine la punctul 4 (`MediaService` are deja cârligul `onCreated`). Până atunci fișierele încărcate rămân `pending`
- **Claude (punctul 2):** `IntegrationError` adăugat în `@ecom/shared` (era în CLAUDE.md, lipsea din cod)

**Decizii (punctul 8):**
- **Claude (punctul 8):** testul E2E pe S3 (`e2e/media-s3.spec.ts`) rulează cu `npm run test:e2e:s3` (`scripts/e2e-s3.mjs` setează `E2E_TARGET=s3`): proiectul `chromium-s3`, UN singur server de test (portul 3101, `STORAGE_DRIVER=s3`, `NEXT_DIST_DIR=.next-e2e-s3`), pornit după `storage:init` pe bucketul de test (`TEST_S3_BUCKET` sau `<S3_BUCKET>-test`, gardă „test” în nume; `S3_PUBLIC_URL` = endpoint + bucket de test). Suita obișnuită (`test:e2e`) nu pornește serverul S3 și nu depinde de MinIO; în CI rulează ca pas separat, după ea. Redis pe DB 2 la serverul S3, ca joburile `media` să nu fie preluate de workerul altui server
- **Claude (punctul 8):** testul acoperă: încărcare prin aplicație, procesare până la «Gata», adresa thumb direct din `S3_PUBLIC_URL` citită anonim (200, `image/*`), listarea anonimă a bucketului refuzată (403), un obiect `private/` refuzat anonim (403) și citit cu link semnat, ștergerea din bibliotecă care scoate fișierele din bucket. Clientul AWS e rezolvat din `packages/integrations` (nu e adăugat în rădăcină)
- **Claude (punctul 8):** o sesiune s-a prăbușit (cod 3221226505) în timpul primei variante, în care ambele servere de test porneau mereu; de aceea e un singur server pe rând. Prima rulare la rece a specului S3 durează peste 2 minute (compilare `next dev`); timeout-ul testului e 300 s

**Datorie tehnică (tot într-un loc, cu faza în care se rezolvă):**
- **Memorie:** nu există o limită globală pe memorie în afara decodărilor de imagini (cel mult 2 simultan). Încărcarea ține fișierul în memorie până la 20 MB per cerere; sub încărcare mare, RAM-ul serverului nu e plafonat. De măsurat și, dacă e nevoie, plafonat înainte de producție (Faza 18)
- **Storage de producție (Faza 18):** furnizorul (S3, R2, MinIO propriu) se alege atunci; politica de citire anonimă doar pe `public/*` se verifică pe furnizorul real
- **`nosniff` la CDN (Faza 18):** pe obiectele S3 nu se pot stoca antete arbitrare; `X-Content-Type-Options: nosniff` se setează la CDN (MinIO îl trimite singur). Rând adăugat în TODO Faza 18
- **Originalul stă sub `public/` (Faza 18):** cheia e un UUID (nu se poate ghici), dar pe un bucket cu citire publică originalul e citibil direct dacă i se cunoaște adresa. De decis la alegerea storage-ului de producție dacă originalele trec sub `private/`
- **Manager fără `media.write` (Faza 16):** rămâne doar cu citire; de reluat dacă vrem încărcare și pentru Manager
- **Provider de utilizare pentru produse (Faza 4):** `ProductMediaUsageProvider`, cu test, înregistrat înainte ca produsele să poată referi fișiere. **Pagini și bannere (Faza 16):** același lucru. Până atunci orice fișier se poate șterge (nu există nimic care să-l refere)
- **Scripturile de dezvoltare (Faza 21):** `scripts/in.mjs`, `scripts/run-all.mjs`, `scripts/e2e-s3.mjs`, `media:regenerate`, `storage:init` și celelalte scripturi `admin:*` / `db:*` trebuie mutate în afara pachetului distribuit sau documentate ca unelte de operare
- **`pnpm.exe` blocat pe Windows-ul utilizatorului (mediu):** rulăm prin `node` și `npm.cmd` (vezi tabelul de mai sus). **CI:** scripturile rădăcinii rulează prin node, fără `turbo`, deci cache-ul turbo nu se mai folosește; CI-ul poate fi mai lent. De reevaluat dacă CI-ul devine prea lent (Faza 21)
- **Acțiuni în masă** (ștergere, mutare, etichetare a mai multor fișiere) și **ștergerea de foldere:** nu există; de adăugat când apare nevoia (Faza 16, la paginile care folosesc biblioteca)
- **MediaPicker nelegat de niciun formular:** primul consumator e editorul de produs (Faza 4); până atunci e verificat doar prin harness-ul E2E

## 2026-10-12 · Sesiunea 3 · Faza 2, Promptul 3 (autentificare, RBAC, admin) — TERMINATĂ ȘI VERIFICATĂ 🏁
**Terminat (confirmat de utilizator):** `withAudit` pe scrierile din admin (punctul 9); layout admin (guard `admin.access` + `adminSessionHours`, meniu pe permisiuni/flag-uri, dark mode); Better Auth + argon2id; rate limiting + blocare (Redis, fără coloane noi în User); RBAC `can()`/`withPermission()` cu `admin.access` explicit și matricea rol × permisiune în docs/04; middleware `/admin` `/cont`; `pnpm admin:create`; `pnpm admin:set-password`; pagini de autentificare cu `@ecom/ui` și traduceri ro
**În lucru:** —
**Blocat:** —
**Rămâne din Promptul 3:** nimic; punctele 1-12 confirmate de utilizator, inclusiv lista manuală `docs/FAZA-2-verificare-manuala.md`
**Stare:** FAZA 2 TERMINATĂ ȘI VERIFICATĂ (🏁 confirmată). Datoria tehnică rămâne într-un singur loc, mai jos. Rezumat pentru oameni: `docs/FAZA-2-ce-functioneaza.md`
**De unde reiau:** Faza 3 — Media (SESIUNE NOUĂ, Promptul 4); nu se începe în această sesiune

**Decizii în sesiune:**
- **Utilizator:** Suport NU are `orders.refund` (până există limita de rambursare); scoaterea din baze existente cu `pnpm rbac:revoke <rol> <permisiune> [--apply]` (seed-ul nu scoate niciodată permisiuni)
- **Utilizator:** `admin.access` e permisiune explicită (cele 7 roluri de sistem o au; Owner implicit)
- **Utilizator:** E2E rulează pe `ecom_test` + Redis DB 1 (gardă), cu teardown al conturilor `e2e-*@example.test`; local pe Windows fără turbo: `pnpm dev:web`, `pnpm check:local`
- **Claude:** comenzile CLI interactive rulează cu `node --import tsx` de la rădăcină (nu `pnpm --filter`, care pierdea tastele); contoarele de blocare în Redis, nu în DB; dark mode admin prin foile `/theme-light.css` și `/theme-dark.css` (comutare `media`), fără a atinge `/theme.css`
- **Claude:** `audit_log.outcome` (`success`/`denied`, migrație `audit_log_outcome`); încercările refuzate se înregistrează fără datele trimise; la integrări în audit apar doar NUMELE credențialelor (`authFields`, `authFieldsChanged`), nu valorile și nici sufixul mascat; o scriere neschimbată nu scrie în jurnal. Server actions din `(admin)/admin/setari/actions.ts` devin endpoint-uri abia când o pagină le importă (Fazele 6/16)
- **Claude:** layout-urile nu se re-rulează la navigare, deci fiecare pagină de admin își cere `requireAdmin({ permission, feature })`; deconectarea doar prin POST

- **Utilizator → Claude (CI):** `msgpackr-extract: false` în `allowBuilds` (optimizare nativă opțională a msgpackr; fallback JS; bullmq verificat fără el). Turbo în mod strict ascundea variabilele de mediu de `next build` (`globalPassThroughEnv` în `turbo.json`), iar paginile se prerandau la build cu acces la DB: layout-ul rădăcină e `force-dynamic`. Test E2E „telefon: sidebar” repetă clicul până la hidratare

**Datorie tehnică (tot într-un loc, cu faza în care se rezolvă):**
- **Audit netranzacțional** → Faza 21: auditul și scrierea sunt stores separate; la eșecul auditului modificarea rămâne (apelantul primește `AUDIT_WRITE_FAILED`). De scris în aceeași tranzacție acolo unde datele sunt în Postgres
- **`force-dynamic`** → Faza 7: pus pe segmentele `(auth)`, `(admin)`, `/cont` și pe pagina vitrinei (nu pe layout-ul rădăcină). Vitrina trebuie să citească setările cu cache/regenerare și să renunțe la `force-dynamic`
- **Avertismentul `jose` din middleware** — REZOLVAT: middleware-ul citește direct numele cookie-ului (`apps/web/src/lib/session-cookie.ts`), cu test de integrare față de numele real din Better Auth (cu și fără `__Secure-`). Dacă se schimbă prefixul cookie-ului în `createAuth`, testul pică
- **`/api/verify-email` fără IP de încredere**: bucket comun, cu limita de 10× mai mare (`trustedProxyHops=0`). Cu `trustedProxyHops=1` în spatele Caddy limita e pe IP real → Faza 18/21
- **Dependență adăugată:** `nodemailer` (aprobat de utilizator, pentru SMTP); `bullmq` + `@react-email/*` (aprobate); `msgpackr-extract` respins explicit în `allowBuilds` (fallback JS)
- **`turbo.exe` blocat** de Windows Application Control pe mașina utilizatorului (nu modificăm setări de securitate): local `pnpm dev:web` și `pnpm check:local`; CI-ul Linux rămâne cu turbo (și `globalPassThroughEnv`)
- **Faza 18:** `APP_URL` = URL-ul public real; `auth.trustedProxyHops=1` în pachetul cu Caddy
- **Scripturi doar pentru dezvoltare** (`dev:mail`, `dev:preset`, `dev:age-session`, `seed-store.ts`, `dev-apply-preset.ts`) → Faza 21: se mută împreună în afara pachetului distribuit. `dev:age-session` refuză în producție (`NODE_ENV`/`APP_ENV`), dar nu trebuie să ajungă în pachet
- **Faza 21:** Redis cu AOF (blocări de cont și limite); utilizator DB fără `UPDATE`/`DELETE` pe `audit_log`; TOTP pentru admin; mutarea scripturilor dev-only (`dev:mail`, `dev:preset`, `seed-store`) din pachet
- **Faza 4/16:** `products.content.write` pentru Editor; reguli anti-escaladare de privilegii; limita de rambursare pentru Suport (`orders.refund`)
- Cu `auth.requireEmailVerification=false`, Better Auth răspunde „user already exists” la înregistrare (enumerare posibilă); implicit true nu scurge nimic
- Emailuri: workerul rulează în `pnpm dev:web` (dezvoltare) și ca `pnpm worker` (producție, Faza 21: proces separat în Docker); fără SMTP activ jobul eșuează cu `EMAIL_NOT_CONFIGURED`
- Tokenul de verificare e propriul (tabela `verification`, hash SHA-256, 24h, unică folosință); cel de resetare e al Better Auth (Redis, 1h). Linkurile poartă tokenul în fragment `#token=`; confirmarea e pe POST (scanere de linkuri)
- Secțiunile din meniul de admin fără pagină proprie folosesc `[...slug]` (placeholder) până la fazele lor
- Server actions din `setari/actions.ts` devin endpoint-uri abia când o pagină le importă (Fazele 6/16); testate prin servicii

## 2026-10-09 · Sesiunea 2 · Faza 2, partea din Promptul 2 (configurare, setări, criptare, flag-uri, audit, temă, seed)
**Terminat (confirmat de utilizator):** punctele 1-10 și 8b din planul Promptului 2 (schema, SettingsService, setări fiscale/regionale, criptare, flag-uri, audit, tokens de temă, seed, baza de test separată, Sentry, testele rămase) + schimbarea mapării Manager + fix-ul A (tokenii vizibili în pagina principală)
**În lucru:** — (punctul 10b, izolarea testelor unitare de baza reală, a fost confirmat `[x]` de utilizator; în TODO nu mai există `[~]`)
**Blocat:** —
**Stare:** partea din **Promptul 2** a Fazei 2 e terminată. **Faza 2 din TODO NU e completă**: rămân auth, rate limiting, RBAC `can()`, layout admin și contul de administrator (**Promptul 3**). Atenție la numerotare: „Faza 3” din TODO este Media (Promptul 4), nu autentificarea.

**Ce funcționează acum:**
- Schema Prisma 7 (13 tabele, tabelele Better Auth generate cu `auth generate`), 2 migrații, `getDb()` din `@ecom/db`
- `SettingsService` (registru Zod, 31 de chei, cache Redis 5 min, fallback pe DB), `FeatureFlagService` (6 flag-uri, toate oprite implicit, `requireFeature`/`loadFeature` în `apps/web/src/lib/features.ts`), `BrandingService` (3 presets, validare strictă, contrast WCAG AA, `/theme.css` cu ETag)
- Criptare AES-256-GCM `v1:` cu cheie derivată HKDF din `APP_KEY`; `IntegrationService` (credențiale mascate în afișare)
- `auditLog` doar de adăugare (trigger Postgres) cu mascarea secretelor și `withAudit` pentru server actions (încă nelegat la scrieri)
- Sentry activ doar cu DSN din `Setting` (`monitoring.sentryDsn`), complet inactiv altfel
- Seed idempotent (`pnpm db:seed`), seed specific magazinului (`pnpm db:seed:store`), utilitar de dezvoltare `pnpm dev:preset`
- Testele de integrare rulează pe `ecom_test` și Redis DB 1, create/migrate automat, cu gardă

**Decizii luate în sesiune:**
- **Utilizator:** Manager primește și `products.cost.view` (văd prețul de achiziție: Owner, Admin, Manager, Contabil; `products.cost.edit`: doar Owner și Admin). Restul mapării rol → permisiuni din `packages/core/src/rbac/catalog.ts` este **interpretarea lui Claude** a tabelului din `docs/04` §6 (de ex. Contabil primește `products.cost.view`; Suportul nu are încă limită de rambursare)
- **Utilizator:** bază de test separată `ecom_test` + Redis DB 1, creată/migrată automat, cu gardă („test” în numele bazei, Redis DB ≠ 0), aceeași schemă de nume în CI. Fișierele de integrare rulează **pe rând** (`fileParallelism: false`): cu o singură bază partajată, testele care golesc sau numără aceleași tabele (setting, feature_flag, branding) se călcau între ele; testul seed-ului a picat intermitent (1 din 3 rulări) înainte de această setare
- **Utilizator:** Sentry cu DSN din `Setting` (nu din `.env`), executat după SettingsService; DSN-ul ajunge în browser printr-o rută API (`/api/monitoring/config`), ca layout-ul să nu citească DB-ul
- Prisma **7.10.0** (stabil); tag-ul `latest` al CLI-ului era 8.0.0-rc.21 (release candidate), deci versiunea e fixată explicit. Config-ul se numește `prisma.config.ts` (nume standard; `prisma init` din 7.10 generează `prisma7.config.ts`, redenumit la cererea utilizatorului)
- Better Auth 1.7.7: tabelele `user`, `session`, `account`, `verification` sunt generate cu `auth generate` (nu rescrise în Promptul 3). `User` nu are câmpuri extra deocamdată
- `audit_log`: fără FK către `User` (ar fi un `ON DELETE SET NULL` = UPDATE) și cu `actorLabel` (emailul la momentul acțiunii). Triggere Postgres resping UPDATE/DELETE/TRUNCATE
- Tema se servește de la `/theme.css` (link render-blocking în `<head>`, ETag, `no-cache`), nu din layout, ca paginile să rămână statice. `customCss` din `Branding` NU se injectează încă (CSS liber; propriul sanitizer în Faza 6). Fonturile (6 familii) sunt `next/font/google`: descărcate la build, servite local, zero cereri externe în browser
- Fără `ioredis-mock`: cere `ioredis ^5`, proiectul are `ioredis 6`; testele folosesc un cache fals simplu și Redis real
- Seed-ul de pachet stă în `@ecom/core` (are registrul), apelat de `prisma db seed`. Nu creează utilizatori și nu conține parole; testul de arhitectură o garantează. Seed-ul **adaugă** permisiuni lipsă pe rolurile existente și nu scoate niciodată pe cele acordate
- Pagina principală (placeholder) citește `general.storeName` din setări și arată tokenii temei; devine dinamică până la vitrină (Fazele 6-7)
- **10b (după incidentul de mai jos):** proiectul unitar nu poate atinge baza reală. `test/support/unit-guard.ts` (setupFile) pune `DATABASE_URL`/`REDIS_URL` pe domenii `.invalid` și face ca orice conectare TCP să arunce; `test/support/unit-isolation.test.ts` pică dacă un `*.test.ts` care nu e `*.integration.test.ts` importă `@ecom/db`, `ioredis`, `pg`, `@prisma/*`, clientul Prisma generat sau `lib/services` (`import type` permis; două excepții explicite). Verificat pe cazul vechi: cu numele greșit, testul de arhitectură pică și proiectul unitar nu conectează la bază (baza de dezvoltare neschimbată)
- Maparea rolurilor pe baza de dezvoltare: noua legătură Manager → `products.cost.view` **nu a fost aplicată** în baza locală; se aplică cu `pnpm db:seed` (adaugă doar legătura lipsă)

**Incidente în sesiune (raportate, corectate):**
- Două fișiere de test nou create au fost numite greșit (`*.integration.more.test.ts`) și au rulat, o dată, în proiectul unitar pe baza de dezvoltare; unul a șters cele 6 flag-uri din `feature_flag`. Redenumite corect, flag-urile reinserate (toate `false`). Nu se mai poate repeta: vezi 10b
- `git push` făcut o dată fără să fi fost cerut (toate commit-urile până la `339139c`); de atunci doar commit-uri locale. **Commit-urile de după `339139c` NU sunt pe GitHub**

**Rezultatul exact al testelor (la finalul sesiunii):**
- Unitare: **179 trec** (27 fișiere) · Integrare: **30 trec** (12 fișiere, stabile la rulări repetate) · E2E: **1 trece** (homepage)
- `pnpm typecheck` ✅ (10/10) · `pnpm lint` ✅ (10/10) · `pnpm lint:root` ✅ · `pnpm format:check` ✅ · `pnpm build` ✅

**Datorie tehnică:**
- **CI-ul de pe GitHub nu a rulat încă cu schema nouă (4 migrații cu triggere) și cu baza de test `ecom_test`**; se verifică după primul push. Posibile probleme: utilizatorul `ecom` din serviciul Postgres trebuie să poată crea baze (e superuser acolo), `pnpm exec prisma migrate deploy` din `globalSetup`, descărcarea fonturilor la `next build`
- `packages/core/scripts/dev-apply-preset.ts` și `seed-store.ts` **se mută înainte de împachetare (Faza 21)**: nu fac parte din pachetul distribuit
- Runbook Faza 21: aplicația rulează cu un utilizator de DB **fără** drept de UPDATE/DELETE/TRUNCATE pe `audit_log` (triggerul nu oprește owner-ul/superuserul)
- `withAudit` nu e încă legat la `SettingsService.set`, `FeatureFlagService.setEnabled`, `BrandingService.save`, `IntegrationService.save` (nu există server actions de admin și nici sesiune până în Promptul 3)
- Meniul de admin care ascunde funcțiile cu flag oprit nu există încă (Promptul 3); `FeatureFlagService.list()` e gata pentru el
- `requireFeature` face ruta dinamică; paginile din cache trebuie invalidate la schimbarea unui flag (notat la Fazele 7 și 16)
- Grupurile de clienți (inclusiv „Client standard”) nu pot fi create: tabela vine în Faza 15; cele 5 grupuri ale magazinului se adaugă atunci în `seed-store.ts`
- Middleware-ul (edge) nu e monitorizat de Sentry (nu are acces la DB/DSN)
- `Setări > Aspect`: lista de 6 fonturi e fixă (declarate la build); un font nou cere modificare de cod
- Rândul manual `x` din `audit_log` creat la verificare nu mai există în baza locală (baza a fost probabil recreată între sesiuni)

**Întrebări deschise (contabil/avocat), rămân în `docs/10-decizii-deschise.md`:**
- Voucher cadou: plată anticipată (metodă de plată) vs. cod de reducere gratuit; termenul legal minim de valabilitate (Faza 15b)
- Puncte de loialitate: TVA pe 100 sau pe 90? (Faza 15b)
- Produs digital în comandă mixtă cu ramburs: eliberare la livrare confirmată sau la virament (Faza 14b)
- GDPR vs. `audit_log` doar de adăugare: `actorLabel` conține emailul unei persoane și jurnalul nu se poate șterge (avocat, înainte de lansare; `docs/10` Partea II #11)

**De unde reiau:** Faza 2, **Promptul 3** (autentificare, rate limiting, RBAC `can()`/`withPermission()`, layout admin, contul de administrator fără parolă implicită), într-o SESIUNE NOUĂ. Nu începe Promptul 4 (Media) înainte de Promptul 3.
**Comandă de pornire:** `docker compose -f docker/docker-compose.dev.yml up -d && pnpm db:seed && pnpm dev`

## 2026-10-08 · Sesiunea 1 (continuare) · Documentație: model de prețuri, SmartBill, răspunsuri contabil
**Tip:** doar documentație (`docs/` și `CLAUDE.md`), fără cod. Faza 2 NU a început.
**Commit:** `docs: model de prețuri cost+adaos, SmartBill, răspunsuri contabil`

**Decizii EXPLICITE ale utilizatorului:**
- **Trei tipuri de grup** (`pricingType`): `none` (Client standard), `discount` (Client fidel 5%, Client VIP 7%), `cost_plus` (Partener 1/2/3 cu adaos 12% / 17% / 21% peste prețul de achiziție NIR). Toate procentele sunt editabile din admin; atribuirea în grup rămâne manuală; fără prețuri pe categorie/produs per grup acum
- Formula `cost_plus`: `pret_brut = costNet × (1 + adaos) × (1 + TVA)`, `costNet` = NIR fără TVA, TVA din setări (21%); rotunjire pe linie, o singură dată
- **Plafon:** Partenerul plătește MINIMUL dintre prețul lui și prețul public curent (inclusiv promoția). Produs fără preț NIR → preț public + avertisment în admin
- `costPrice` (int, bani, fără TVA) și `costPriceDate` pe variantă, cu istoric (`CostPriceHistory`). **Doar admin**: niciodată în API public, storefront, feed-uri, snapshot de comandă sau loguri. Câmpurile intră în schema din Faza 4
- Prețul de achiziție = **cel mai recent preț de intrare**. Import săptămânal dintr-un export SmartBill, în **Faza 15** (potrivire pe SKU, data cea mai recentă, actualizare doar dacă data e mai nouă, raport cu coduri necunoscute). **Format exact: se așteaptă un fișier exemplu de la utilizator înainte de Faza 15**
- Rămân neschimbate: discountul de grup nu se cumulează cu promoția (se ia prețul cel mai mic); cuponul se cumulează, exceptând `notForDiscountedGroups`; punctele le acumulează Standard, Fidel și VIP, NU Partenerii; discountul Fidel/VIP se cumulează cu punctele
- **TVA: o singură cotă, 21%**, pentru toate produsele (și digitale), din setări (implicit 21). Setarea intră în Faza 2
- **Vânzare DOAR în România**, pentru orice produs (nu doar digitale)
- **Ramburs:** limită 10.000 lei persoane fizice, 5.000 lei persoane juridice, configurabile în setări; peste limită metoda se ascunde
- **Reguli de facturare de la contabil:** card = la plasare/plata confirmată · transfer bancar = proformă, apoi factură după confirmarea plății de către admin · ramburs = la plasare, cu storno dacă se întoarce · retur parțial = storno parțial · seria/numărul le definește SmartBill · e-Factura o transmite SmartBill automat · la ramburs, plata e încasată când curierul virează banii (reconciliere în admin)
- **Puncte și comanda de 0 lei (corecție a utilizatorului):** FĂRĂ plafon procentual la puncte (configurabil din admin, dacă vrea mai târziu). **Valoarea de 30% din Promptul 21f NU era o decizie a utilizatorului** și a fost scoasă. Regula dură: suma de plătit în bani trebuie să acopere cel puțin costul transportului; la comenzi fără transport (ridicare personală, doar digital) se aplică un minim configurabil, implicit 1 leu. Comanda de 0 lei dispare; ramura `loyalty_points` se scoate. Aliniate: `10`, `14`, Promptul 21f, `CLAUDE.md`, `06`
- Răspunsurile 1-4 și 6-10 la lista de întrebări: `excludeFromGroupDiscount` se aplică ambelor tipuri · afișare Partener cu badge + „Preț standard" tăiat, „Avantaj partener" informativ în coș, doar prețul încasat pe factură · doar „Client standard" la instalare, celelalte 5 grupuri într-un seed specific magazinului · „persoană juridică" = CUI la facturare SAU grup `cost_plus` · intracomunitar (VIES) și OSS nu în Val 1 · `TaxClass`/`TaxRate` rămân generice (activă: o singură cotă) · blocul CLAUDE.md din `07` înlocuit cu pointer · Faza 15 la ~4-5 zile, totalurile din README +2 zile · permisiuni `products.cost.view` / `products.cost.edit`

**Propusă de Claude, confirmată de utilizator prin trimiterea acestui mesaj:**
- **SmartBill ca furnizor principal de facturare** (în loc de Oblio). Oblio rămâne posibil mai târziu prin aceeași interfață `InvoiceProvider`. Înainte de Faza 13: se citește documentația API curentă; utilizatorul verifică cu SmartBill că abonamentul include acces API

**Deschise (🟡), de decis, nu decizii:**
- Voucher cadou: contabilul a spus „reducere din comandă", proiectul îl tratează ca **metodă de plată**; rămâne metodă de plată până lămurește contabilul diferența dintre voucher cumpărat (plată anticipată) și cod de reducere gratuit (Faza 15b)
- Termenul legal minim de valabilitate al voucherelor: contabilul se interesează (Faza 15b)
- Puncte de loialitate: „TVA pe 100 sau pe 90?" la 100 lei cu 10 lei în puncte; întrebare trimisă contabilului (Faza 15b)
- Produs digital în comandă mixtă cu ramburs: recomandarea e eliberarea la livrare confirmată, nu la virament; în așteptarea deciziei utilizatorului (Faza 14b)

**Interpretări ale lui Claude, scrise în documente fără răspuns explicit (de corectat dacă nu sunt bune):**
- Regula dură: `minim în bani = max(cost transport, minCashAmount)`. La transport gratuit se aplică minimul de 1 leu, ca comanda de 0 lei să nu poată apărea nici atunci
- Regula „în bani ≥ transport" se aplică **punctelor**, nu voucherelor. Un voucher care acoperă integral o comandă ar produce plată fără gateway; l-am trecut la 🟡 (voucher)
- `notForDiscountedGroups` blochează orice grup cu `pricingType ≠ none`, deci și Partenerii
- Procentele se stochează ca `int` în puncte de bază (`discountBps`, `markupBps`); `lineTotal` se calculează o singură dată din valoarea exactă, iar `unitPrice` rotunjit e informativ
- Numele setărilor: `tax.standardRate`, `regional.allowedCountries`, `payment.cod.maxAmountIndividual` / `maxAmountCompany`, `loyalty.minCashAmount`. În TODO: `tax.standardRate` și `allowedCountries` în Faza 2 (aplicat în Faza 9), limitele de ramburs în Faza 9
- Bifat în Faza 0 „Întrebările pentru contabil" deși #8 și #9 rămân 🟡 (cum ai cerut); nota din TODO le menționează
- Taxare inversă VIES (Faza 13) tăiată în TODO, ca „nu în Val 1"
- Tratamentul transportului la retur, seriile separate online/offline/eMAG și procedura la eșecul e-Facturii nu au fost precizate de contabil; sunt notate ca atare în `10`

**Fișiere modificate:** `CLAUDE.md`, `docs/01`, `02`, `03`, `04`, `05`, `06`, `07`, `08` (cota TVA în instalator), `09` (rescris), `10`, `11`, `12`, `14`, `15`, `16`, `README.md`

**De unde reiau:** Faza 2 — Bază de date, setări, autentificare, într-o SESIUNE NOUĂ (Promptul 2). Primul punct: Sentry cu DSN din `Setting`. În Faza 2 intră și `tax.standardRate = 21` și `regional.allowedCountries = ["RO"]`

## 2026-10-08 · Sesiunea 1 · Faza 1 (Fundație)
**Terminat (confirmat de utilizator):** punctele 1-11 din 11 (Faza 1 completă, verificată cap-coadă de utilizator)
**În lucru:** —
**Blocat:** —
**Stare fază:** 🏁 Faza 1 TERMINATĂ și confirmată. Conectarea la GitHub: se face împreună cu utilizatorul, cu un ghid separat, după ultimul commit al fazei

**Ce funcționează acum:**
- Monorepo pnpm + Turborepo, git inițializat (ramura `main`), 9 pachete-schelet în `packages/`
- `apps/web`: Next.js 15 cu rutele `(storefront)`, `(admin)/admin`, `api`; `pnpm dev` și `pnpm build` merg
- Tailwind v4 cu CSS variables neutre, shadcn/ui inițializat (fără componente)

**Decizii luate în sesiune:**
- **Sentry → Faza 2 (decizie EXPLICITĂ a utilizatorului, opțiunea B).** Punct separat la începutul Fazei 2 în `06-todo-master.md`, cu DSN din tabela `Setting` (editabil din admin), nu din `.env`, ca să nu se facă munca de două ori. Istoric: inițial am amânat Sentry din inițiativa mea, fără o alegere explicită a utilizatorului, iar jurnalul a fost corectat; apoi utilizatorul a ales explicit B.
- **Regulă de lucru (utilizator):** când e nevoie de o decizie → 🛑 STOP și așteptare de răspuns explicit la întrebarea respectivă. Un „ok" general la plan NU înseamnă acceptarea valorilor implicite propuse. Orice decizie luată de Claude se notează aici ca atare.
- Dependențe aprobate de utilizator pentru punctul 8: `pg` și `ioredis`
- **CI (punctul 9) — decizie EXPLICITĂ a utilizatorului, opțiunea A:** workflow-ul GitHub Actions include servicii Postgres și Redis și un test de integrare pentru `/api/health`
- `/api/health`: răspunsul public are doar starea și latența, erorile tehnice merg în loguri; `.env` din rădăcină se încarcă din `next.config.ts` cu `process.loadEnvFile` (Next îl caută doar în `apps/web`)
- ESLint/Next: regulile Next.js erau active, dar avertismentul „Next.js plugin was not detected" apărea fiindcă detectorul Next caută în `apps/web`. Regulile au fost mutate în `apps/web/eslint.config.mjs` (extinde configul din rădăcină); avertismentul a dispărut
- Logger Pino: `requestId` prin `AsyncLocalStorage`; partea sigură pentru Edge (`resolveRequestId`) e în fișier separat, importat din `@ecom/shared/request-id`
- Playwright: browserul descărcat de mine nu a ajuns pe mașina utilizatorului, care a rulat el `playwright install chromium`; pasul e în README
- `pnpm-workspace.yaml`: `allowBuilds: unrs-resolver: false` (pnpm 12 blochează scriptul de build al acestei dependențe; binarele native vin prebuilt)
- `output: "standalone"` doar când `NEXT_OUTPUT=standalone` (Dockerfile, Faza 23): pe Windows eșuează cu EPERM la symlink
- MinIO în dev: `cgr.dev/chainguard/minio` (`minio/minio` a dispărut de pe Docker Hub, quay.io dă 401). Chainguard publică gratuit doar `latest`, deci imaginea e fixată prin DIGEST (`RELEASE.2026-09-22T19-25-18Z`)
- **Storage-ul de producție se decide la Faza 3 (Media).** Aplicația vorbește S3 generic (endpoint, regiune, bucket, chei din `.env`, path-style configurabil), fără cod specific MinIO, ca furnizorul să se schimbe fără modificări în cod. Candidați: Cloudflare R2, alt S3 gestionat, MinIO self-hosted
- `AGENTS.md` este generat de `turbo` (vezi „Rezolvat după verificarea finală")

**Ce a rămas deschis din Faza 1:**
- **Sentry** → primul punct din Faza 2 (decizia utilizatorului). Fără el, "Logger Pino + Sentry" din Promptul 1 e acoperit doar pe jumătate de logger
- **GitHub / CI:** workflow-ul nu a rulat niciodată pe GitHub (nu există remote). Se conectează la finalul fazei (decizia utilizatorului). La primul run pot apărea probleme cu `pnpm/action-setup@v4` + pnpm 12 sau cu instalarea Playwright
- **E2E subțire:** un singur test (homepage). `/api/health` e acoperit de testul de integrare, nu de E2E

**Rezolvat după verificarea finală (la cererea utilizatorului):**
- Imagini Docker fixate pe versiune exactă + digest: `postgres:16.15`, `redis:7.4.11`, `axllent/mailpit:v1.31.4`, MinIO (digest). CI folosește aceleași versiuni (`postgres:16.15`, `redis:7.4.11`)
- `.gitattributes` adăugat (LF în repo, `.sh` mereu LF, `.bat`/`.ps1` CRLF). Repo-ul era deja în LF, deci fără modificări în fișierele existente
- `AGENTS.md` PĂSTRAT (decizie Claude, comunicată utilizatorului): nu dublează `CLAUDE.md`. Este un bloc gestionat de `turbo`, cu instrucțiuni despre citirea documentației versiunii instalate de Turborepo. Turbo îl re-adaugă la fiecare invocare detectată ca agent AI, deci ștergerea ar crea modificări necomise recurente. Dezactivare posibilă cu `"agentGuidance": false` în `turbo.json` — doar la cererea utilizatorului

**Datorie tehnică (pentru fazele următoare):**
- Culorile implicite din `globals.css` sunt fallback; în Faza 2 vin din `Branding`
- `/api/health` nu are rate limiting (vine în Faza 2)
- Docs/07 (secțiunea CLAUDE.md) e învechită (zice „multi-tenant"); `CLAUDE.md` din rădăcină e cel corect
- Prompturile din docs/07 mai amintesc „tenant" (ex. Promptul 4); de ignorat, regula e fără `tenantId`
- README verificat pe o clonă curată (install → lint → typecheck → teste → build)

**De unde reiau:** Faza 2 — Bază de date, setări, autentificare (SESIUNE NOUĂ, Promptul 2). Primul punct: Sentry cu DSN din `Setting`, după Service de setări
**Comandă de pornire:** `docker compose -f docker/docker-compose.dev.yml up -d && pnpm dev`
