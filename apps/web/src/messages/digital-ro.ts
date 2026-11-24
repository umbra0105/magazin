/**
 * Textele produselor digitale (Faza 14b): pagina produsului, biblioteca clientului (`/cont/produsele-mele`), erorile accesului,
 * regula ramburs mixt și bifa legală din checkout. Nicio valoare de business nu e scrisă în text (limite, durate): apare ca
 * parametru din setări sau din date. Textul bifei legale NU e aici: vine din setarea `digital.consentText` sau din textul implicit
 * din `@ecom/core` (de confirmat cu avocatul, INTREBARI-AVOCAT 5.2).
 */
export const digitalRo = {
  errors: {
    DIGITAL_NOT_FOUND: "Produsul nu a fost găsit în contul tău.",
    DIGITAL_REVOKED:
      "Accesul la acest produs a fost retras. Dacă crezi că e o greșeală, scrie-ne și îl verificăm.",
    DIGITAL_EXPIRED: "Accesul la acest produs a expirat.",
    DIGITAL_LIMIT_REACHED:
      "Ai atins limita de descărcări pentru acest produs. Scrie-ne dacă ai nevoie de acces suplimentar.",
    DIGITAL_ASSET_UNAVAILABLE:
      "Modulul se pregătește sau nu mai este disponibil. Încearcă mai târziu.",
    DIGITAL_PROVIDER_UNAVAILABLE:
      "Livrarea conținutului nu este disponibilă acum. Încearcă din nou în câteva minute.",
    DIGITAL_INPUT_INVALID: "Cererea nu este validă.",
    rateLimited: "Prea multe cereri într-un timp scurt. Încearcă din nou peste câteva minute.",
    failed: "Nu am putut deschide conținutul. Încearcă din nou.",
  } as Record<string, string>,
  library: {
    navLabel: "Produsele mele digitale",
    metaTitle: "Produsele mele digitale",
    title: "Produsele mele digitale",
    lede: "Aici găsești cursurile și fișierele cumpărate. Linkurile de acces se creează la fiecare deschidere și expiră repede.",
    empty: "Nu ai încă produse digitale.",
    emptyAction: "Vezi produsele",
    open: "Deschide",
    order: "Comanda",
    granted: "Acces din",
    modules: (n: number) => (n === 1 ? "1 modul" : n < 20 ? `${n} module` : `${n} de module`),
    downloadsLeft: (left: number, max: number) => `Descărcări rămase: ${left} din ${max}`,
    downloadsUnlimited: "Descărcări fără limită",
    statusActive: "Activ",
    statusRevoked: "Revocat",
    revokedReason: (reason: string) => `Motiv: ${reason}`,
    pendingTitle: "În așteptare",
    awaitingPayment: "În așteptarea plății",
    awaitingDelivery: "În așteptarea livrării",
    awaitingPaymentText: (order: string) =>
      `Accesul se activează după confirmarea plății comenzii ${order}.`,
    awaitingDeliveryText: (order: string) =>
      `Comanda ${order} se plătește la livrare: accesul se activează după ce coletul ajunge la tine și livrarea e confirmată, nu la plata către curier.`,
  },
  detail: {
    back: "Înapoi la produsele mele",
    notFoundTitle: "Produsul nu a fost găsit",
    order: "Comanda",
    granted: "Acces din",
    revokedBanner: "Accesul la acest produs a fost retras.",
    noModules: "Produsul nu are încă module disponibile.",
    modulesTitle: "Module",
    play: "Vizionează",
    close: "Închide playerul",
    download: "Descarcă",
    open: "Deschide resursa",
    preparing: "Se pregătește…",
    failedModule: "Modulul nu este disponibil",
    video: "Video",
    file: "Fișier",
    link: "Resursă externă",
    duration: (seconds: number) => {
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return `${m}:${String(s).padStart(2, "0")} min`;
    },
    size: (bytes: number) =>
      bytes >= 1_048_576
        ? `${(bytes / 1_048_576).toFixed(1).replace(".", ",")} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} KB`,
    playerTitle: (title: string) => `Player: ${title}`,
    downloadsLeft: (left: number, max: number) => `Descărcări rămase: ${left} din ${max}`,
    downloadsUnlimited: "Descărcări fără limită",
    watermarkNote: "Pe video apare emailul tău ca filigran.",
    linkNote: "Linkurile de acces expiră în scurt timp; se creează din nou la fiecare deschidere.",
    contact: "Probleme cu accesul? Scrie-ne.",
  },
  product: {
    sectionTitle: "Conținut digital",
    badgeInstant: "Acces imediat după plată",
    badgeLifetime: "Acces pe viață",
    whatYouGet: "Ce primești",
    requirements: "Cerințe",
    format: "Format",
    modules: "Module",
    previewBadge: "Previzualizare gratuită",
    previewButton: "Vezi previzualizarea",
    previewClose: "Închide previzualizarea",
    previewFailed: "Previzualizarea nu este disponibilă acum.",
    accountNote: "Ai nevoie de un cont pentru a cumpăra și a accesa produsul.",
    downloads: (n: number) =>
      n === 1
        ? "Poți descărca fișierele o singură dată."
        : `Poți descărca fișierele de cel mult ${n} ori.`,
    codNote:
      "La comenzile mixte cu plata la livrare, accesul digital se activează după livrarea confirmată a produselor fizice.",
  },
  /** Finalizarea comenzii cu produse digitale (Faza 14c). Textul bifei legale vine din setare sau din textul implicit din `@ecom/core`. */
  checkout: {
    accountNote: (email: string) =>
      `Comanzi cu contul ${email}. Produsele digitale apar în contul tău, la «Produsele mele digitale».`,
    onlyDigitalNote:
      "Comanda are doar produse digitale: nu se livrează nimic și nu e nevoie de adresă de livrare.",
    billingLede: "Completează datele de facturare. Nu există livrare, deci nu ți-o cerem.",
    consentTitle: "Livrare imediată a conținutului digital",
    consentRequired:
      "Bifează solicitarea de livrare imediată ca să poți plasa o comandă cu produse digitale.",
    accessCard:
      "Accesul la produsele digitale se activează imediat ce plata cu cardul e confirmată.",
    accessTransfer:
      "Accesul la produsele digitale se activează după ce confirmăm plata prin transfer bancar.",
    accessCod:
      "Plata la livrare: produsele digitale se activează abia după livrarea confirmată a produselor fizice, nu la plata către curier.",
    summaryDigital: "Produse digitale: acces în cont, fără livrare",
    verifyTitle: "Confirmă adresa de email",
    verifyLede:
      "Produsele digitale se comandă doar cu un cont cu emailul confirmat. Ți-am trimis un mesaj cu linkul de confirmare; după ce îl deschizi, revino aici.",
    verifyResend: "Trimite din nou emailul de confirmare",
    verifyResent: "Am trimis din nou emailul de confirmare.",
    verifyFailed: "Nu am putut trimite emailul acum. Încearcă din nou peste puțin timp.",
    verifyReload: "Am confirmat emailul",
  },
} as const;
