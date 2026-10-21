# Faza 2 — verificare manuală cap-coadă

Parcurs în browser, de la zero, pentru cine verifică Faza 2. Fiecare pas are „Aștepți” = ce trebuie să vezi.
Timp estimat: 30–40 de minute. Parolele le alegi tu la rulare; nu le scrie în fișiere sau în chat.

## 0. Pregătire (o singură dată)

```bash
docker compose -f docker/docker-compose.dev.yml up -d     # Postgres, Redis, Mailpit — toate „healthy”
pnpm db:migrate                                            # aplică migrațiile (inclusiv audit_log.outcome)
pnpm db:seed                                               # roluri, permisiuni, setări, flag-uri, branding
pnpm dev:mail                                              # SMTP către Mailpit (emailurile se văd la :8025)
pnpm dev:web                                               # aplicația (workerul de emailuri pornește în ea)
```

Aștepți: <http://localhost:3000/api/health> răspunde 200; <http://localhost:8025> arată Mailpit gol.

## 1. Contul de administrator (fără parolă implicită)

1. Într-un alt terminal: `pnpm admin:create` → introduci emailul și parola (de două ori, nu se vede la tastare).
   Parola are cel puțin 12 caractere. **Aștepți:** mesaj de reușită; o a doua rulare refuză (există deja un Owner).
2. <http://localhost:3000/admin> fără sesiune. **Aștepți:** redirect la `/autentificare?next=%2Fadmin`.
3. Autentifică-te cu contul creat. **Aștepți:** „Panou de control”, meniu lateral complet (Owner), calea de
   navigare (breadcrumbs) sus.
4. Meniul utilizatorului → „Întunecat”, reîncarcă. **Aștepți:** tema rămâne; fără erori în consola browserului.
5. Meniul utilizatorului → „Deconectare”. **Aștepți:** ajungi la `/autentificare`; `/admin` te trimite din nou la
   autentificare.

## 2. Înregistrare client + confirmare email

1. `/inregistrare`: nume, email, parolă nouă (încearcă una de 5 caractere: **aștepți** eroare în română).
2. Cu parolă bună: **aștepți** mesajul „Verifică-ți emailul”.
3. Încearcă să te autentifici imediat. **Aștepți:** „Emailul nu este verificat”.
4. Mailpit (<http://localhost:8025>): deschide mesajul „Confirmă adresa de email”, urmează linkul, apasă butonul.
   **Aștepți:** „Email verificat”. Linkul folosit a doua oară: **aștepți** „expirat sau a fost deja folosit”.
5. Autentifică-te. **Aștepți:** ajungi în `/cont`. `/admin` arată „Acces interzis” (e doar client).

## 3. Protecții la autentificare

*(Pașii 1–3 au fost rescriși după Blocul C din Faza 4: vezi `docs/FAZA-2-ce-functioneaza.md`, secțiunea
„Blocarea la autentificare”. Numărul de greșeli și durata depind de `auth.trustedProxyHops`.)*

1. **Blocarea după parole greșite.** Introdu parole greșite pentru același email, una după alta; la fiecare
   **aștepți** „Email sau parolă incorecte.” Continuă până la blocare:
   - cu `trustedProxyHops = 0` (implicit pe calculatorul de dezvoltare): după **15** greșeli, blocare de cel mult **1
     minut**;
   - cu `trustedProxyHops = 1` (în spatele unui proxy): după **5** greșeli, blocare de **15 minute**, care se dublează
     la blocări repetate în 24 de ore.

   **Aștepți:** „Prea multe încercări. Poți încerca din nou peste N minut(e).” Cât durează blocarea, și parola
   corectă primește același mesaj.
2. **Nu există blocare globală pe email.** Un alt email (de exemplu Owner-ul) se poate autentifica imediat, în timp ce
   emailul greșit e blocat. Cinci conectări **reușite** la rând nu blochează nimic (se numără doar greșelile).
   Faptul că greșelile de la adrese diferite nu blochează contul nu se poate simula local (o singură adresă); e acoperit
   de teste automate.
3. `pnpm admin:unlock <email>` → **aștepți** „Contul … a fost deblocat”; te poți autentifica imediat.
4. Parolă greșită pentru un email care nu există: **aștepți** exact același mesaj ca pentru unul existent.

## 4. Resetarea parolei

1. `/recuperare-parola` cu emailul clientului. **Aștepți:** mesaj neutru (același și pentru un email inexistent).
2. Mailpit: mesajul „Resetarea parolei – …”, urmează linkul (tokenul e în fragmentul `#token=…`, nu în query).
3. Setează o parolă nouă. **Aștepți:** reușită; sesiunile vechi sunt închise; autentificarea merge cu parola nouă
   și nu mai merge cu cea veche. Linkul a doua oară: **aștepți** mesaj de link expirat/folosit.

## 5. Roluri: ce poate vedea Suportul

1. Atribuie rolul „support” clientului: `pnpm db:studio` → tabela `user_role` → rând nou cu `userId` al clientului
   și `roleId` al rolului cu cheia `support` (tabela `role`).
2. Reîncarcă `/admin` în sesiunea clientului. **Aștepți:** panoul se deschide; meniul arată „Comenzi”, dar nu
   „Produse”, „Setări”, „Utilizatori și roluri”, „Jurnal de audit”.
3. Deschide manual `/admin/produse`. **Aștepți:** redirect la `/admin/acces-interzis` cu „Nu ai permisiunea
   necesară pentru această secțiune.”
4. Șterge rândul din `user_role`, reîncarcă. **Aștepți:** „Acces interzis” (retragerea se aplică imediat).

## 6. Expirarea sesiunii de admin

1. Autentifică-te ca Owner (pas 1) și deschide `/admin`.
2. În terminal: `pnpm dev:age-session <email-owner> 9` (limita implicită e 8 ore).
3. Reîncarcă `/admin`. **Aștepți:** `/autentificare?sesiune=expirata&next=%2Fadmin` cu „Sesiunea a expirat.
   Autentifică-te din nou.”; după autentificare ajungi înapoi în `/admin`.

## 7. Flag-uri și jurnal de audit

1. Flag-urile sunt oprite în seed. `pnpm db:studio` → `feature_flag` → pornește `blog` (și șterge cheia
   `ecom:feature-flags:v1` din Redis sau așteaptă expirarea cache-ului). **Aștepți:** meniul de admin arată „Blog”;
   oprit din nou, intrarea dispare, iar ruta dă 404.
2. `audit_log` (db:studio): rândurile create de `admin:create` și `admin:unlock` au actorul `cli:…`. Încearcă să
   modifici sau să ștergi un rând din `audit_log` (SQL direct): **aștepți** eroare de la trigger (tabela e
   doar de adăugare).
3. Cheile `outcome` sunt `success` sau `denied`; nicio parolă, token sau cheie de integrare nu apare în `before`/`after`.

## 8. Tastatură și telefon

1. În admin, Tab de la începutul paginii: primul element focusat e „Sari la conținut”. Meniul utilizatorului se
   deschide cu Enter și se închide cu Escape.
2. Fereastră îngustă (375 px): sidebar-ul e ascuns, se deschide din buton, Escape îl închide; fără scroll orizontal.

## Dacă ceva nu iese

- Emailul nu apare în Mailpit: rulează `pnpm dev:mail` și verifică dacă `pnpm dev:web` (nu doar `pnpm dev`) e pornit.
- „Prea multe încercări” la tine, în timp ce testezi: expiră singură (cel mult 1 minut cu `trustedProxyHops = 0`, 15 minute
  cu 1) sau o ștergi cu `pnpm admin:unlock <email>`.
- Pe Windows cu turbo blocat folosește `pnpm dev:web`, nu `pnpm dev`.
