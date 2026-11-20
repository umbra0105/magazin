import type { EmailBlock } from "./blocks";
import {
  TEMPLATE_KEYS,
  type MerchantModel,
  type OrderEmailModel,
  type TemplateContext,
  type TemplateDefinition,
  type TemplateKey,
  type TemplateVariable,
} from "./template-model";

/**
 * Catalogul șabloanelor emailurilor de comenzi (Faza 11, docs/02 §B8). Fiecare șablon are subiect, titlu și text de început
 * implicite (suprascriibile din admin, doar cu variabilele lui) și un corp care NU se suprascrie. Texte în română; nicio
 * valoare de brand: numele magazinului, datele firmei și linkurile vin din `TemplateContext`.
 *
 * Șabloanele cu declanșator în altă fază (retur, cont, marketing) sunt aici cu previzualizare și trimitere de test, dar
 * `wired: false` și fără regulă de declanșare în nucleu; lista și faza responsabilă sunt în `docs/06` (Faza 11).
 */

const v = (name: string, description: string, sample: string): TemplateVariable => ({
  name,
  description,
  sample,
});

const COMMON = {
  magazin: v("magazin", "Numele magazinului", "Magazin Exemplu"),
  client: v("client", "Numele clientului", "Ana Popescu"),
  numar: v("numar", "Numărul comenzii", "WEB-000123"),
  total: v("total", "Totalul comenzii, cu TVA", "1.234,50 RON"),
  link: v("link", "Linkul către urmărirea comenzii", "https://magazin.exemplu/comanda/urmarire"),
} as const;

const para = (text: string, tone?: "muted" | "strong"): EmailBlock => ({
  type: "paragraph",
  text,
  ...(tone ? { tone } : {}),
});

function linesBlock(order: OrderEmailModel): EmailBlock {
  return {
    type: "lines",
    title: "Comanda ta",
    rows: order.lines.map((line) => ({
      title: line.title,
      detail: line.detail,
      quantity: line.quantity,
      amount: line.amount,
    })),
    totals: [
      { label: "Produse", value: order.totals.products },
      { label: "Livrare", value: order.totals.shipping },
      ...(order.totals.codFee ? [{ label: "Taxă de ramburs", value: order.totals.codFee }] : []),
      { label: "din care TVA", value: order.totals.vat },
      { label: "Total de plată (TVA inclus)", value: order.totals.total, strong: true },
    ],
  };
}

function paymentDeliveryBlock(order: OrderEmailModel): EmailBlock {
  return {
    type: "keyvalue",
    title: "Plată și livrare",
    rows: [
      {
        label: "Modalitate de plată",
        value: order.payment.note
          ? `${order.payment.methodLabel}. ${order.payment.note}`
          : order.payment.methodLabel,
      },
      { label: order.delivery.heading, value: order.delivery.text },
      ...(order.delivery.termText
        ? [{ label: "Termen de executare", value: order.delivery.termText }]
        : []),
    ],
  };
}

function merchantRows(merchant: MerchantModel): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [
    { label: "Denumire", value: merchant.legalName || merchant.name },
    { label: "CUI", value: merchant.vatId },
    { label: "Număr de înregistrare la Registrul Comerțului", value: merchant.tradeRegisterNo },
    { label: "Sediul", value: merchant.address },
    { label: "Telefon", value: merchant.phone },
    { label: "Email", value: merchant.email },
  ];
  return rows.filter((row) => row.value.trim() !== "");
}

/** Textul formularului-model de retragere (modelul european), ca text simplu, cu datele comerciantului din setări. */
function withdrawalFormLines(merchant: MerchantModel, orderNumber: string): string[] {
  const to = [merchant.legalName || merchant.name, merchant.address, merchant.email]
    .filter((part) => part.trim() !== "")
    .join(", ");
  return [
    `Către: ${to}`,
    `Vă informez prin prezenta că renunț la contractul de vânzare a următoarelor produse: ______________________ (comanda ${orderNumber}).`,
    "Comandat la data de: __________ / primit la data de: __________",
    "Numele consumatorului: ______________________",
    "Adresa consumatorului: ______________________",
    "Semnătura consumatorului (doar dacă formularul este pe hârtie): __________",
    "Data: __________",
  ];
}

function complaintsParagraphs(context: TemplateContext): string[] {
  const { merchant, legal } = context;
  const contact = [merchant.email, merchant.phone]
    .filter((part) => part.trim() !== "")
    .join(" sau ");
  const out = [
    contact
      ? `Pentru reclamații, ne poți scrie sau suna la ${contact}.`
      : "Pentru reclamații, ne poți contacta la datele din acest email.",
    "Dacă nu ajungem la o înțelegere, poți apela la entitățile de soluționare alternativă a litigiilor și la platforma europeană de soluționare online a litigiilor.",
  ];
  const links = [
    legal.anpcUrl ? `ANPC: ${legal.anpcUrl}` : "",
    legal.salUrl ? `Soluționarea alternativă a litigiilor (SAL): ${legal.salUrl}` : "",
    legal.odrUrl ? `Soluționarea online a litigiilor (SOL): ${legal.odrUrl}` : "",
  ].filter((line) => line !== "");
  return [...out, ...links];
}

/**
 * Informațiile precontractuale din emailul de confirmare: identitatea comerciantului, produsele, prețul total cu taxe și
 * costul livrării, plata, livrarea și termenul, dreptul de retragere, formularul-model, garanția, reclamațiile. Formulările
 * juridice deschise sunt prudente și marcate în `docs/INTREBARI-AVOCAT.md` §9; nu se citează temeiuri legale.
 */
function confirmationLegalBlocks(context: TemplateContext, order: OrderEmailModel): EmailBlock[] {
  const blocks: EmailBlock[] = [
    { type: "keyvalue", title: "Cine ți-a vândut", rows: merchantRows(context.merchant) },
    {
      type: "section",
      title: "Dreptul de retragere (14 zile)",
      paragraphs: [
        "Ai dreptul să te retragi din contract, fără să dai vreun motiv, în 14 zile de la primirea produselor. Pentru a te retrage, ne comunici hotărârea ta în mod clar (de exemplu prin email) sau folosești formularul-model de mai jos.",
        order.hasOnOrderLines
          ? "Comanda ta conține produse «La comandă» (aduse special pentru tine), care sunt o excepție de la dreptul de retragere de 14 zile: pentru ele, condițiile sunt cele comunicate înainte de comandă; ne poți scrie pentru lămuriri."
          : "Excepție: produsele marcate «La comandă» (aduse special pentru tine). Comanda aceasta nu conține astfel de produse.",
      ],
    },
    {
      type: "section",
      title: "Formularul-model de retragere",
      paragraphs: withdrawalFormLines(context.merchant, order.number),
    },
    {
      type: "section",
      title: "Garanția legală",
      paragraphs: [
        "Produsele beneficiază de garanția legală de conformitate. Durata și condițiile ei sunt cele prevăzute de lege; dacă un produs nu corespunde comenzii, ne poți scrie și îți răspundem.",
      ],
    },
    {
      type: "section",
      title: "Reclamații și soluționarea litigiilor",
      paragraphs: complaintsParagraphs(context),
    },
  ];
  return blocks;
}

function orderBody(context: TemplateContext): EmailBlock[] {
  const { order } = context;
  if (!order) return [];
  return [linesBlock(order), paymentDeliveryBlock(order)];
}

const customerVars = (...extra: TemplateVariable[]): TemplateVariable[] => [
  COMMON.magazin,
  COMMON.client,
  COMMON.numar,
  COMMON.total,
  COMMON.link,
  ...extra,
];

const trackButton = (context: TemplateContext, label = "Urmărește comanda"): EmailBlock[] =>
  context.vars["link"] ? [{ type: "button", label, link: context.vars["link"] }] : [];

const DEFINITIONS: readonly TemplateDefinition[] = [
  {
    key: "order.confirmation",
    label: "Confirmare comandă",
    description:
      "Trimis la plasarea comenzii. Conține informațiile precontractuale cerute de lege; acestea nu se pot scoate prin suprascriere.",
    audience: "customer",
    wired: true,
    phaseNote: null,
    variables: customerVars(v("metodaPlata", "Metoda de plată aleasă", "Ramburs")),
    defaultSubject: "Comanda {{numar}} a fost înregistrată – {{magazin}}",
    heading: "Am primit comanda ta",
    preview: "Comanda {{numar}} a fost înregistrată.",
    defaultIntro:
      "Mulțumim pentru comandă! Am înregistrat comanda {{numar}}, în valoare de {{total}}. Mai jos găsești tot ce trebuie să știi despre ea.",
    build: (context) => [
      ...orderBody(context),
      ...trackButton(context),
      ...(context.order ? confirmationLegalBlocks(context, context.order) : []),
    ],
  },
  {
    key: "order.proforma",
    label: "Proformă (transfer bancar)",
    description:
      "Trimis la plasarea unei comenzi cu transfer bancar: datele de plată și termenul până la care ținem produsele rezervate. Factura PDF vine din SmartBill (Faza 13).",
    audience: "customer",
    wired: true,
    phaseNote: null,
    variables: customerVars(v("termen", "Termenul de plată", "luni, 24 noiembrie 2026, ora 23:59")),
    defaultSubject: "Plata comenzii {{numar}} prin transfer bancar – {{magazin}}",
    heading: "Datele pentru plata prin transfer bancar",
    preview: "Plătește comanda {{numar}} până la {{termen}}.",
    defaultIntro:
      "Ai ales plata prin transfer bancar pentru comanda {{numar}}. Plătește suma de {{total}} până la {{termen}}; până atunci îți rezervăm produsele, iar după termen comanda se anulează automat.",
    build: (context) => [
      {
        type: "keyvalue",
        title: "Datele de plată",
        rows: [
          { label: "Beneficiar", value: context.merchant.legalName || context.merchant.name },
          { label: "IBAN", value: context.merchant.iban },
          { label: "Banca", value: context.merchant.bankName },
          { label: "Suma de plată", value: context.vars["total"] ?? "" },
          { label: "Detalii plată", value: `Comanda ${context.vars["numar"] ?? ""}` },
          { label: "Termen", value: context.vars["termen"] ?? "" },
        ].filter((row) => row.value.trim() !== ""),
      },
      ...trackButton(context),
    ],
  },
  {
    key: "order.payment_received",
    label: "Plată primită",
    description: "Trimis când plata comenzii a fost confirmată (card sau transfer bancar).",
    audience: "customer",
    wired: true,
    phaseNote: null,
    variables: customerVars(),
    defaultSubject: "Am primit plata pentru comanda {{numar}} – {{magazin}}",
    heading: "Plata a fost primită",
    preview: "Plata pentru comanda {{numar}} a fost confirmată.",
    defaultIntro:
      "Am primit plata de {{total}} pentru comanda {{numar}}. Comanda ta este confirmată și trece la pregătire.",
    build: (context) => [...orderBody(context), ...trackButton(context)],
  },
  {
    key: "order.payment_failed",
    label: "Plată eșuată",
    description:
      "Trimis când o plată cu cardul eșuează. Conține linkul «reîncearcă plata», valabil cât timp comanda rămâne în așteptare.",
    audience: "customer",
    wired: true,
    phaseNote: null,
    variables: customerVars(
      v(
        "linkPlata",
        "Linkul pentru reîncercarea plății",
        "https://magazin.exemplu/comanda/plateste/exemplu",
      ),
      v("termen", "Până când poți reîncerca plata", "marți, 25 noiembrie 2026, ora 12:00"),
    ),
    defaultSubject: "Plata comenzii {{numar}} nu a reușit – {{magazin}}",
    heading: "Plata nu a reușit",
    preview: "Poți reîncerca plata comenzii {{numar}}.",
    defaultIntro:
      "Plata cu cardul pentru comanda {{numar}} nu a reușit. Nu ți s-a luat nicio sumă. Poți reîncerca până la {{termen}}; produsele nu sunt rezervate între încercări.",
    build: (context) => [
      ...(context.vars["linkPlata"]
        ? [
            {
              type: "button",
              label: "Reîncearcă plata",
              link: context.vars["linkPlata"],
            } satisfies EmailBlock,
          ]
        : []),
      para("După termen, comanda se anulează automat.", "muted"),
      ...orderBody(context),
    ],
  },
  {
    key: "order.processing",
    label: "Comandă în procesare",
    description: "Trimis când comanda trece în procesare (pregătire).",
    audience: "customer",
    wired: true,
    phaseNote: null,
    variables: customerVars(),
    defaultSubject: "Comanda {{numar}} este în pregătire – {{magazin}}",
    heading: "Comanda ta este în pregătire",
    preview: "Pregătim comanda {{numar}}.",
    defaultIntro: "Am început pregătirea comenzii {{numar}}. Te anunțăm când este expediată.",
    build: (context) => [...orderBody(context), ...trackButton(context)],
  },
  {
    key: "order.shipped",
    label: "Comandă expediată",
    description:
      "Trimis la evenimentul «comandă expediată», cu AWB-ul dacă există. Declanșatorul e legat de eveniment; AWB-ul și evenimentul vin din Faza 12.",
    audience: "customer",
    wired: true,
    phaseNote:
      "Evenimentul `order.shipped` (cu `awb` și `carrier` în date) vine din Faza 12; șablonul și regula de declanșare există acum.",
    variables: customerVars(
      v("curier", "Numele curierului", "Curier Demo"),
      v("awb", "Numărul AWB", "1234567890"),
    ),
    defaultSubject: "Comanda {{numar}} a fost expediată – {{magazin}}",
    heading: "Comanda ta a fost expediată",
    preview: "Comanda {{numar}} este pe drum.",
    defaultIntro: "Comanda {{numar}} a fost predată curierului și este pe drum către tine.",
    build: (context) => [
      ...(context.vars["awb"]
        ? [
            {
              type: "keyvalue",
              title: "Urmărirea coletului",
              rows: [
                ...(context.vars["curier"]
                  ? [{ label: "Curier", value: context.vars["curier"] }]
                  : []),
                { label: "AWB", value: context.vars["awb"] },
              ],
            } satisfies EmailBlock,
          ]
        : []),
      ...orderBody(context),
      ...trackButton(context),
    ],
  },
  {
    key: "order.delivered",
    label: "Comandă livrată",
    description:
      "Trimis la evenimentul «comandă livrată». Evenimentul vine din Faza 12 (sincronizarea stării de la curier).",
    audience: "customer",
    wired: true,
    phaseNote:
      "Evenimentul `order.delivered` vine din Faza 12; șablonul și regula de declanșare există acum.",
    variables: customerVars(),
    defaultSubject: "Comanda {{numar}} a fost livrată – {{magazin}}",
    heading: "Comanda ta a fost livrată",
    preview: "Comanda {{numar}} a fost livrată.",
    defaultIntro:
      "Comanda {{numar}} a fost livrată. Îți mulțumim că ai cumpărat de la {{magazin}}!",
    build: (context) => [...trackButton(context, "Vezi comanda")],
  },
  {
    key: "order.cancelled",
    label: "Comandă anulată",
    description:
      "Trimis când o comandă este anulată (de magazin sau automat, la expirarea termenului de plată).",
    audience: "customer",
    wired: true,
    phaseNote: null,
    variables: customerVars(
      v("motiv", "Motivul anulării", "Termenul de plată a expirat"),
      v(
        "notaPlata",
        "Nota despre plată, când comanda fusese plătită",
        "Ai plătit această comandă: te anunțăm printr-un email separat când rambursarea este confirmată.",
      ),
    ),
    defaultSubject: "Comanda {{numar}} a fost anulată – {{magazin}}",
    heading: "Comanda ta a fost anulată",
    preview: "Comanda {{numar}} a fost anulată.",
    defaultIntro: "Comanda {{numar}} a fost anulată. Motiv: {{motiv}}.",
    build: (context) => [
      ...(context.vars["notaPlata"] ? [para(context.vars["notaPlata"])] : []),
      ...orderBody(context),
    ],
  },
  {
    key: "order.refunded",
    label: "Rambursare confirmată",
    description:
      "Trimis o singură dată pentru fiecare rambursare CONFIRMATĂ (niciodată înainte de confirmare).",
    audience: "customer",
    wired: true,
    phaseNote: null,
    variables: customerVars(v("suma", "Suma rambursată", "250,00 RON")),
    defaultSubject: "Rambursare confirmată pentru comanda {{numar}} – {{magazin}}",
    heading: "Rambursarea a fost confirmată",
    preview: "Am rambursat {{suma}} pentru comanda {{numar}}.",
    defaultIntro:
      "Rambursarea de {{suma}} pentru comanda {{numar}} a fost confirmată. Banii ajung în contul tău în funcție de banca ta.",
    build: (context) => [...trackButton(context, "Vezi comanda")],
  },
  {
    key: "order.stock_lost",
    label: "Plată primită după expirarea rezervării",
    description:
      "Trimis când o plată cu cardul ajunge după expirarea rezervării și produsele nu mai sunt în stoc: comanda e anulată, iar suma va fi returnată. Formularea: docs/INTREBARI-AVOCAT §8.1; nu spune «rambursat» până nu e confirmat.",
    audience: "customer",
    wired: true,
    phaseNote: null,
    variables: customerVars(),
    defaultSubject: "Comanda {{numar}} a fost anulată, iar suma va fi returnată – {{magazin}}",
    heading: "Comanda a fost anulată",
    preview: "Comanda {{numar}} a fost anulată; suma plătită va fi returnată.",
    defaultIntro:
      "Plata a ajuns după expirarea rezervării, iar produsele nu mai sunt în stoc. Comanda {{numar}} a fost anulată, iar suma plătită va fi returnată.",
    build: (context) => [
      para(
        "Te anunțăm printr-un email separat când rambursarea este confirmată. În unele cazuri rambursarea cere o acțiune manuală din partea noastră; nu trebuie să faci nimic.",
        "muted",
      ),
      ...orderBody(context),
    ],
  },
  {
    key: "offer.payment_link",
    label: "Oferta de plată: linkul către client",
    description:
      "Trimis clientului când adminul îi trimite o ofertă de plată (link personal către o pagină cu produsele, livrarea și plata cu cardul). Linkul nu e o comandă și nu confirmă nimic: comanda se creează abia la plată. Emailul nu se retrimite singur: o retrimitere generează un link nou, iar cel vechi nu mai merge.",
    audience: "customer",
    wired: true,
    phaseNote: null,
    variables: [
      COMMON.magazin,
      COMMON.client,
      v("numar", "Numărul ofertei", "OF-0012"),
      v("total", "Totalul ofertei, cu TVA", "1.234,50 RON"),
      v("expira", "Până când e valabilă oferta", "vineri, 20 noiembrie 2026, 18:00"),
      v("link", "Linkul personal al ofertei", "https://magazin.exemplu/oferta/exemplu"),
    ],
    defaultSubject: "Oferta {{numar}} de la {{magazin}}: {{total}}",
    heading: "Oferta ta de plată",
    preview: "Oferta {{numar}}, {{total}}: verifică-o și plătește cu cardul.",
    defaultIntro:
      "Ți-am pregătit oferta {{numar}}, în valoare de {{total}}. Deschide pagina ofertei, verifică produsele și livrarea și plătește cu cardul.",
    build: (context) => [
      ...(context.vars["link"]
        ? [
            {
              type: "button",
              label: "Vezi oferta și plătește",
              link: context.vars["link"],
            } satisfies EmailBlock,
          ]
        : []),
      para(
        "Oferta este valabilă până la {{expira}}. Linkul este personal: nu îl da mai departe. Comanda se creează abia când plătești.".replace(
          "{{expira}}",
          context.vars["expira"] ?? "",
        ),
        "muted",
      ),
    ],
  },
  {
    key: "internal.order_new",
    label: "Notificare internă: comandă nouă",
    description: "Trimis echipei (setarea `email.internalRecipients`) la fiecare comandă nouă.",
    audience: "internal",
    wired: true,
    phaseNote: null,
    variables: [
      COMMON.magazin,
      COMMON.numar,
      COMMON.total,
      v("client", "Numele clientului", "Ana Popescu"),
      v("metodaPlata", "Metoda de plată", "Ramburs"),
      v("linkAdmin", "Linkul comenzii în admin", "https://magazin.exemplu/admin/comenzi/exemplu"),
    ],
    defaultSubject: "Comandă nouă {{numar}} – {{total}}",
    heading: "Comandă nouă",
    preview: "Comandă nouă {{numar}}, {{total}}.",
    defaultIntro:
      "A intrat comanda {{numar}} de la {{client}}, în valoare de {{total}} ({{metodaPlata}}).",
    build: (context) => [
      ...orderBody(context),
      ...(context.vars["linkAdmin"]
        ? [
            {
              type: "button",
              label: "Deschide comanda",
              link: context.vars["linkAdmin"],
            } satisfies EmailBlock,
          ]
        : []),
    ],
  },
  {
    key: "internal.stock_out",
    label: "Notificare internă: stoc epuizat",
    description:
      "Trimis echipei când un produs gestionat ajunge la stoc disponibil 0 după o comandă.",
    audience: "internal",
    wired: true,
    phaseNote: null,
    variables: [
      COMMON.magazin,
      v("produs", "Numele produsului", "Pompă de căldură 12 kW"),
      v("sku", "SKU-ul", "PC-12KW"),
      v("linkAdmin", "Linkul stocului în admin", "https://magazin.exemplu/admin/produse/stoc"),
    ],
    defaultSubject: "Stoc epuizat: {{produs}} ({{sku}})",
    heading: "Stoc epuizat",
    preview: "{{produs}} a rămas fără stoc disponibil.",
    defaultIntro: "Produsul {{produs}} ({{sku}}) a rămas fără stoc disponibil.",
    build: (context) =>
      context.vars["linkAdmin"]
        ? [{ type: "button", label: "Vezi stocul", link: context.vars["linkAdmin"] }]
        : [],
  },
  {
    key: "internal.installation_request",
    label: "Notificare internă: cerere de instalare",
    description:
      "Trimis echipei (setarea `email.internalRecipients`) când o comandă are cerere de ofertă pentru instalare (docs/15 §4); statusul de urmărire se schimbă din «Cereri de instalare».",
    audience: "internal",
    wired: true,
    phaseNote: null,
    variables: [
      COMMON.magazin,
      COMMON.numar,
      v("client", "Numele clientului", "Ana Popescu"),
      v(
        "nota",
        "Observațiile clientului (tip de piscină, locație, acces)",
        "Piscină 8x4 m, acces cu camionul",
      ),
      v("linkAdmin", "Linkul comenzii în admin", "https://magazin.exemplu/admin/comenzi/exemplu"),
    ],
    defaultSubject: "Cerere de instalare la comanda {{numar}}",
    heading: "Cerere de instalare",
    preview: "Comanda {{numar}} cere ofertă pentru instalare.",
    defaultIntro:
      "Clientul {{client}} a cerut o ofertă pentru instalare la comanda {{numar}}. Contactează-l telefonic. Observații: {{nota}}",
    build: (context) => [
      ...(context.vars["linkAdmin"]
        ? [
            {
              type: "button",
              label: "Deschide comanda",
              link: context.vars["linkAdmin"],
            } satisfies EmailBlock,
          ]
        : []),
    ],
  },
  {
    key: "internal.stock_sync_stale",
    label: "Alertă internă: sincronizarea SmartBill e neactualizată",
    description:
      "Trimis o singură dată pe episod, către utilizatorii activi cu email verificat și permisiunea de stoc (reverificați la fiecare trimitere).",
    audience: "internal",
    wired: true,
    phaseNote: null,
    variables: [
      COMMON.magazin,
      v("ultima", "Ultima sincronizare reușită", "ieri, 03:30"),
      v("linkAdmin", "Linkul stocului în admin", "https://magazin.exemplu/admin/produse/stoc"),
    ],
    defaultSubject: "Sincronizarea stocului din SmartBill e neactualizată – {{magazin}}",
    heading: "Sincronizarea SmartBill e neactualizată",
    preview: "Stocul nu s-a mai sincronizat din SmartBill.",
    defaultIntro:
      "Stocul nu s-a mai sincronizat din SmartBill de la {{ultima}}. Disponibilitatea din magazin poate fi depășită până la următoarea sincronizare.",
    build: (context) =>
      context.vars["linkAdmin"]
        ? [{ type: "button", label: "Vezi stocul", link: context.vars["linkAdmin"] }]
        : [],
  },
  // --- șabloane înregistrate, declanșatorul vine în altă fază ---
  ...(
    [
      [
        "return.received",
        "Retur primit",
        "Cererea ta de retur a fost primită",
        "Am primit cererea ta de retur pentru comanda {{numar}}. Revenim cu un răspuns.",
        "Faza 14 (retururi)",
      ],
      [
        "return.approved",
        "Retur aprobat",
        "Returul a fost aprobat",
        "Returul pentru comanda {{numar}} a fost aprobat. Îți trimitem pașii următori.",
        "Faza 14 (retururi)",
      ],
      [
        "return.rejected",
        "Retur respins",
        "Returul nu a putut fi aprobat",
        "Returul pentru comanda {{numar}} nu a putut fi aprobat. Motivul îți este comunicat de echipa noastră.",
        "Faza 14 (retururi)",
      ],
    ] as const
  ).map(([key, label, heading, intro, phase]): TemplateDefinition => ({
    key,
    label,
    description: `Șablon înregistrat; declanșatorul vine în ${phase}.`,
    audience: "customer",
    wired: false,
    phaseNote: `Declanșatorul se leagă în ${phase}.`,
    variables: customerVars(),
    defaultSubject: `${heading} – {{magazin}}`,
    heading,
    preview: heading,
    defaultIntro: intro,
    build: (context) => trackButton(context, "Vezi comanda"),
  })),
  {
    key: "account.welcome",
    label: "Bun venit",
    description: "Șablon înregistrat; declanșatorul vine în Faza 14 (cont client).",
    audience: "customer",
    wired: false,
    phaseNote: "Declanșatorul se leagă în Faza 14 (cont client).",
    variables: [COMMON.magazin, COMMON.client, COMMON.link],
    defaultSubject: "Bine ai venit la {{magazin}}",
    heading: "Bine ai venit",
    preview: "Contul tău la {{magazin}} este gata.",
    defaultIntro: "Contul tău la {{magazin}} este gata. Îți mulțumim că te-ai înscris!",
    build: () => [],
  },
  ...(
    [
      [
        "marketing.abandoned_cart_1",
        "Coș abandonat (1)",
        "Ai uitat ceva în coș",
        "Ai lăsat produse în coș la {{magazin}}. Le păstrăm pentru tine cât timp sunt disponibile.",
      ],
      [
        "marketing.abandoned_cart_2",
        "Coș abandonat (2)",
        "Produsele tale te așteaptă",
        "Produsele din coșul tău sunt încă disponibile la {{magazin}}.",
      ],
      [
        "marketing.abandoned_cart_3",
        "Coș abandonat (3)",
        "Ultima reamintire despre coșul tău",
        "Aceasta este ultima reamintire despre produsele din coșul tău de la {{magazin}}.",
      ],
    ] as const
  ).map(([key, label, heading, intro]): TemplateDefinition => ({
    key,
    label,
    description: "Șablon înregistrat; declanșatorul și dezabonarea vin în Faza 17 (marketing).",
    audience: "customer",
    wired: false,
    phaseNote: "Declanșatorul se leagă în Faza 17 (marketing, cu dezabonare).",
    variables: [COMMON.magazin, COMMON.client, COMMON.link],
    defaultSubject: `${heading} – {{magazin}}`,
    heading,
    preview: heading,
    defaultIntro: intro,
    build: (context) =>
      context.vars["link"]
        ? [{ type: "button", label: "Înapoi la coș", link: context.vars["link"] }]
        : [],
  })),
  {
    key: "marketing.review_request",
    label: "Cerere de recenzie",
    description: "Șablon înregistrat; declanșatorul vine în Faza 17 (recenzii).",
    audience: "customer",
    wired: false,
    phaseNote: "Declanșatorul se leagă în Faza 17 (recenzii).",
    variables: customerVars(),
    defaultSubject: "Cum a fost comanda {{numar}}? – {{magazin}}",
    heading: "Spune-ne cum a fost",
    preview: "Părerea ta contează.",
    defaultIntro:
      "Ți-a plăcut ce ai comandat de la {{magazin}}? Părerea ta ne ajută pe noi și pe ceilalți clienți.",
    build: (context) => trackButton(context, "Scrie o recenzie"),
  },
  {
    key: "marketing.newsletter",
    label: "Newsletter",
    description: "Șablon înregistrat; trimiterea și dezabonarea vin în Faza 17 (newsletter).",
    audience: "customer",
    wired: false,
    phaseNote: "Declanșatorul se leagă în Faza 17 (newsletter, cu dublu opt-in și dezabonare).",
    variables: [COMMON.magazin, COMMON.client],
    defaultSubject: "Noutăți de la {{magazin}}",
    heading: "Noutăți",
    preview: "Noutăți de la {{magazin}}.",
    defaultIntro: "Iată ce e nou la {{magazin}}.",
    build: () => [],
  },
];

export const TEMPLATE_CATALOG: readonly TemplateDefinition[] = DEFINITIONS;

export function templateDefinition(key: string): TemplateDefinition | null {
  return DEFINITIONS.find((definition) => definition.key === key) ?? null;
}

export function isTemplateKey(value: string): value is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(value);
}

/** Variabilele unui șablon cu valorile de probă (previzualizare și email de test). */
export function sampleVars(definition: TemplateDefinition): Record<string, string> {
  return Object.fromEntries(
    definition.variables.map((variable) => [variable.name, variable.sample]),
  );
}
