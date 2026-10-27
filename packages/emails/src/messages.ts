/**
 * Număr + unitate, cu acordul românesc: 1 oră, 2 ore, 19 ore, 20 de ore, 24 de ore, 101 ore.
 * Forma „de” apare de la 20 în sus (cu excepția terminațiilor 01-19).
 */
export function roCount(n: number, one: string, few: string, many: string): string {
  if (n === 1) return `1 ${one}`;
  const lastTwo = n % 100;
  if (n === 0 || (lastTwo >= 1 && lastTwo <= 19)) return `${n} ${few}`;
  return `${n} de ${many}`;
}

/** Textele emailurilor, în română. Un fișier pe limbă, aceeași formă (vezi apps/web/src/messages). */
export const emailMessagesRo = {
  common: {
    greeting: (name: string) => (name.trim() ? `Bună, ${name.trim()},` : "Bună,"),
    ignoreNotice: "Dacă nu ai cerut tu acest mesaj, îl poți ignora în siguranță.",
    linkFallback: "Dacă butonul nu funcționează, copiază acest link în browser:",
    sentBy: (storeName: string) => `Mesaj trimis automat de ${storeName}.`,
  },
  verifyEmail: {
    subject: (storeName: string) => `Confirmă adresa de email – ${storeName}`,
    preview: "Confirmă adresa de email ca să-ți activezi contul.",
    heading: "Confirmă adresa de email",
    intro: (storeName: string) =>
      `Ți-ai creat un cont la ${storeName}. Confirmă adresa de email ca să-l poți folosi.`,
    button: "Confirmă adresa de email",
    validity: (hours: number) =>
      `Linkul este valabil ${roCount(hours, "oră", "ore", "ore")} și poate fi folosit o singură dată.`,
  },
  resetPassword: {
    subject: (storeName: string) => `Resetarea parolei – ${storeName}`,
    preview: "Ai cerut resetarea parolei.",
    heading: "Resetează parola",
    intro: (storeName: string) =>
      `Am primit o cerere de resetare a parolei pentru contul tău de la ${storeName}.`,
    button: "Alege o parolă nouă",
    validity: (minutes: number) =>
      `Linkul este valabil ${
        minutes % 60 === 0
          ? roCount(minutes / 60, "oră", "ore", "ore")
          : roCount(minutes, "minut", "minute", "minute")
      } și poate fi folosit o singură dată.`,
    afterNotice: "După schimbare, vei fi deconectat de pe toate dispozitivele.",
  },
  // «Anunță-mă când revine»: un singur mesaj de serviciu, fără conținut promoțional (textul aprobat de utilizator).
  backInStock: {
    subject: (storeName: string, productTitle: string) =>
      `${storeName}: ${productTitle} e din nou în stoc`,
    preview: (productTitle: string) => `${productTitle} e din nou în stoc.`,
    heading: "Produsul e din nou în stoc",
    intro: (productTitle: string, variantLabel: string | null) =>
      `Produsul pe care îl așteptai, ${productTitle}${variantLabel ? ` (${variantLabel})` : ""}, este din nou disponibil.`,
    onlyMessage:
      "Acesta este singurul mesaj pe care îl primești pentru această cerere; adresa ta a fost ștearsă.",
    button: "Vezi produsul",
    ignoreNotice:
      "Dacă nu ai cerut tu această notificare, poți ignora mesajul; adresa ta a fost ștearsă și nu vei mai primi altele.",
  },
} as const;

export type EmailMessages = typeof emailMessagesRo;
