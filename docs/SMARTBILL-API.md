# SmartBill API: ce s-a citit și ce s-a presupus (Faza 13)

**Sursa:** specificația OpenAPI publică `https://api.smartbill.ro/smartbill-api-spec.yaml` («Ultima actualizare: 16 octombrie 2026»), citită la 2026-11-22. Adaptorul (`packages/integrations/src/invoicing/smartbill.ts`) e **încă netestat cu un cont real**: testele lui sunt de contract, pe răspunsuri simulate scrise după această specificație. Utilizatorul nu are încă acces API.

## Din specificație (citit)

- Baza `https://ws.smartbill.ro/SBORO/api`; autentificare Basic cu email + token (pagina Integrări); 30 de apeluri la 10 secunde per token, la depășire accesul se blochează 10 minute (coada de facturare are un singur lucrător).
- Succes = `errorText` gol (codul HTTP nu e de ajuns); `401` autentificare, `400` eroare funcțională (cu `errorText`), `410` limita abonamentului, `502` cu HTML la PDF inexistent.
- Factură: `POST /invoice/v2`; proformă: `POST /estimate/v2`; storno TOTAL: `POST /invoice/reverse` (serie + număr); anulare proformă: `PUT /estimate/cancel`; PDF: `GET /invoice/pdf` și `/estimate/pdf` (NU `Accept: application/pdf`); totalul facturii: `GET /invoice/paymentstatus` (`invoiceTotalAmount`); serii: `GET /series`; cote: `GET /tax`.
- Prețul se trimite cu `isTaxIncluded: true`; seria, numele cotei de TVA (`taxName`) și unitatea (`measuringUnitName`) trebuie să fie exact cele din cont; cantitatea nu e validată de API (0 și negativ sunt acceptate), deci o validează magazinul (cel mult 2 zecimale); cel mult 400 de linii pe document.
- `useStock` (descărcare de gestiune) e O SINGURĂ bifă pe factură și cere `warehouseName` pe FIECARE produs, altfel eroare. De aceea o factură cu cel puțin o linie care nu se descarcă (produs fără stoc gestionat, «La comandă») se emite întreagă FĂRĂ descărcare, iar bucățile rămân «angajate» până la o sincronizare care conține descărcarea reală.
- **NU există** endpoint pentru statusul e-Factura și nici pentru retrimiterea ei: SmartBill o transmite singur, iar starea se vede în contul lor. În magazin `efacturaStatus` rămâne «necunoscut» până o marchează adminul (după verificarea în SmartBill).
- **NU există** storno parțial prin API: doar `/invoice/reverse` pe tot documentul.

## Presupuneri (nedocumentate, de verificat în sandbox)

1. **Storno parțial** = factură cu cantități NEGATIVE, în aceeași serie (specificația spune că cantitățile negative sunt acceptate; nu spune că se leagă de factura originală).
2. Liniile de servicii (transport, taxă de ramburs, `isService: true`) nu cer gestiune când `useStock` e adevărat.
3. O factură din proformă (`useEstimateDetails` + `estimate`) păstrează liniile trimise de noi (identice cu cele ale proformei, comanda nu se editează).
4. SmartBill calculează linia ca `round(preț × cantitate)` și TVA-ul din brutul liniei, iar totalul/TVA-ul facturii ca sumă pe linii (exact ce verifică pasul separat al rotunjirii, `docs/FACTURARE-VERIFICARE-ROTUNJIRE.md`).
5. Încasarea pe factură (`payment.type`: «Card online», «Ordin plata») nu cere `paymentSeries` pentru aceste tipuri.
6. `useSBProductName` nu se trimite: la descărcare de gestiune, numele din nomenclatorul SmartBill se rescrie cu cel trimis de noi.

## Ce nu s-a făcut (S3 în FINISAJE)

Înregistrarea încasării ramburs în SmartBill la reconciliere; trimiterea facturii clientului din magazin (SmartBill poate trimite el, setarea `invoicing.sendEmailByProvider`); factura în contul clientului (Faza 14).
