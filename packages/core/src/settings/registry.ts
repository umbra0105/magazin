import {
  ANNOUNCEMENT_MAX_LENGTH,
  ANNOUNCEMENT_TONES,
  CARD_LAYOUTS,
  CONTAINER_WIDTHS,
  FOOTER_VARIANTS,
  HEADER_VARIANTS,
  isSafeAnnouncementHref,
} from "../storefront/appearance";
import { z } from "zod";
import { normalizeHostname } from "../media/host";
import { isValidCalendarDate } from "../inventory/workdays";
import { PAYMENT_RULE_DEFAULTS } from "../orders/payment-rules";
import { SHIPPING_CLASSES } from "../shipping/types";

/**
 * Registrul setărilor: singura sursă pentru chei, tipuri și valori implicite NEUTRE.
 * Cheia completă este `grup.nume` (ex. `tax.standardRate`). Valorile reale vin din tabela
 * `Setting`, editabile din admin; aici sunt doar valorile de pornire.
 */
export const settingGroups = {
  general: {
    storeName: z.string().min(1).default("Magazin online"),
    storeTagline: z.string().default(""),
    showPoweredBy: z.boolean().default(true),
  },
  company: {
    legalName: z.string().default(""),
    vatId: z.string().default(""),
    tradeRegisterNo: z.string().default(""),
    isVatPayer: z.boolean().default(true),
    address: z
      .object({
        street: z.string(),
        city: z.string(),
        county: z.string(),
        postalCode: z.string(),
        country: z.string().length(2),
      })
      .default({ street: "", city: "", county: "", postalCode: "", country: "RO" }),
    email: z.string().default(""),
    phone: z.string().default(""),
    iban: z.string().default(""),
    bankName: z.string().default(""),
    /**
     * Programul de ridicare personală (text liber, scurt, fără HTML): se arată în checkout, confirmare, pagina comenzii și email,
     * lângă adresa de ridicare, doar când e completat. Fără reguli de business în jurul lui.
     */
    pickupHours: z
      .string()
      .trim()
      .max(300)
      .refine((v) => !/[<>]/.test(v), "Textul nu poate conține HTML")
      .default(""),
  },
  regional: {
    allowedCountries: z.array(z.string().length(2)).min(1).default(["RO"]),
    defaultCountry: z.string().length(2).default("RO"),
    currency: z.string().length(3).default("RON"),
    locale: z.string().default("ro-RO"),
    timezone: z.string().default("Europe/Bucharest"),
    /**
     * Zile nelucrătoare (sărbători legale, zile libere ale magazinului), ca date locale `AAAA-LL-ZZ`: se sar la expirarea
     * rezervării prin transfer bancar (`inventory.transferReservationWorkdays`). Lista o completează magazinul din admin;
     * pachetul nu poartă sărbători scrise în cod.
     */
    nonWorkingDates: z
      .array(
        z.string().refine(isValidCalendarDate, "Data trebuie să fie AAAA-LL-ZZ, o zi care există"),
      )
      .max(400)
      .default([]),
  },
  tax: {
    /** Cota unică de TVA, în procente. Singura sursă: nu se hardcodează nicăieri în cod. */
    standardRate: z.number().min(0).max(100).default(21),
  },
  inventory: {
    /** Valoarea implicită a bifei «Gestionează stocul» la produsele NOI (importurile setează explicit `false`). */
    manageStock: z.boolean().default(true),
    /** Cât ține o rezervare pentru o plată cu cardul (D4); coșul nu rezervă nimic. */
    reservationMinutes: z.number().int().min(1).default(15),
    /** Cât ține rezervarea pentru transfer bancar, în ZILE LUCRĂTOARE (D4). */
    transferReservationWorkdays: z.number().int().min(1).max(30).default(3),
    /** Termenul «La comandă» în zile, când nici produsul, nici brandul nu au unul (D6). */
    defaultLeadTimeDays: z.number().int().min(0).max(365).default(14),
    /** Pragul «stoc mic» / «Stoc limitat» în PAȘI de vânzare; o variantă îl poate suprascrie (D7). */
    lowStockSteps: z.number().int().min(0).max(1000).default(2),
    /** Fereastra de siguranță în jurul orei pozei SmartBill: factură în această fereastră rămâne angajată (D1). */
    snapshotSafetyWindowMinutes: z.number().int().min(0).max(1440).default(30),
    /** După câte ore se avertizează că poza SmartBill e veche (D1). */
    snapshotStaleHours: z.number().int().min(1).max(720).default(24),
    /** Cât se păstrează o cerere «Anunță-mă când revine» netrimisă, în zile (D12). */
    backInStockRetentionDays: z.number().int().min(1).max(365).default(90),
    /** Cererile «Anunță-mă» în așteptare pe o singură adresă (plafon împotriva abuzului, D12). */
    backInStockMaxPerEmail: z.number().int().min(1).max(100).default(10),
    /** Cererile «Anunță-mă» în așteptare pe o singură variantă (plafon împotriva abuzului, D12). */
    backInStockMaxPerVariant: z.number().int().min(1).max(100_000).default(1000),
    /**
     * Gestiunile SmartBill din care importul «stoc la zi» citește cantitățile (numele exact din raport, fără deosebire de
     * litere). Goală = importul refuză să pornească; celelalte gestiuni din fișier se ignoră. Numele nu se scrie în cod.
     */
    smartbillWarehouses: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  },
  catalog: {
    /**
     * Garanția implicită, în luni, pusă pe variantele fără garanție proprie la activarea produsului
     * (24 = minimul legal pentru consumatori). Magazinul o poate schimba; produsul o poate suprascrie.
     */
    defaultWarrantyMonths: z.number().int().min(0).max(240).default(24),
    /**
     * Vitrina arată prețul redus și prețul tăiat (promoțiile)? OPRIT implicit: până la răspunsul avocatului despre Omnibus
     * (`docs/INTREBARI-AVOCAT.md` §2: ce se afișează, pentru ce reduceri, de la ce dată curge perioada de 30 de zile) vitrina
     * arată doar prețul întreg. Nu e o decizie de produs: pornirea ei cere răspunsul și textele legale.
     */
    showSalePricing: z.boolean().default(false),
    /** Produse pe pagină în listele vitrinei (categorie, mărci, colecții, căutare). */
    productsPerPage: z.number().int().min(8).max(96).default(24),
  },
  checkout: {
    guestCheckoutEnabled: z.boolean().default(true),
    /**
     * Pragul de transport gratuit, în BANI ÎNTREGI (cu TVA): se compară cu totalul coșului după reduceri, fără transport.
     * GOL = dezactivat (indicatorul din coș nu apare deloc). Pragul pe clasă de transport și pe produs vine în Faza 9.
     */
    freeShippingThreshold: z.number().int().min(1).max(1_000_000_000).nullable().default(null),
    /**
     * Clasele de transport la care se aplică pragul de transport gratuit. Implicit doar `standard`: la produsele voluminoase
     * (`oversized`, `pallet`) transportul costă mult mai mult decât marja unui prag obișnuit. Pragul se poate dezactiva și
     * pe produs (ecranul «Coș și transport»).
     */
    freeShippingClasses: z.array(z.enum(SHIPPING_CLASSES)).max(3).default(["standard"]),
    /** Prefixul numărului de comandă (ex. «WEB-»); gol = doar cifre. Numărul = prefix + contor cu zerouri la stânga. */
    orderNumberPrefix: z
      .string()
      .trim()
      .max(10)
      .regex(/^[A-Za-z0-9-]*$/, "Doar litere, cifre și cratimă")
      .default(""),
    /** Câte cifre are partea numerică a numărului de comandă (completată cu zerouri la stânga). */
    orderNumberDigits: z.number().int().min(1).max(12).default(6),
    /** Cât așteptăm răspunsul ANAF la validarea CUI (ms); dacă nu vine, CUI-ul rămâne «neverificat», comanda nu se blochează. */
    anafTimeoutMs: z.number().int().min(500).max(10_000).default(3000),
  },
  payment: {
    /**
     * Suma maximă (bani, cu TVA) pentru plata cu ramburs la persoane fizice; peste ea metoda se ascunde. Regula «fără ramburs la
     * produse La comandă» NU e setare: e fixă în cod.
     */
    codMaxAmountIndividual: z
      .number()
      .int()
      .min(0)
      .max(1_000_000_000)
      .default(PAYMENT_RULE_DEFAULTS.codMaxIndividualMinor),
    /** Suma maximă pentru ramburs la persoane juridice (CUI la facturare sau grup `cost_plus`). */
    codMaxAmountCompany: z
      .number()
      .int()
      .min(0)
      .max(1_000_000_000)
      .default(PAYMENT_RULE_DEFAULTS.codMaxCompanyMinor),
    /**
     * Furnizorul folosit de butonul «Card online» (Faza 10): netopia | euplatesc | demo (doar dezvoltare). Gol = cardul nu apare.
     * Cheile sunt cu două segmente (`grup.nume`), deci nu `payment.card.provider`.
     */
    cardProvider: z.enum(["", "netopia", "euplatesc", "demo"]).default(""),
    /** Cât timp se poate reîncerca plata cu cardul după plasare, în ore; la expirare comanda se anulează automat. */
    cardRetryHours: z.number().int().min(1).max(168).default(24),
    /**
     * Limita de rambursare a rolului Suport (Faza 11, decizia 2026-11-19), în bani (50000 = 500,00 lei): suma cumulată
     * rambursată pe o comandă de actori cu limită (`orders.refund` fără `payments.refund`) nu poate depăși valoarea. 0 = Suportul
     * nu poate rambursa. Regula e pe server (`payments/refund-limit.ts`); o setare care nu se poate citi = refuz.
     */
    supportRefundLimit: z.number().int().min(0).max(1_000_000_000).default(50_000),
  },
  returns: {
    /**
     * Fereastra de retur: zile de la livrare (sau de la momentul marcat ca ridicat, la ridicare personală), decizia 2026-11-22.
     * O citește și loialitatea (Faza 15b). Nu blochează nimic pe baza «la comandă», «paletizat» sau «supradimensionat».
     */
    windowDays: z.number().int().min(1).max(365).default(14),
  },
  loyalty: {
    /**
     * Punctele de loialitate (Faza 15b). Programul merge doar cu flag-ul `loyalty` pornit ȘI cu `enabled`. Transportul plătit
     * în bani și acumularea doar pe banii plătiți sunt reguli FIXE, nu setări.
     */
    enabled: z.boolean().default(false),
    /** Câți bani plătiți pe produse aduc 1 punct (10000 = 100,00 lei). */
    earnRate: z.number().int().min(1).max(1_000_000_000).default(10_000),
    /** Cât valorează 1 punct la folosire, în bani (100 = 1,00 leu). */
    pointValue: z.number().int().min(1).max(1_000_000).default(100),
    /** Câte luni sunt valabile punctele de la acordare. */
    expiryMonths: z.number().int().min(1).max(120).default(12),
    /** Cu câte zile înainte de expirare pleacă emailul de avertizare. */
    expiryWarningDays: z.number().int().min(1).max(365).default(30),
    /** Plafon din valoarea produselor care se poate plăti cu puncte, în procente; gol = fără plafon. */
    maxRedeemPercent: z.number().int().min(1).max(100).nullable().default(null),
    /** Sub acest număr de puncte nu se pot folosi. */
    minRedeemPoints: z.number().int().min(1).max(1_000_000).default(10),
    /** Suma minimă de plătit în bani când transportul e mai mic (regula dură: comanda de 0 lei nu poate apărea). */
    minCashAmount: z.number().int().min(1).max(1_000_000_000).default(100),
    /** Produsele la promoție aduc și ele puncte. */
    earnOnDiscountedItems: z.boolean().default(true),
    /**
     * Tratamentul TVA al reducerii din puncte. GOL = punctele nu se pot folosi (cere confirmarea contabilului).
     * `base_reduced` = reducerea scade baza de TVA. `base_full` e amânat (decizia 2026-11-26) și e respins.
     */
    vatMode: z.enum(["base_reduced"]).nullable().default(null),
    /** Punctele întoarse (anulare, retur) nu expiră mai devreme de atâtea zile de la întoarcere. */
    releasedGraceDays: z.number().int().min(0).max(365).default(30),
    /**
     * Marcaj intern: `db:seed:store` a pornit deja programul acestei instalări, deci nu mai suprascrie nimic. Nu apare în admin.
     * Existența rândului nu spune nimic: `db:seed` scrie câte un rând pentru fiecare setare.
     */
    storeSeeded: z.boolean().default(false),
  },
  account: {
    /**
     * Cât se păstrează comenzile și facturile unui cont șters (anonimizat), în ani. Anonimizarea NU șterge comenzile (obligație
     * fiscală); valoarea e de confirmat cu avocatul (INTREBARI-AVOCAT 3.3), de aceea e setare, nu constantă în cod.
     */
    orderRetentionYears: z.number().int().min(1).max(30).default(10),
  },
  digital: {
    /** Unde stau videoclipurile noi (Faza 14b): local (stocarea platformei, dezvoltare) | bunny (Bunny Stream; doar după confirmarea lui Owner). */
    videoProvider: z.enum(["local", "bunny"]).default("local"),
    /** Unde stau fișierele noi (PDF, arhive): local (stocarea platformei, dezvoltare) | s3 (bucket propriu; doar după confirmarea lui Owner). */
    fileProvider: z.enum(["local", "s3"]).default("local"),
    /** Cât ține un link de acces (secunde): scurt, creat la cerere, după verificarea dreptului de acces; niciodată permanent. */
    linkSeconds: z.number().int().min(15).max(3600).default(120),
    /** Mărimea maximă a unui fișier încărcat din admin, în MB. */
    maxUploadMb: z.number().int().min(1).max(2048).default(200),
    /** Alerta de tipar anormal: același drept de acces folosit de mai multe adrese IP distincte decât această valoare, în fereastră. */
    maxIpsPerEntitlement: z.number().int().min(2).max(1000).default(5),
    /** Fereastra (ore) în care se numără adresele IP distincte ale unui drept de acces. */
    ipWindowHours: z.number().int().min(1).max(720).default(24),
    /**
     * Cât se păstrează IP-ul și user-agent-ul din jurnalul de accesări, în zile; după aceea devin nule (jurnalul rămâne, fără date
     * personale). Valoarea e de confirmat cu avocatul (INTREBARI-AVOCAT 3.5), de aceea e setare, nu constantă în cod.
     */
    accessLogRetentionDays: z.number().int().min(7).max(3650).default(180),
    /** Textul bifei de renunțare la dreptul de retragere (INTREBARI-AVOCAT 5.2); gol = textul implicit din mesaje. */
    consentText: z.string().trim().max(600).default(""),
  },
  orders: {
    /** Cât e valabilă o ofertă de plată (link pentru client), în ore; după aceea expiră (job). */
    offerValidityHours: z.number().int().min(1).max(720).default(72),
    /** Prefixul numărului ofertei (diferit de cel al comenzilor, ca să nu se confunde). */
    offerNumberPrefix: z
      .string()
      .trim()
      .min(1)
      .max(10)
      .regex(/^[A-Za-z0-9-]+$/, "Doar litere, cifre și cratimă")
      .default("OF-"),
  },
  shipping: {
    /** Ridicare personală de la sediu (adresa din `company.address`). */
    pickupEnabled: z.boolean().default(false),
    /** Easybox (locker): oprit până la hartă (Faza 12); regula «oversized/pallet blochează easybox» există oricum. */
    easyboxEnabled: z.boolean().default(false),
    /** Cât așteptăm tarifele furnizorului (ms) înainte să cădem pe tarifele pe zonă. */
    quoteTimeoutMs: z.number().int().min(500).max(15_000).default(4000),
    /**
     * Curierul/agregatorul activ (Faza 12): wootpro | sameday | demo (doar dezvoltare). Gol = tarifele vin din furnizorul DEMO de
     * tarife (marcat «DEMO») și din rezerva pe zone, iar AWB-ul se introduce manual. Un curier real se folosește doar dacă e activ,
     * complet configurat și, în LIVE, verificat în sandbox.
     */
    carrier: z.enum(["", "wootpro", "sameday", "demo"]).default(""),
    /** Faza 12: cât timp se păstrează în cache tariful cerut aceluiași furnizor pentru aceleași colete și aceeași destinație. */
    rateCacheSeconds: z.number().int().min(0).max(3600).default(120),
    /**
     * Transportul paletizat (Faza 12): preț FIX per palet, în BANI, cu TVA inclus (35.000 = 350 lei); nu vine din API. TVA-ul se
     * extrage din brut, cu cota din `tax.standardRate`.
     */
    palletPriceMinor: z.number().int().min(1).max(100_000_000).default(35_000),
    /**
     * Pragul de la care, dacă cel mai ieftin curier îl DEPĂȘEȘTE (comparație strictă, preț brut, cu TVA, înainte de transportul
     * gratuit) și paletizatul costă mai puțin sau cât curierul, curierul și easybox-ul se ascund (40.000 = 400 lei).
     */
    palletSwitchThresholdMinor: z.number().int().min(0).max(100_000_000).default(40_000),
    /** Capacitatea unui palet în greutate, în GRAME (600.000 = 600 kg). */
    palletMaxWeightGrams: z.number().int().min(1).max(100_000_000).default(600_000),
    /** Capacitatea unui palet în volum, în cm³ (1.200.000 = 1,2 m³). */
    palletMaxVolumeCm3: z.number().int().min(1).max(100_000_000_000).default(1_200_000),
    /** Transportatorii oferiți ca listă la expedierea manuală (AWB introdus de admin); gol = text liber. */
    manualCarriers: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    /** Mesajul despre livrarea la nivelul solului, afișat la alegerea livrării. */
    groundLevelNotice: z
      .string()
      .trim()
      .max(500)
      .default(
        "Livrarea se face la adresă, la nivelul solului. Descărcarea și manipularea produselor sunt în sarcina clientului.",
      ),
  },
  cart: {
    /** Cât rămâne un coș de oaspete (și cookie-ul lui), în zile; fiecare modificare îl prelungește. */
    guestCartDays: z.number().int().min(1).max(365).default(30),
    /** Cât rămâne coșul unui client autentificat, în zile; fiecare modificare îl prelungește. */
    userCartDays: z.number().int().min(1).max(730).default(90),
    /** Linii într-un coș (limită tehnică împotriva abuzului). */
    maxLines: z.number().int().min(1).max(500).default(50),
    /** Cantitatea maximă pe linie, în PAȘI de vânzare (limită tehnică; peste valoarea maximă a liniei se refuză oricum). */
    maxStepsPerLine: z.number().int().min(1).max(1_000_000).default(1000),
    /** Operații de adăugare/modificare pe minut, pe aceeași adresă IP (și pe același coș). */
    mutationsPerMinute: z.number().int().min(1).max(10_000).default(60),
  },
  email: {
    fromName: z.string().default(""),
    fromAddress: z.string().default(""),
    replyTo: z.string().default(""),
    /**
     * Destinatarii notificărilor interne (comandă nouă, stoc epuizat), adrese de email. Gol = fără notificări interne. Alertele
     * pe permisiune (de exemplu sincronizarea SmartBill) se trimit utilizatorilor cu permisiunea, nu acestei liste.
     */
    internalRecipients: z
      .array(z.string().trim().toLowerCase().email().max(200))
      .max(20)
      .default([]),
  },
  invoicing: {
    /**
     * Furnizorul de facturare activ (Faza 13): smartbill | demo (doar dezvoltare). Gol = nu se emite nimic automat; comenzile apar
     * în lista «comenzi confirmate fără factură». Un furnizor real se folosește doar dacă e activ, complet configurat și, în LIVE,
     * verificat cu un cont real.
     */
    provider: z.enum(["", "smartbill", "demo"]).default(""),
    /** Numele unităților din contul furnizorului, după simbolul unității din magazin (ex. {"mp":"mp"}); lipsă = simbolul. */
    unitNames: z
      .record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(40))
      .default({}),
    /** Denumirea liniei de transport și a taxei de ramburs pe factură, și unitatea lor de măsură. */
    shippingLabel: z.string().trim().min(1).max(80).default("Transport"),
    codFeeLabel: z.string().trim().min(1).max(80).default("Taxă de ramburs"),
    /** Denumirea rândului de reducere din puncte de loialitate (Faza 15b); urmează numele produsului. */
    pointsDiscountLabel: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .default("Reducere din puncte de loialitate"),
    serviceUnit: z.string().trim().min(1).max(40).default("buc"),
    /** Furnizorul trimite factura clientului pe email (SmartBill: cere un server de email configurat în contul lor). */
    sendEmailByProvider: z.boolean().default(false),
    /** Încercări de emitere înainte ca documentul să treacă în «eșuat» (cere decizia adminului). */
    maxAttempts: z.number().int().min(1).max(10).default(5),
    /** După câte eșecuri apare alerta în admin (o singură dată pe document). */
    alertAfterFailures: z.number().int().min(1).max(10).default(3),
    /** Așteptarea până la următoarea încercare, în minute, după fiecare eșec (ultima valoare se repetă). */
    backoffMinutes: z
      .array(z.number().int().min(1).max(1440))
      .min(1)
      .max(10)
      .default([1, 5, 15, 60]),
    /** Cât poate dura o emitere înainte să fie socotită cu rezultat nesigur (minute). */
    leaseMinutes: z.number().int().min(2).max(120).default(10),
  },
  legal: {
    anpcUrl: z.string().default(""),
    salUrl: z.string().default(""),
    odrUrl: z.string().default(""),
  },
  auth: {
    /** Clienții trebuie să-și verifice emailul. Oprit = magazin fără SMTP nu își blochează înregistrările. */
    requireEmailVerification: z.boolean().default(true),
    /** Lungime minimă a parolei; fără reguli de compoziție. Nu poate coborî sub 12. */
    minPasswordLength: z.number().int().min(12).max(128).default(12),
    customerSessionDays: z.number().int().min(1).max(365).default(30),
    /** Sesiunile conturilor cu acces la admin sunt mai scurte. */
    adminSessionHours: z.number().int().min(1).max(168).default(8),
    /** Cât e valabil linkul de verificare a emailului (unică folosință). */
    emailVerificationHours: z.number().int().min(1).max(168).default(24),
    /** Cât e valabil linkul de resetare a parolei (unică folosință). */
    passwordResetMinutes: z.number().int().min(5).max(1440).default(60),
    /**
     * După câte zile se șterg conturile cu emailul neverificat (doar dacă verificarea emailului e cerută; fără roluri). Termenul
     * efectiv nu e mai scurt decât valabilitatea linkului de verificare plus 24 de ore.
     */
    unverifiedAccountRetentionDays: z.number().int().min(2).max(365).default(7),
    /**
     * Conectări EȘUATE ale aceleiași perechi (email, adresă IP) în fereastră, după care perechea se blochează temporar
     * (progresiv: `lockoutMinutes`, dublu la fiecare blocare repetată în 24 h). Se numără doar eșecurile.
     */
    loginMaxAttempts: z.number().int().min(1).max(100).default(5),
    loginWindowMinutes: z.number().int().min(1).max(1440).default(15),
    /** Conectări eșuate de pe o adresă IP (orice email) în fereastră, după care ADRESA se blochează temporar (progresiv). */
    loginIpMaxAttempts: z.number().int().min(1).max(10_000).default(30),
    /** Încercări de conectare (reușite sau nu) pe adresă pe minut: frână pentru costul argon2 al fiecărei cereri. */
    loginRatePerMinutePerIp: z.number().int().min(1).max(100_000).default(120),
    /** Înregistrări cu ACELAȘI email în fereastră (de la orice adrese). */
    registerMaxAttempts: z.number().int().min(1).max(100).default(5),
    /** Înregistrări de pe aceeași adresă IP în fereastră (IPv6 pe /64); fără IP de încredere, coș global ×10. */
    registerMaxPerIp: z.number().int().min(1).max(1000).default(20),
    registerWindowMinutes: z.number().int().min(1).max(1440).default(60),
    /** Cereri de resetare a parolei pentru ACELAȘI email în fereastră. */
    passwordResetMaxAttempts: z.number().int().min(1).max(100).default(5),
    /** Cereri de resetare a parolei de pe aceeași adresă IP în fereastră (coș global ×10 fără IP de încredere). */
    passwordResetMaxPerIp: z.number().int().min(1).max(1000).default(20),
    passwordResetWindowMinutes: z.number().int().min(1).max(1440).default(60),
    /** Retrimiteri ale emailului de verificare pentru ACELAȘI email în fereastră (contor separat de resetare). */
    verificationResendMaxAttempts: z.number().int().min(1).max(100).default(5),
    /** Retrimiteri ale emailului de verificare de pe aceeași adresă IP în fereastră (contor separat de resetare). */
    verificationResendMaxPerIp: z.number().int().min(1).max(1000).default(20),
    verificationResendWindowMinutes: z.number().int().min(1).max(1440).default(60),
    /** Încercări de confirmare a emailului (`/api/verify-email`) per IP în fereastră. */
    verifyEmailMaxAttempts: z.number().int().min(1).max(1000).default(10),
    verifyEmailWindowMinutes: z.number().int().min(1).max(1440).default(15),
    /**
     * Eșecuri de login pe un email, de la ORICE adrese, în fereastră, după care se scrie o alertă în audit. NU blochează
     * contul: un străin nu poate bloca contul altcuiva (blocările sunt pe adresă și pe perechea email + adresă).
     */
    lockoutThreshold: z.number().int().min(3).max(100).default(10),
    /** Durata de bază a unei blocări (se dublează la blocări repetate în 24 h, până la 24 h). */
    lockoutMinutes: z.number().int().min(1).max(1440).default(15),
    /**
     * Câte proxy-uri de încredere sunt în fața aplicației. 0 = niciunul: headerul X-Forwarded-For
     * se ignoră (altfel orice client și-ar putea alege IP-ul și ar ocoli limitele).
     */
    trustedProxyHops: z.number().int().min(0).max(5).default(0),
  },
  media: {
    /** Mărimea maximă a unui fișier încărcat, în octeți (implicit 20 MB; plafon 50 MB: trece prin memorie). */
    maxUploadBytes: z
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(20 * 1024 * 1024),
    /** Pixeli maximi la intrare (lățime × înălțime), împotriva imaginilor-bombă. */
    maxInputPixels: z.number().int().min(1_000_000).max(100_000_000).default(40_000_000),
    /** Tipurile acceptate la încărcare; doar din lista suportată (GIF și SVG nu sunt acceptate). */
    allowedMimeTypes: z
      .array(z.enum(["image/jpeg", "image/png", "image/webp", "image/avif"]))
      .min(1)
      .default(["image/jpeg", "image/png", "image/webp", "image/avif"]),
    /** Încărcări per utilizator în fereastră. */
    uploadMaxAttempts: z.number().int().min(1).max(10_000).default(60),
    uploadWindowMinutes: z.number().int().min(1).max(1440).default(10),
    /** Încercări refuzate (origine, sesiune, permisiune) pe IP care mai intră în jurnalul de audit. */
    refusedAuditMaxAttempts: z.number().int().min(1).max(10_000).default(20),
    /** Lățimile variantelor generate (pixeli, latura mare); fiecare în AVIF, WebP și JPEG. */
    thumbWidth: z.number().int().min(64).max(1000).default(320),
    mediumWidth: z.number().int().min(200).max(2000).default(800),
    largeWidth: z.number().int().min(400).max(4000).default(1600),
    avifQuality: z.number().int().min(1).max(100).default(60),
    webpQuality: z.number().int().min(1).max(100).default(80),
    jpegQuality: z.number().int().min(1).max(100).default(82),
  },
  documents: {
    /** Mărimea maximă a unui document de produs (PDF sau imagine), în octeți (implicit 15 MB; plafon 50 MB). */
    maxUploadBytes: z
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(15 * 1024 * 1024),
    /** Încărcări de documente per utilizator în fereastră (contor separat de cel al bibliotecii media). */
    uploadMaxAttempts: z.number().int().min(1).max(10_000).default(30),
    uploadWindowMinutes: z.number().int().min(1).max(1440).default(10),
    /** Încercări refuzate (origine, sesiune, permisiune) pe IP care mai intră în jurnalul de audit. */
    refusedAuditMaxAttempts: z.number().int().min(1).max(10_000).default(20),
  },
  import: {
    /** Mărimea maximă a unui fișier de import (CSV sau XLSX), în octeți (implicit 10 MB; plafon 50 MB). */
    maxUploadBytes: z
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(10 * 1024 * 1024),
    /** Rânduri de date acceptate într-un import. */
    maxRows: z.number().int().min(1).max(20_000).default(5000),
    maxColumns: z.number().int().min(2).max(200).default(200),
    /** Caractere într-o celulă (implicit cât descrierea unui produs). */
    maxCellLength: z.number().int().min(100).max(100_000).default(100_000),
    /** Conținut decomprimat acceptat dintr-un XLSX (protecție împotriva arhivelor-bombă). */
    maxUncompressedBytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(200 * 1024 * 1024)
      .default(60 * 1024 * 1024),
    maxZipEntries: z.number().int().min(10).max(500).default(100),
    /** Până la atâtea rânduri importul se aplică pe loc; peste, rulează în fundal, cu progres. */
    syncMaxRows: z.number().int().min(1).max(1000).default(100),
    /** Cât timp rămâne un import (fișierul neaplicat, apoi raportul) înainte să fie șters. */
    retentionHours: z.number().int().min(1).max(168).default(24),
    /**
     * Cât timp se păstrează RAPORTUL DETALIAT al unui import aplicat (în istoric), în zile. După aceea se
     * șterge detaliul pe rânduri; sumarul (contoarele, utilizatorul, fișierul) rămâne.
     */
    historyRetentionDays: z.number().int().min(7).max(3650).default(180),
    /** Un import care rulează și nu a mai avansat de atâtea minute apare în istoric ca «întrerupt». */
    interruptedAfterMinutes: z.number().int().min(5).max(1440).default(30),
    /** Descărcări de rapoarte de import per utilizator în fereastră (contor separat de încărcări). */
    reportDownloadMaxAttempts: z.number().int().min(1).max(10_000).default(60),
    /** Încărcări de fișiere de import per utilizator în fereastră (contor separat). */
    uploadMaxAttempts: z.number().int().min(1).max(10_000).default(20),
    uploadWindowMinutes: z.number().int().min(1).max(1440).default(10),
    /** Încercări refuzate (origine, sesiune, permisiune) pe IP care mai intră în jurnalul de audit. */
    refusedAuditMaxAttempts: z.number().int().min(1).max(10_000).default(20),
    /**
     * Pași «analizează»/«verifică» ai importului per utilizator în fereastra `uploadWindowMinutes` (fiecare reparsează
     * fișierul întreg; contor separat de încărcări și de rapoarte).
     */
    stepMaxAttempts: z.number().int().min(1).max(10_000).default(40),
  },
  productExport: {
    /**
     * Rânduri (variante) într-un export de produse. Peste limită exportul se refuză cu un mesaj (se restrânge
     * cu filtre sau cu selecția): fișierul ajunge direct în browser, fără job în fundal. CSV-ul curge din
     * bază pe loturi; XLSX-ul se construiește în memorie, de aceea limita e comună.
     */
    maxRows: z.number().int().min(1).max(100_000).default(20_000),
    /** Exporturi per utilizator în fereastră (contor separat de importuri, media și documente). */
    uploadMaxAttempts: z.number().int().min(1).max(10_000).default(10),
    uploadWindowMinutes: z.number().int().min(1).max(1440).default(10),
    /** Încercări refuzate (origine, sesiune, permisiune) pe IP care mai intră în jurnalul de audit. */
    refusedAuditMaxAttempts: z.number().int().min(1).max(10_000).default(20),
  },
  /**
   * Importul de imagini prin adresă (profilul WooCommerce). SETARE DE SECURITATE: lista de domenii permise se
   * modifică doar cu `settings.write` (Admin, Owner), niciodată din formularul de import. Lista goală = nicio
   * imagine nu se descarcă. Potrivirea e EXACTĂ pe numele gazdei, normalizat (litere mici, fără punct final,
   * punycode); fără wildcard, fără IP, fără port. Lista nu anulează niciodată verificarea adreselor
   * (rețele private, loopback, link-local, metadata): aceea rulează oricum, la fiecare cerere și redirect.
   */
  imageImport: {
    allowedHosts: z
      .array(
        z.string().transform((value, ctx) => {
          const host = normalizeHostname(value);
          if (host === null) {
            ctx.addIssue({
              code: "custom",
              message:
                "Nu e un nume de domeniu valid (fără IP, port, cale, wildcard sau utilizator)",
            });
            return z.NEVER;
          }
          return host;
        }),
      )
      .max(50)
      .default([]),
    /** Mărimea maximă a unei imagini descărcate, în octeți (implicit 15 MB; plafon 50 MB). */
    maxDownloadBytes: z
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(15 * 1024 * 1024),
    connectTimeoutSeconds: z.number().int().min(1).max(30).default(5),
    /** Timpul total al unei descărcări, cu redirecturile incluse. */
    totalTimeoutSeconds: z.number().int().min(2).max(120).default(30),
    /** Redirecturi urmate (doar în cadrul aceleiași gazde, fiecare revalidat); plafon 3. */
    maxRedirects: z.number().int().min(0).max(3).default(3),
    maxUrlLength: z.number().int().min(100).max(4000).default(2000),
    maxImagesPerProduct: z.number().int().min(1).max(30).default(20),
    maxImagesPerImport: z.number().int().min(1).max(20_000).default(2000),
    /** Descărcări simultane, în total și pe aceeași gazdă. */
    concurrency: z.number().int().min(1).max(10).default(3),
    perHostConcurrency: z.number().int().min(1).max(5).default(2),
  },
  monitoring: {
    /** DSN Sentry. Gol = Sentry complet inactiv. Nu e secret (se trimite și în browser). */
    sentryDsn: z
      .string()
      .refine((v) => v === "" || /^https?:\/\/\S+$/.test(v), "DSN invalid")
      .default(""),
  },
  /** Modul de mentenanță al vitrinei: cât e pornit, vizitatorii primesc pagina de mentenanță (503); adminul rămâne accesibil. */
  maintenance: {
    enabled: z.boolean().default(false),
    /** Textul afișat vizitatorilor; gol = textul implicit din mesajele aplicației. */
    message: z.string().trim().max(300).default(""),
  },
  appearance: {
    headerVariant: z.enum(HEADER_VARIANTS).default("default"),
    footerVariant: z.enum(FOOTER_VARIANTS).default("default"),
    containerWidth: z.enum(CONTAINER_WIDTHS).default("xl"),
    cardLayout: z.enum(CARD_LAYOUTS).default("vertical"),
    /** Bara de anunț de deasupra header-ului (o frază scurtă, opțional cu link). Oprită implicit. */
    announcementEnabled: z.boolean().default(false),
    announcementText: z.string().trim().max(ANNOUNCEMENT_MAX_LENGTH).default(""),
    announcementHref: z
      .string()
      .refine(isSafeAnnouncementHref, "Folosește o cale locală (/…) sau o adresă https://")
      .default(""),
    announcementTone: z.enum(ANNOUNCEMENT_TONES).default("brand"),
  },
} as const;

export type SettingGroups = typeof settingGroups;
export type SettingGroupName = keyof SettingGroups;

type NameOf<G extends SettingGroupName> = Extract<keyof SettingGroups[G], string>;

/** Toate cheile complete `grup.nume`. */
export type SettingKey = {
  [G in SettingGroupName]: `${G}.${NameOf<G>}`;
}[SettingGroupName];

type ValueAt<G extends SettingGroupName, N extends string> = N extends keyof SettingGroups[G]
  ? SettingGroups[G][N] extends z.ZodType
    ? z.output<SettingGroups[G][N]>
    : never
  : never;

export type SettingValue<K extends SettingKey> = K extends `${infer G}.${infer N}`
  ? G extends SettingGroupName
    ? ValueAt<G, N>
    : never
  : never;

export type SettingGroupValue<G extends SettingGroupName> = {
  [N in NameOf<G>]: ValueAt<G, N>;
};

/** Schema Zod pentru o cheie; `undefined` dacă cheia nu există în registru. */
export function getSettingSchema(key: string): z.ZodType | undefined {
  const [group, name] = key.split(".");
  if (!group || !name || !Object.hasOwn(settingGroups, group)) return undefined;
  const fields = settingGroups[group as SettingGroupName] as Record<string, z.ZodType>;
  return Object.hasOwn(fields, name) ? fields[name] : undefined;
}

/** Toate cheile din registru, cu grupul lor. */
export function listSettingKeys(): { key: SettingKey; group: SettingGroupName }[] {
  return (Object.keys(settingGroups) as SettingGroupName[]).flatMap((group) =>
    Object.keys(settingGroups[group]).map((name) => ({
      key: `${group}.${name}` as SettingKey,
      group,
    })),
  );
}
