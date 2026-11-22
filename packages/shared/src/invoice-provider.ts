import type { ConnectionTestResult } from "./payment-provider";

/**
 * Contractul furnizorilor de facturare (Faza 13): interfața `InvoiceProvider` pe care o implementează adaptoarele SmartBill și
 * DEMO (Oblio ar putea veni mai târziu prin aceeași interfață). Tipurile sunt doar de date simple, ca adaptoarele din
 * `@ecom/integrations` să nu depindă de logica de business. Sumele sunt `int` în bani, CU TVA inclus (ca pe comandă);
 * cantitățile sunt în zecimi de miime (`bigint`), cu cel mult 2 zecimale (SmartBill).
 *
 * Seria și numărul le definește furnizorul: aplicația nu numerotează niciodată. Date personale: către furnizor pleacă DOAR ce cere
 * factura (nume, adresă de facturare, CUI, produse, sume); nimic din ele nu intră în loguri, notificări sau mesaje de eroare (un
 * adaptor nu pune niciodată în mesaj corpul cererii sau al răspunsului). Costul de achiziție NU apare niciodată în acest contract.
 */

export const INVOICE_PROVIDER_CODES = ["smartbill", "demo"] as const;
export type InvoiceProviderCode = (typeof INVOICE_PROVIDER_CODES)[number];

export type InvoiceMode = "test" | "live";

/** Starea e-Factura a unui document. SmartBill nu o expune prin API: `unknown`. */
export const EFACTURA_STATUSES = [
  "not_applicable",
  "unknown",
  "pending",
  "sent",
  "validated",
  "error",
] as const;
export type EfacturaStatus = (typeof EFACTURA_STATUSES)[number];

/** Clientul de pe document (adresa de facturare a comenzii). */
export interface InvoiceClient {
  name: string;
  /** CUI/CIF, doar la persoane juridice. */
  vatCode: string | null;
  isTaxPayer: boolean;
  regCom: string | null;
  address: string;
  city: string;
  county: string;
  country: string;
  email: string | null;
  phone: string | null;
}

export type InvoiceLineKind = "product" | "shipping" | "cod_fee";

export interface InvoiceDocLine {
  kind: InvoiceLineKind;
  name: string;
  /** SKU-ul (doar la produse). */
  code: string | null;
  /** Numele unității de măsură, exact ca în contul furnizorului. */
  unitName: string;
  /** Zecimi de miime de unitate; multiplu de 100 (cel mult 2 zecimale). Negativ la stornoul parțial. */
  quantityTicks: bigint;
  /** Preț unitar, bani, cu TVA inclus. */
  unitPriceMinor: number;
  /** Totalul liniei, bani, cu TVA inclus, EXACT ce a încasat magazinul pe această linie (negativ la stornoul parțial). */
  lineTotalMinor: number;
  taxMinor: number;
  taxRateBps: number;
  /** Descarcă din gestiune (doar produse cu stoc gestionat). */
  dischargeStock: boolean;
}

export interface InvoiceRequest {
  /** Numărul comenzii: pus în observații ca documentul să poată fi regăsit. */
  orderNumber: string;
  client: InvoiceClient;
  lines: readonly InvoiceDocLine[];
  currency: string;
  issueDate: Date;
  /** Descarcă stocul la emitere: doar când TOATE liniile de produs sunt gestionate (SmartBill: o singură bifă pe factură). */
  useStock: boolean;
  /** Încasarea trecută pe document la emitere (card: la plata confirmată; transfer: după confirmarea adminului). */
  payment: { type: InvoicePaymentType; valueMinor: number } | null;
  /** Proforma pe care o încheie această factură (transfer bancar), dacă există. */
  fromProforma: DocumentRef | null;
  /** Documentul trimite emailul către client prin furnizor (setare; implicit oprit). */
  sendEmail: boolean;
}

export type InvoicePaymentType = "Card online" | "Ordin plata" | "Ramburs";

/** Referința unui document la furnizor. */
export interface DocumentRef {
  series: string;
  number: string;
}

export interface IssuedDocument extends DocumentRef {
  /** Identificatorul intern al documentului la furnizor. */
  providerRef: string;
  /** Link de vizualizare dat de furnizor (poate conține un hash); doar pentru admin. */
  viewUrl: string | null;
  /** Documentul NU e fiscal (furnizorul DEMO). */
  simulated: boolean;
  efacturaStatus: EfacturaStatus;
  /**
   * Furnizorul A DESCĂRCAT stocul la emitere. Doar atunci ora facturii intră pe angajările de stoc (`markInvoiced`): dacă adaptorul
   * a emis fără descărcare (de exemplu fără gestiune configurată), bucățile rămân angajate până la o sincronizare cu descărcarea reală.
   */
  stockDischarged: boolean;
  /** Totalul confirmat de furnizor (bani), sau `null` dacă furnizorul nu îl poate citi. */
  totalMinor: number | null;
  /** TVA-ul confirmat de furnizor (bani), sau `null` (SmartBill nu îl expune prin API). */
  taxMinor: number | null;
}

export interface InvoicePdf {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Un furnizor de facturare. `simulated` e adevărat doar la DEMO. Adaptoarele reale sunt «încă netestate cu cont real» până când
 * utilizatorul confirmă testul: trecerea în LIVE e refuzată pe server până atunci.
 */
export interface InvoiceProvider {
  readonly code: InvoiceProviderCode;
  readonly label: string;
  readonly simulated: boolean;
  /** Furnizorul expune statusul e-Factura prin API (SmartBill: nu). */
  readonly reportsEfactura: boolean;
  issueProforma(request: InvoiceRequest): Promise<IssuedDocument>;
  issueInvoice(request: InvoiceRequest): Promise<IssuedDocument>;
  /** Stornează TOTAL o factură emisă. */
  reverseInvoice(invoice: DocumentRef, issueDate: Date): Promise<IssuedDocument>;
  /** Anulează o proformă (comanda a fost anulată înainte de plată). */
  cancelProforma(proforma: DocumentRef): Promise<void>;
  getInvoicePdf(invoice: DocumentRef): Promise<InvoicePdf>;
  getProformaPdf(proforma: DocumentRef): Promise<InvoicePdf>;
  /** Statusul e-Factura, dacă furnizorul îl expune; altfel `unknown`. */
  getEfacturaStatus(invoice: DocumentRef): Promise<EfacturaStatus>;
  /** Apel inofensiv, fără efect asupra documentelor, cu timp limită. */
  testConnection(): Promise<ConnectionTestResult>;
}

/** Coduri stabile de eroare ale furnizorilor de facturare (în `IntegrationError.code`). */
export const INVOICE_ERROR_CODES = [
  "INVOICE_PROVIDER_TIMEOUT",
  "INVOICE_PROVIDER_UNREACHABLE",
  "INVOICE_AUTH_FAILED",
  /** Furnizorul a refuzat cererea (date invalide, serie inexistentă, stoc insuficient): se repară în cont sau în date. */
  "INVOICE_REJECTED",
  "INVOICE_RATE_LIMITED",
  "INVOICE_BAD_RESPONSE",
  "INVOICE_UNSUPPORTED",
  /** Totalul calculat de furnizor diferă de ce a încasat magazinul: documentul NU se păstrează ca emis. */
  "INVOICE_TOTAL_MISMATCH",
  "INVOICE_NOT_CONFIGURED",
] as const;
export type InvoiceErrorCode = (typeof INVOICE_ERROR_CODES)[number];

/** Timp limită al oricărui apel către un furnizor de facturare (cel mult). */
export const INVOICE_CALL_TIMEOUT_MS = 15_000;

/** SmartBill acceptă cel mult 2 zecimale la cantitate (răspunsul contabilului, 2026-10-28). */
export const INVOICE_QUANTITY_DECIMALS = 2;
/** Multiplul de zecimi de miime al unei cantități de pe factură (10^(4 − 2)). */
export const INVOICE_QUANTITY_TICK_MULTIPLE = 100n;

/**
 * Erorile după care documentul NU poate fi creat la furnizor, deci reîncercarea automată nu riscă o a doua factură. Orice altă
 * eroare la o EMITERE (timp depășit, răspuns neinterpretabil) are rezultat NESIGUR: documentul poate exista deja, iar numerotarea
 * e a furnizorului, deci nu reîncercăm singuri: adminul verifică în contul furnizorului și apasă «Reîncearcă».
 */
const SAFE_TO_RETRY: ReadonlySet<string> = new Set<InvoiceErrorCode>([
  "INVOICE_PROVIDER_UNREACHABLE",
  "INVOICE_AUTH_FAILED",
  "INVOICE_REJECTED",
  "INVOICE_RATE_LIMITED",
  "INVOICE_NOT_CONFIGURED",
  "INVOICE_UNSUPPORTED",
]);

export function isSafeToRetryInvoiceError(code: string): boolean {
  return SAFE_TO_RETRY.has(code);
}
