import type { EmailBlock } from "./blocks";

/**
 * Modelul din care se randează emailurile de comenzi (Faza 11). Tot ce e aici vine DEJA formatat de nucleu (sume, date, texte
 * de livrare): șabloanele nu calculează și nu citesc baza de date. Datele comerciantului vin din setări (`company.*`, `legal.*`);
 * nimic din ele nu e scris în șabloane.
 */
export interface MerchantModel {
  /** Numele magazinului (`general.storeName`). */
  name: string;
  legalName: string;
  vatId: string;
  tradeRegisterNo: string;
  /** Adresa în formatul unic al magazinului (`formatCompanyAddress`). */
  address: string;
  phone: string;
  email: string;
  iban: string;
  bankName: string;
}

export interface LegalLinksModel {
  anpcUrl: string;
  salUrl: string;
  odrUrl: string;
}

export interface OrderLineModel {
  title: string;
  /** Varianta, dacă există («Culoare: albastru»). */
  detail: string | null;
  /** Cantitatea cu unitatea («2 buc», «6,09 mp»). */
  quantity: string;
  /** Totalul liniei, cu TVA inclus. */
  amount: string;
}

export interface OrderEmailModel {
  number: string;
  placedAt: string;
  lines: readonly OrderLineModel[];
  totals: {
    products: string;
    shipping: string;
    /** `null` fără taxă de ramburs. */
    codFee: string | null;
    /** Reducerea din puncte de loialitate, cu minus; lipsește fără puncte folosite. */
    pointsDiscount?: string;
    /** TVA-ul inclus în total (informativ). */
    vat: string;
    total: string;
  };
  payment: {
    method: "cod" | "bank_transfer" | "card";
    methodLabel: string;
    /** Explicația metodei («Plătești în magazin la ridicare»), dacă există. */
    note: string | null;
  };
  delivery: {
    kind: "courier" | "pickup" | "digital";
    /** «Livrare la adresa» / «Ridicare personală de la». */
    heading: string;
    /** Adresa de livrare (localitatea) sau adresa MAGAZINULUI din snapshot, niciodată adresa clientului la ridicare. */
    text: string;
    /** Termenul de execuție în clar («aproximativ 3 zile»), dacă se cunoaște. */
    termText: string | null;
    /** Doar ridicarea personală: programul de ridicare (setarea `company.pickupHours`), doar când e completat. */
    pickupHoursText?: string | null;
  };
  /** Punctele comenzii (Faza 15b), deja scrise («20 de puncte»): folosite și de primit; `null` = niciunul. */
  loyalty?: { pointsUsed: string | null; pointsToEarn: string | null };
  /** Cel puțin o linie «La comandă»: se adaugă nota despre retragere. */
  hasOnOrderLines: boolean;
  /**
   * Produsele digitale ale comenzii (Faza 14b): textul EXACT al bifei de renunțare la dreptul de retragere, reluat în confirmare
   * (dovada pe suport durabil), și regula accesului (după plată, sau după livrarea confirmată la ramburs mixt).
   */
  digital?: {
    consentText: string | null;
    accessRule: "after_payment" | "after_delivery";
  } | null;
}

export interface TemplateContext {
  /** Variabilele pentru subiect și text (`{{nume}}`), toate șiruri. */
  vars: Readonly<Record<string, string>>;
  merchant: MerchantModel;
  legal: LegalLinksModel;
  order: OrderEmailModel | null;
}

export interface TemplateVariable {
  name: string;
  description: string;
  /** Valoarea din previzualizare și din emailul de test. */
  sample: string;
}

export const TEMPLATE_KEYS = [
  "order.confirmation",
  "order.proforma",
  "order.payment_received",
  "order.payment_failed",
  "order.processing",
  "order.shipped",
  "order.delivered",
  "order.cancelled",
  "order.refunded",
  "digital.ready",
  "order.stock_lost",
  "offer.payment_link",
  "internal.order_new",
  "internal.stock_out",
  "internal.installation_request",
  "internal.stock_sync_stale",
  "internal.invoice_failed",
  "return.received",
  "return.approved",
  "return.awb",
  "return.rejected",
  "return.parcel_received",
  "return.inspected",
  "return.refunded",
  "return.cancelled",
  "return.refunded_points",
  "loyalty.expiry_warning",
  "account.welcome",
  "marketing.abandoned_cart_1",
  "marketing.abandoned_cart_2",
  "marketing.abandoned_cart_3",
  "marketing.review_request",
  "marketing.newsletter",
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export interface TemplateDefinition {
  key: TemplateKey;
  label: string;
  description: string;
  audience: "customer" | "internal";
  /**
   * Declanșatorul e legat acum la un `OrderEvent` sau la o alertă (`true`) sau șablonul e doar în catalog, cu previzualizare și
   * trimitere de test, iar declanșatorul vine în altă fază (`false`, cu `phaseNote`).
   */
  wired: boolean;
  phaseNote: string | null;
  variables: readonly TemplateVariable[];
  /** Subiectul, titlul și textul de început implicite: pot conține `{{variabile}}` din lista de mai sus. */
  defaultSubject: string;
  heading: string;
  preview: string;
  defaultIntro: string;
  /** Conținutul care NU se suprascrie (informațiile comenzii și cele obligatorii legal). */
  build(context: TemplateContext): EmailBlock[];
}
