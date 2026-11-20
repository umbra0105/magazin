/**
 * Firimiturile paginilor de detaliu din grupul «Comenzi» (Faza 11, C4). O adresă ca `/admin/comenzi/<id>` nu are în ea numărul
 * comenzii (doar id-ul intern), deci pagina, care a citit deja comanda, înregistrează numărul ca etichetă pentru adresa ei
 * (`CrumbLabel`). Până atunci (și pe pagina deja trimisă de server) migă arată un nume generic, niciodată id-ul.
 */
export interface CrumbTexts {
  order: string;
  offer: string;
  payment: string;
  template: string;
  newOffer: string;
}

/** Elementele grupului «Comenzi» care au pagină de detaliu sub ele (id-urile din `admin-nav`). */
const DETAIL_SECTIONS = {
  allOrders: "order",
  offers: "offer",
  payments: "payment",
  emailTemplates: "template",
} as const satisfies Record<string, keyof CrumbTexts>;

export function detailCrumbLabel(
  sectionId: string | null,
  raw: string,
  previous: string | null,
  href: string,
  labels: Readonly<Record<string, string>>,
  texts: CrumbTexts,
): string | null {
  const section = sectionId as keyof typeof DETAIL_SECTIONS | null;
  if (section === null || !(section in DETAIL_SECTIONS)) return null;
  // doar primul segment de sub element e detaliul (id-ul sau cheia); celelalte rămân cum sunt
  if (previous !== null) return null;
  const known = labels[href];
  if (known) return known;
  if (section === "offers" && raw === "nou") return texts.newOffer;
  return texts[DETAIL_SECTIONS[section]];
}
