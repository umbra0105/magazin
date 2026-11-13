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

(nicio intrare)
