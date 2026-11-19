import { render } from "@react-email/render";
import { createElement } from "react";
import { emailMessagesRo as m } from "./messages";
import { templateDefinition, sampleVars } from "./catalog";
import type { RenderedEmail } from "./render";
import {
  type MerchantModel,
  type OrderEmailModel,
  type TemplateContext,
  type TemplateDefinition,
} from "./template-model";
import { interpolate, singleLine } from "./template-text";
import type { EmailTheme } from "./theme";
import { BlocksEmail } from "./templates/blocks-email";

/**
 * Randarea emailurilor de comenzi din catalog (Faza 11): HTML + text, cu suprascrierea (subiect și text de început) aplicată
 * doar pe variabilele șablonului. Corpul (informațiile comenzii și cele obligatorii legal) vine din șablon și NU se suprascrie.
 */
export interface TemplateOverride {
  subject: string;
  intro: string;
}

export interface RenderTemplateOptions {
  override?: TemplateOverride | null;
  /** Previzualizare sau email de test: banda «date de probă» în email și prefixul `[TEST]` în subiect (doar la test). */
  sample?: boolean;
  testSend?: boolean;
}

const SAMPLE_NOTICE = "DATE DE PROBĂ: acesta este un exemplu, nu o comandă reală.";

export class UnknownTemplateError extends Error {
  readonly code = "EMAIL_TEMPLATE_UNKNOWN";
  constructor(key: string) {
    super(`Șablon de email necunoscut: ${key}`);
    this.name = "UnknownTemplateError";
  }
}

const paragraphsOf = (text: string): string[] =>
  text
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s*\n\s*/g, " ").trim())
    .filter((part) => part !== "");

export async function renderTemplateEmail(
  theme: EmailTheme,
  key: string,
  context: TemplateContext,
  options: RenderTemplateOptions = {},
): Promise<RenderedEmail> {
  const definition = templateDefinition(key);
  if (!definition) throw new UnknownTemplateError(key);
  const vars = context.vars;
  const subjectText = options.override?.subject ?? definition.defaultSubject;
  const introText = options.override?.intro ?? definition.defaultIntro;
  const subject = singleLine(
    `${options.testSend ? "[TEST] " : ""}${interpolate(subjectText, vars)}`,
  );
  const element = createElement(BlocksEmail, {
    theme,
    preview: singleLine(interpolate(definition.preview, vars)),
    heading: interpolate(definition.heading, vars),
    greeting: m.common.greeting(vars["client"] ?? ""),
    intro: paragraphsOf(interpolate(introText, vars)),
    blocks: definition.build(context),
    footer: m.common.sentBy(theme.storeName),
    ...(options.sample ? { sampleNotice: SAMPLE_NOTICE } : {}),
  });
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject, html, text };
}

// --- date de probă (previzualizare, email de test), marcate clar ca fictive ---

export const SAMPLE_MERCHANT: MerchantModel = {
  name: "Magazin Exemplu",
  legalName: "Exemplu Comerț SRL",
  vatId: "RO00000000",
  tradeRegisterNo: "J00/000/2000",
  address: "Strada Exemplu 1, 000000 Oraș Exemplu, Județ Exemplu",
  phone: "0700 000 000",
  email: "contact@exemplu.invalid",
  iban: "RO00EXPL0000000000000000",
  bankName: "Banca Exemplu",
};

export const SAMPLE_ORDER: OrderEmailModel = {
  number: "WEB-000123",
  placedAt: "19 noiembrie 2026, 14:30",
  lines: [
    {
      title: "Pompă de căldură piscină 12 kW",
      detail: null,
      quantity: "1 buc",
      amount: "1.099,00 RON",
    },
    {
      title: "Liner piscină",
      detail: "Culoare: albastru",
      quantity: "6,09 mp",
      amount: "135,50 RON",
    },
  ],
  totals: {
    products: "1.234,50 RON",
    shipping: "0,00 RON",
    codFee: null,
    vat: "214,26 RON",
    total: "1.234,50 RON",
  },
  payment: {
    method: "cod",
    methodLabel: "Ramburs",
    note: "Plătești curierului la primirea coletului",
  },
  delivery: {
    kind: "courier",
    heading: "Livrare în",
    text: "Oraș Exemplu, Județ Exemplu",
    termText: "aproximativ 3 zile",
  },
  hasOnOrderLines: false,
};

/** Contextul de probă al unui șablon: variabilele lui cu valorile de probă, comerciantul și comanda fictive. */
export function sampleContext(definition: TemplateDefinition): TemplateContext {
  return {
    vars: sampleVars(definition),
    merchant: SAMPLE_MERCHANT,
    legal: {
      anpcUrl: "https://anpc.exemplu.invalid",
      salUrl: "https://sal.exemplu.invalid",
      odrUrl: "https://sol.exemplu.invalid",
    },
    order: SAMPLE_ORDER,
  };
}
