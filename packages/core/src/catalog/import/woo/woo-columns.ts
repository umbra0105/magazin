import { foldText, isCostLikeHeader, isImageHeader } from "../import-fields";

/**
 * Recunoașterea coloanelor unui export WooCommerce (CSV standard de produse), în română (ca la magazinul
 * nostru) sau în engleză. Fiecare antet primește un ROL; ce nu are rol e ignorat cu un motiv scris pentru
 * administrator. Prețul de achiziție (orice antet de cost / furnizor / intrare) e BLOCAT: nu se citește
 * nicăieri mai departe, nu intră în raport, loguri sau audit.
 */

export const WOO_ROLES = [
  "id",
  "type",
  "sku",
  "gtin",
  "name",
  "published",
  "shortDescription",
  "description",
  "saleFrom",
  "saleTo",
  "weight",
  "length",
  "width",
  "height",
  "salePrice",
  "regularPrice",
  "categories",
  "shippingClass",
  "parent",
  "upsells",
  "crossSells",
  "brands",
] as const;
export type WooRole = (typeof WOO_ROLES)[number];

/** Antete (normalizate cu `foldText`) pe rol. Unitatea din paranteză se tratează separat. */
const ROLE_HEADERS: Readonly<Record<WooRole, readonly string[]>> = {
  id: ["id"],
  type: ["tip", "type"],
  sku: ["sku", "ug"],
  gtin: ["gtin upc ean sau isbn", "gtin upc ean or isbn", "gtin", "ean"],
  name: ["nume", "name", "denumire"],
  published: ["publicat", "published"],
  shortDescription: ["descriere scurta", "short description"],
  description: ["descriere", "description"],
  saleFrom: [
    "data inceput promotie",
    "data incepere promotie",
    "date sale price starts",
    "sale price starts",
  ],
  saleTo: [
    "data incheiere promotie",
    "data sfarsit promotie",
    "date sale price ends",
    "sale price ends",
  ],
  weight: ["greutate", "weight"],
  length: ["lungime", "length"],
  width: ["latime", "width"],
  height: ["inaltime", "height"],
  salePrice: ["pret promotional", "sale price", "pret redus"],
  regularPrice: ["pret obisnuit", "regular price", "pret regulat"],
  categories: ["categorii", "categories"],
  shippingClass: ["clasa de livrare", "shipping class"],
  parent: ["parinte", "parent"],
  upsells: ["upsells", "up sells", "vanzari suplimentare"],
  crossSells: ["vanzari incrucisate", "cross sells", "cross sell", "crosssells"],
  brands: ["branduri", "brands", "brand", "marca"],
};

/** Coloane cunoscute, ignorate în 15a, cu motivul (fiecare apare o singură dată în raport). */
const IGNORED: readonly { match: RegExp; reason: string }[] = [
  {
    match:
      /^(in stoc|in stock|stoc|stock|cantitate mica in stoc|low stock amount|precomenzile sunt permise|backorders allowed|vandut individual|sold individually)$/,
    reason: "stocul nu se importă (Faza 5)",
  },
  { match: /^(etichete|tags)$/, reason: "etichetele nu se importă" },
  {
    match:
      /^(este reprezentativ|is featured|vizibilitate in catalog|visibility in catalog|stare taxa|tax status|clasa de impozitare|tax class|permiti recenzii de la clienti|allow customer reviews|nota de cumparare|purchase note|pozitie|position)$/,
    reason: "setare WooCommerce fără corespondent în aplicație",
  },
  {
    match:
      /^(limita de descarcari|download limit|zile de expirare descarcare|download expiry days)$/,
    reason: "produse digitale: nu fac parte din acest import",
  },
  {
    match: /^(produse grupate|grouped products|url extern|external url|text buton|button text)$/,
    reason: "produsele grupate și externe nu sunt acceptate",
  },
];

export interface WooColumnMap {
  /** Indexul coloanei pentru fiecare rol găsit. */
  roles: Partial<Record<WooRole, number>>;
  /** Unitatea din antetul de greutate / dimensiuni (ex. «kg», «cm»), dacă apare între paranteze. */
  units: { weight: string | null; dimensions: string | null };
  /** Grupurile de atribute: «Nume atribut N», valori, vizibilitate, global, implicit. */
  attributes: WooAttributeColumns[];
  /** Coloane ignorate, cu motiv (antet → motiv). */
  ignored: { header: string; reason: string }[];
  /** Coloane blocate (cost / furnizor): doar antetul, valorile nu se citesc. */
  blocked: string[];
}

export interface WooAttributeColumns {
  n: number;
  name: number;
  values: number | null;
  visible: number | null;
  global: number | null;
  default: number | null;
}

/** Antetul fără unitate: «Greutate (kg)» → «Greutate» + «kg». */
function splitUnit(header: string): { base: string; unit: string | null } {
  const match = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(header);
  if (!match) return { base: header, unit: null };
  return { base: match[1] ?? header, unit: (match[2] ?? "").trim().toLowerCase() };
}

const ATTRIBUTE_PATTERNS: readonly { field: keyof Omit<WooAttributeColumns, "n">; re: RegExp }[] = [
  { field: "name", re: /^(?:nume atribut (\d+)|attribute (\d+) name)$/ },
  { field: "values", re: /^(?:valoare valori atribut (\d+)|attribute (\d+) values?)$/ },
  { field: "visible", re: /^(?:vizibilitate atribut (\d+)|attribute (\d+) visible)$/ },
  { field: "global", re: /^(?:atribut (\d+) global|attribute (\d+) global)$/ },
  { field: "default", re: /^(?:atribut (\d+) implicit|attribute (\d+) default)$/ },
];

export function detectWooColumns(headers: readonly string[]): WooColumnMap {
  const roles: Partial<Record<WooRole, number>> = {};
  const units: WooColumnMap["units"] = { weight: null, dimensions: null };
  const groups = new Map<number, Partial<Omit<WooAttributeColumns, "n">>>();
  const ignored: WooColumnMap["ignored"] = [];
  const blocked: string[] = [];

  headers.forEach((raw, index) => {
    const header = raw.trim();
    if (header === "") return;
    // costul / furnizorul: blocat înainte de orice altă recunoaștere
    if (isCostLikeHeader(header)) {
      blocked.push(header);
      return;
    }
    const { base, unit } = splitUnit(header);
    const folded = foldText(base);
    const foldedFull = foldText(header);

    for (const pattern of ATTRIBUTE_PATTERNS) {
      const m = pattern.re.exec(foldedFull);
      if (m) {
        const n = Number(m[1] ?? m[2]);
        groups.set(n, { ...groups.get(n), [pattern.field]: index });
        return;
      }
    }
    if (foldedFull.startsWith("meta ") || foldedFull.startsWith("meta:")) {
      ignored.push({ header, reason: "câmp personalizat (meta): nu se importă în 15a" });
      return;
    }
    if (isImageHeader(header)) {
      ignored.push({
        header,
        reason: "imaginile se importă separat (15b); aici se ignoră",
      });
      return;
    }
    for (const role of WOO_ROLES) {
      if (roles[role] !== undefined) continue;
      if (ROLE_HEADERS[role].includes(folded) || ROLE_HEADERS[role].includes(foldedFull)) {
        roles[role] = index;
        if (role === "weight") units.weight = unit;
        if (role === "length" || role === "width" || role === "height") {
          units.dimensions = units.dimensions ?? unit;
        }
        return;
      }
    }
    const known = IGNORED.find((i) => i.match.test(folded));
    ignored.push({ header, reason: known?.reason ?? "coloană neacoperită de profil" });
  });

  const attributes: WooAttributeColumns[] = [...groups.entries()]
    .filter(([, g]) => g.name !== undefined)
    .sort((a, b) => a[0] - b[0])
    .map(([n, g]) => ({
      n,
      name: g.name as number,
      values: g.values ?? null,
      visible: g.visible ?? null,
      global: g.global ?? null,
      default: g.default ?? null,
    }));
  return { roles, units, attributes, ignored, blocked };
}

/** Un fișier arată ca un export WooCommerce dacă are cel puțin ID, Tip, Nume și un preț. */
export function looksLikeWooExport(map: WooColumnMap): boolean {
  const r = map.roles;
  return (
    r.id !== undefined &&
    r.type !== undefined &&
    r.name !== undefined &&
    (r.regularPrice !== undefined || r.salePrice !== undefined)
  );
}
