# Faza 3 — ce funcționează acum (fișiere media)

Rezumat în limbaj simplu, pentru cine nu citește codul. Detaliile tehnice sunt în `PROGRESS.md`.

## Ce poate face magazinul cu fișierele

- **Încărcare de imagini.** Din `/admin/media`, tragi imaginile în pagină sau le alegi de pe calculator. Se pot
  încărca mai multe deodată (cel mult 2 simultan), fiecare cu bară de progres. Sunt acceptate JPEG, PNG, WebP și
  AVIF, până la 20 MB per fișier (limita e o setare). GIF și SVG sunt respinse.
- **Verificări la încărcare.** Tipul fișierului se stabilește din conținut, nu din extensie; imaginile
  prea mari (în pixeli) sau corupte sunt refuzate cu un mesaj clar. Fișierul se salvează curățat, fără datele
  EXIF (locul, aparatul foto), cu un nume aleatoriu: numele tău de fișier nu apare în adresă.
- **Variante.** Pentru fiecare imagine, în fundal, se fac trei mărimi (mică, medie, mare) în trei formate (AVIF,
  WebP, JPEG) și un mic „placeholder” neclar, afișat cât se încarcă poza. Până e gata, fișierul apare ca „În
  așteptare” / „Se procesează”, apoi trece singur la „Gata”, fără să reîncarci pagina.
- **Regenerare.** Dacă procesarea eșuează, fișierul apare „Eșuat”, cu motivul în cuvinte. Butonul „Regenerează
  variantele” îl pune din nou la lucru din original.
- **Biblioteca.** Grilă cu miniaturi, paginare, căutare după nume, text alternativ sau tag, filtre pe folder și
  stare. Pe fiecare fișier poți edita textul alternativ (recomandat pentru accesibilitate și SEO) și tagurile.
- **Foldere.** Creezi, redenumești și muți foldere (cel mult 5 niveluri, fără nume duplicate în același loc) și
  muți fișiere între ele.
- **Ștergere cu verificare.** Înainte de ștergere, aplicația întreabă toate „locurile de folosire” înregistrate.
  Dacă fișierul e folosit, nu se șterge și vezi unde. Altfel, ștergerea cere confirmare explicită și elimină
  rândul și toate variantele din stocare.
- **Selector pentru formulare (`MediaPicker`).** O fereastră reutilizabilă în care alegi o imagine sau mai multe
  (cu maxim configurabil, în ordinea alegerii). Arată doar fișiere gata, cu miniaturi, și întoarce formularului
  doar identificatorii. Dacă ai drept de scriere, poți încărca imagini noi chiar din ea.
- **Fișiere private cu link semnat.** Fișierele din zona privată nu se pot deschide fără un link semnat, cu
  expirare scurtă; fără semnătură valabilă sau după expirare, răspunsul e „nu există”.
- **Drepturi.** Citirea bibliotecii cere `media.read` (Owner, Admin, Manager, Editor, Depozit). Încărcarea,
  editarea, regenerarea și ștergerea cer `media.write` (Owner, Admin, Editor). Cine nu are `media.write` nu vede
  butoanele de scriere, iar serverul refuză oricum cererea. Orice scriere (și orice refuz) intră în jurnalul de
  audit.
- **Stocare.** Același cod merge pe disc local sau pe orice serviciu S3-compatibil (MinIO în dezvoltare). Fișierele
  publice se pot citi anonim doar din zona `public/`; zona `private/` nu.

## Ce NU există încă

- **Niciun formular nu folosește încă selectorul.** Primul loc unde apare e editorul de produs (Faza 4).
- **Nu există încă furnizori de „utilizare”.** Mecanismul de verificare la ștergere e gata, dar nu există nimic care
  să refere fișiere (produse: Faza 4; pagini și bannere: Faza 16). Până atunci, orice fișier se poate șterge.
- **Fără acțiuni în masă** (ștergere, mutare, etichetare a mai multor fișiere deodată).
- **Foldere: nu se pot șterge** (doar crea, redenumi, muta).
- **Managerul nu poate încărca** (are doar citire); de reluat în Faza 16.
- **Fără limită globală de memorie** în afara decodărilor de imagini (cel mult 2 deodată).
- **Storage-ul de producție** (furnizor, CDN, antetul `nosniff` la CDN) se alege în Faza 18.

## Ca să meargă local

- **Docker trebuie să ruleze** (Postgres, Redis, MinIO, Mailpit):
  `docker compose -f docker/docker-compose.dev.yml up -d`. Serviciul `minio-init` creează bucketul `ecom` și iese
  singur („Exited (0)”).
- **Bucket lipsă?** Dacă încărcarea răspunde „Stocarea fișierelor nu este disponibilă”, rulează
  `npm.cmd run storage:init` (în PowerShell; `pnpm storage:init` unde pnpm merge). Creează bucketul dacă lipsește și
  aplică citirea anonimă doar pe `public/*`. Se poate rula oricând; nu strică nimic.
- **`S3_PUBLIC_URL`** (în `.env`, în dev `http://localhost:9000/ecom`): adresa de unde browserul citește imaginile
  publice. Cu ea, imaginile vin direct din MinIO; fără ea, prin aplicație (`/media/…`).
- **Pornește aplicația cu** `npm.cmd run dev:web` (workerul de procesare imagini pornește în ea). În PowerShell
  folosește `npm.cmd`, nu `npm`, dacă politica de execuție blochează `npm.ps1`.
- **Selectorul nu are pagină proprie.** Se vede doar în testele E2E:
  `npm.cmd run test:e2e -- e2e/media-picker.spec.ts`.

## Cum verifici rapid

```bash
npm.cmd run check:local        # typecheck, lint, format, teste unitare
npm.cmd run test:integration   # Postgres + Redis + MinIO de test
npm.cmd run test:e2e           # browser, pe storage local
npm.cmd run test:e2e:s3        # încărcarea pe S3 (MinIO), cu serverul lui de test
```

Verificarea manuală cap-coadă, pas cu pas: [FAZA-3-verificare-manuala.md](FAZA-3-verificare-manuala.md).
