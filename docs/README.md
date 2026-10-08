# Magazin online white-label — pachet instalabil în Next.js

Plan complet de arhitectură, liste, TODO și prompturi pentru Claude Code.

**Model:** pachet instalabil — o instalare = un magazin, branding 100% din panoul de admin.
**Piață:** România. **Nișă:** echipamente și accesorii pentru piscine. **Produse:** fizice + digitale (tutoriale video).
**Prețuri:** un preț public unic, **cu TVA inclus (21%, o singură cotă)**, identic pentru toți. Trei tipuri de grup: *standard*; *Client fidel/VIP* (același preț minus 5% / 7%); *Partener 1/2/3* (preț de achiziție + adaos 12% / 17% / 21%, plafonat la prețul public). Procentele sunt editabile din admin. Niciun preț nu se ascunde. Vânzare doar în România.
**Integrări:** Netopia + EuPlătesc · wootPRO + Sameday · SmartBill · Bunny Stream · eMAG (ulterior).

## Fișiere

| # | Fișier | Ce conține |
|---|--------|-----------|
| 01 | `01-arhitectura-si-decizii.md` | Modelul de produs, stack, structura repo, setări, feature flags, convenții |
| 02 | `02-complet-si-functional.md` | Lista „COMPLET" (funcționalități) + „FUNCȚIONAL" (ce trebuie ca să meargă real) |
| 03 | `03-frontend.md` | Sitemap, fiecare pagină, checkout, design system, SEO, performanță |
| 04 | `04-backend-admin.md` | Model de date, state machines, API, module de admin, RBAC, joburi |
| 05 | `05-integrari-romania.md` | Legal RO/UE, e-Factura, plăți, curieri, marketplace, analytics |
| 06 | `06-todo-master.md` | **TODO în 23 de faze**, de la prima literă de cod la post-lansare |
| 07 | `07-prompturi-claude-code.md` | `CLAUDE.md` gata scris + ~26 prompturi de copy-paste |
| 08 | `08-instalare-si-distributie.md` | 🔑 Instalator, împachetare, actualizări, extensii, licențiere |
| 09 | `09-preturi-si-parteneri.md` | 🔑 Prețuri, TVA, grupuri de clienți cu discount |
| 10 | `10-decizii-deschise.md` | ✅ **Registru de decizii (toate luate) + verificări externe + întrebări pentru contabil** |
| 11 | `11-produse-digitale.md` | 🔑 Tutoriale video: livrare, hosting, coș mixt, dreptul de retragere, TVA |
| 12 | `12-emag-marketplace.md` | 🔑 eMAG: model de canale (de făcut ACUM), integrare completă (ulterior) |
| 13 | `13-protocol-de-lucru.md` | 🔑 **Cum lucrezi cu Claude Code**: anunțuri, statusuri, jurnal de progres |
| 14 | `14-loializare-si-vouchere.md` | Puncte de loialitate (1% cashback) și vouchere cadou cu sold |
| 15 | `15-specific-nisa-piscine.md` | 🔑 Funcționalități generice cerute de nișă: transport greu, documente, fișă explodată |
| 16 | `16-ghid-de-executie.md` | 🔑 **Ține-l deschis cât lucrezi.** Ce ceri, când, și cum nu deraiezi |

## Cele 8 lucruri care contează cel mai mult

1. **Nimic hardcodat.** Nume, logo, culori, date firmă, TVA, texte legale — toate din DB, editabile din admin. Dacă trebuie să atingi un `.tsx` ca să personalizezi pentru un client, arhitectura a eșuat.
2. **Fără `tenantId`.** O instalare = o bază de date = un magazin.
3. **Instalatorul e produsul.** Un wizard `/install` de 5 minute face diferența dintre „un magazin" și „un pachet vandabil".
4. **Niciodată nu modifica core-ul per client.** Personalizări prin setări, temă, blocuri CMS și `/extensions`. Prima excepție îți omoară mecanismul de actualizare.
5. **Prețurile se stochează brut, cu TVA inclus, ca `int` în bani.** Ce tastezi în admin e ce vede clientul. TVA-ul se extrage pentru factură. Rotunjire pe linie, o singură dată.
6. **Un singur motor de prețuri**, în `packages/core/pricing`, apelat din PLP, PDP, coș, checkout și factură. Niciun calcul duplicat.
7. **Trei statusuri pe comandă**, nu unul: `status`, `paymentStatus`, `fulfillmentStatus`.
8. **Partea legală românească are consecințe în modelul de date**: Omnibus cere istoric de prețuri, GPSR cere câmpuri pe produs, e-Factura cere date de firmă complete, produsele digitale cer o bifă separată de renunțare la dreptul de retragere. Nu le lăsa pe final.
9. **Pregătește modelul de canale acum, fă eMAG mai târziu.** O zi de muncă în Faza 4 (`ChannelListing`, `ean`, `Order.channelId`) te scutește de un retrofit brutal peste 3 luni.
10. **Bifa `manageStock`, exact ca în WooCommerce.** Setare globală + suprascriere per produs și per variantă. Când e stinsă: doar „în stoc / stoc epuizat", zero inventar. Ramură explicită în cod, nu simulare cu numere mari.
11. **Protocolul de lucru din fișierul 13 e obligatoriu.** Fără el nu vei ști niciodată unde ești în proiect.
12. **Voucherul cadou e o metodă de plată, nu o reducere.** Nu intră în motorul de prețuri și nu reduce baza de TVA. Cea mai frecventă greșeală la implementarea voucherelor.

## ✅ Toate deciziile de arhitectură sunt luate

Documentația e completă. Poți începe cu Promptul 1 din fișierul 07.

Înainte de asta, patru lucruri de făcut în paralel, care nu țin de cod:
- Cele 11 întrebări pentru contabil (fișierul 10, Partea III)
- Verificarea limitelor de greutate la wootPRO (fișierul 10, Partea II)
- Deschiderea conturilor de test
- Pregătirea a 20-30 de produse reale pentru dezvoltare

## Cum lucrezi cu Claude Code

1. Citește **`16-ghid-de-executie.md`** (ce ceri și când) și **`13-protocol-de-lucru.md`** (cum raportează).
2. Copiază folderul în `docs/` în rădăcina proiectului.
3. Creează `CLAUDE.md` în rădăcină (conținutul e la începutul fișierului 07).
4. **O fază pe sesiune.** Context curat de fiecare dată.
5. Folosește ritualul de start din `13-protocol-de-lucru.md` §3.
6. Claude Code trebuie să anunțe **🟢 ÎNCEP** înainte de fiecare punct și **✅ GATA** după, cu pași concreți de verificat de tine în browser.
7. La final de sesiune, `docs/06-todo-master.md` bifat și `docs/PROGRESS.md` actualizat.

## Ordinea de execuție

```
Fundație → Setări & branding → Media → Catalog → Stoc → Design system
→ Storefront → Prețuri & coș → Checkout → Plăți → Admin comenzi & email
→ AWB → Facturare → Cont client & retururi → Produse digitale → Grupuri de clienți
→ CMS → Marketing & SEO → Instalator → Extensii & update → Rapoarte
→ Împachetare → Lansare → eMAG
```

Nu o schimba. Fiecare pas depinde direct de cel dinainte.

## Estimare

| | Zile de lucru |
|---|---|
| MVP vandabil, fizic + digital (Fazele 0-15) | ~72-84 |
| + Specificul nișei: transport greu, etichetă energetică, filtre tehnice | +6 |
| + Loialitate și vouchere (Faza 15b) | +6,5 |
| + Funcționalități de nișă (transport, documente, fișă explodată) | +6,5-8 |
| + Pachet distribuibil (instalator, extensii, împachetare) | +14-16 |
| + CMS, marketing, SEO, rapoarte | +17-20 |
| **Complet, fără eMAG** | **~122-141** |
| + eMAG Marketplace | +8-12 |
| **Total** | **~130-153** |

## ⚠️ Ordinea de lucru confirmată

**Primul magazin lansat e al tău.** Deci:

1. **Etapa 1** — Fazele 0-17: construiești și lansezi magazinul tău (~85-100 zile)
2. **Etapa 2** — Fazele 18, 19, 21: instalator, extensii, împachetare (~12-14 zile)
3. **Etapa 3** — Faza 22b: eMAG Marketplace (~8-12 zile)

Nu construi instalatorul înainte să ai un magazin care vinde. Vei descoperi în primele două luni de operare zeci de lucruri pe care nu le anticipăm acum, și e mult mai ieftin să le repari într-o instalare decât în douăzeci.

**Dar patru lucruri le faci din prima**, altfel Etapa 2 devine rescriere: zero hardcodare (setări în DB, Faza 2) · feature flags (Faza 2) · tabelele de canal pentru eMAG (Faza 4) · migrații curate și versionate (Faza 1).
