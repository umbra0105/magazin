# Finisaje și probleme deschise (mod autonom)

Lista acumulată în timpul unei faze autonome (`docs/20-mod-autonom.md` §2 și §8): **S3** (aspect, text, aliniere, finisaje) se notează aici, într-o linie, iar lucrul continuă. Se rezolvă într-o trecere separată, la final de fază sau înainte de lansare. **S1** și **S2** nu se notează aici ca să fie amânate: S1 oprește lucrul (🛑), S2 se repară pe loc; o intrare S1 sau S2 deschisă aici blochează poarta de îmbinare.

## Format

O intrare e o linie care începe cu căsuța de stare, apoi severitatea ca prim cuvânt, apoi câmpurile separate prin `|`:

```
- [ ] S3 | ecran | ce nu e în regulă | captură (cale sau nume)
- [x] S3 | ecran | ce a fost în regulă după repară | captură
```

- `[ ]` = deschisă, `[x]` = rezolvată. Orice altă căsuță (`[~]`, `[!]`) se socotește deschisă.
- Severitatea e `S1`, `S2` sau `S3`. O intrare deschisă fără severitate recunoscută se socotește **S2** (la îndoială, nivelul mai grav).
- Poarta de îmbinare (`npm.cmd run gate:merge`) se oprește la orice intrare **S1 sau S2 deschisă**; S3 deschise nu o opresc.
- Exemplele din blocurile de cod (ca cele de mai sus) nu se numără.

## Deschise

(nicio intrare)

## Rezolvate

- [x] S3 | Faza redesign-finisaje | pluralul din raportul Woo și din mesaje, breadcrumb-ul 404, inelul de focus al alertelor de autentificare, stepperul și selecturile importului pe telefon, istoricul exporturilor paginat, eticheta «Rând» pe cardurile de telefon, ținta tactilă a legăturii «Detalii» | local-data/capturi-redesign/finisaje-dupa
- [x] S3 | Fișe explodate, lista pe telefon | numărătorile «N hotspot-uri» și «N produse» din card sunt în culoarea textului principal; în `docs/17` valorile de context sunt `text-ink-secondary` | local-data/capturi-redesign/lot3b2-dupa/fise-lista-light-390.png
- [x] S3 | Import, raportul de verificare | coloana SKU e îngustă și un cod scurt se rupe în mijloc («E2E-218C25-BA / D»); coloana Motiv ia aproape tot locul | local-data/capturi-redesign/lot3b2-dupa/import-3-verificare-dark-1440.png
- [x] S3 | Autentificare și 404 public | paginile publice stau pe suprafața adminului (tokeni, tema sistemului) până când vitrina (Faza 7) își face propria suprafață; decizie notată în `docs/17` §8, punctul 1e, nu un defect | local-data/capturi-redesign/lot4-dupa/404-public-light-1440.png
