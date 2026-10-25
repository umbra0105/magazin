/**
 * Definiția UNICĂ a câmpurilor importabile: din ea ies maparea automată a coloanelor, șablonul
 * descărcabil (CSV și XLSX), instrucțiunile și validarea. Nu există nicăieri altundeva o listă de
 * câmpuri, deci șablonul nu se poate desincroniza de import.
 *
 * Prețul de achiziție NU e câmp importabil și nu e menționat prin nume aici: o coloană al cărei antet
 * pare de cost se recunoaște cu `isCostLikeHeader` (potrivire pe fragmente), iar maparea ei se refuză.
 */

export const IMPORT_FIELD_KEYS = [
  "sku",
  "title",
  "subtitle",
  "description",
  "slug",
  "price",
  "salePrice",
  "categories",
  "brand",
  "ean",
  "warrantyMonths",
  "weightGrams",
  "lengthMm",
  "widthMm",
  "heightMm",
  "shippingClass",
  "status",
  "unit",
  "priceBasis",
  "saleStep",
  "minSteps",
  "saleStepLabel",
  "smartbillMode",
  "smartbillUnitName",
  "smartbillRatio",
  "stockStatus",
  "leadTimeDays",
] as const;
export type ImportFieldKey = (typeof IMPORT_FIELD_KEYS)[number];

/** Etichetele valorilor coloanelor de vânzare, folosite la export și (cu foldText) recunoscute la import. */
export const PRICE_BASIS_LABELS: Readonly<Record<string, string>> = {
  unit: "Pe unitate",
  step: "Pe pas",
};
export const SMARTBILL_MODE_LABELS: Readonly<Record<string, string>> = {
  same_unit: "Aceeași unitate",
  steps: "Pași",
  ratio: "Raport",
};
export const STOCK_STATUS_LABELS: Readonly<Record<string, string>> = {
  instock: "În stoc",
  outofstock: "Stoc epuizat",
  onbackorder: "La comandă",
};

/** Marcajul de ștergere explicită a valorii unui câmp care poate fi gol: o liniuță singură în celulă. */
export const CLEAR_MARKER = "-";

/** Separatorul dintre categoriile din aceeași celulă; în interiorul unei căi, nivelurile se despart cu „>”. */
export const CATEGORY_SEPARATOR = "|";
export const CATEGORY_PATH_SEPARATOR = ">";

export type ImportFieldKind =
  | "text"
  | "longText"
  | "money"
  | "int"
  | "enum"
  | "categories"
  | "brand"
  | "ean"
  | "unit"
  | "quantity";

export interface ImportFieldDef {
  key: ImportFieldKey;
  /** Antetul din șablon (și numele afișat în interfață). */
  label: string;
  /** Alte antete cunoscute (RO/EN), pentru maparea automată; se normalizează cu `normalizeHeader`. */
  aliases: readonly string[];
  kind: ImportFieldKind;
  /** `key` = identifică rândul · `new` = obligatoriu doar la produs nou · `no` = opțional. */
  required: "key" | "new" | "no";
  /** Se poate șterge valoarea cu `CLEAR_MARKER`. */
  clearable: boolean;
  /** Exemple pentru cele 2 rânduri ale șablonului. */
  examples: readonly [string, string];
  /** Instrucțiunea afișată în șablon și în interfață. */
  help: string;
}

export const IMPORT_FIELDS: readonly ImportFieldDef[] = [
  {
    key: "sku",
    label: "SKU",
    aliases: ["sku", "cod", "cod intern", "cod produs", "cod sku", "cod articol"],
    kind: "text",
    required: "key",
    clearable: false,
    examples: ["POMPA-100", "FILTRU-25"],
    help: "Codul intern, unic. Identifică rândul: un SKU existent se actualizează, unul nou creează un produs.",
  },
  {
    key: "title",
    label: "Titlu",
    aliases: ["titlu", "nume", "denumire", "name", "title", "produs", "nume produs"],
    kind: "text",
    required: "new",
    clearable: false,
    examples: ["Pompă de circulație 100", "Filtru nisip 25"],
    help: "Obligatoriu la produs nou. Cel mult 200 de caractere.",
  },
  {
    key: "subtitle",
    label: "Subtitlu",
    aliases: ["subtitlu", "subtitle", "descriere scurta", "short description"],
    kind: "text",
    required: "no",
    clearable: true,
    examples: ["Silențioasă, clasa A", ""],
    help: "Cel mult 300 de caractere. „-” șterge valoarea.",
  },
  {
    key: "description",
    label: "Descriere",
    aliases: ["descriere", "description", "descriere lunga", "descriere produs"],
    kind: "longText",
    required: "no",
    clearable: true,
    examples: ["Pompă pentru piscine de până la 40 m³.", ""],
    help: "Text simplu. „-” șterge valoarea.",
  },
  {
    key: "slug",
    label: "Adresă (slug)",
    aliases: ["slug", "adresa", "adresa slug", "url slug", "adresa url"],
    kind: "text",
    required: "no",
    clearable: false,
    examples: ["", ""],
    help: "Litere mici, cifre și cratime. Lipsă la produs nou = se generează din titlu, unică.",
  },
  {
    key: "price",
    label: "Preț (lei, cu TVA)",
    aliases: [
      "pret",
      "pret lei",
      "pret cu tva",
      "pret lei cu tva",
      "price",
      "regular price",
      "pret regulat",
      "pret vanzare",
    ],
    kind: "money",
    required: "new",
    clearable: false,
    examples: ["1299,00", "349,90"],
    help: "În lei, cu TVA inclus, virgulă sau punct, cel mult 2 zecimale. Obligatoriu la produs nou (cel puțin 0,01).",
  },
  {
    key: "salePrice",
    label: "Preț promoțional (lei, cu TVA)",
    aliases: [
      "pret promo",
      "pret promotional",
      "pret promotional lei cu tva",
      "pret redus",
      "sale price",
      "pret oferta",
    ],
    kind: "money",
    required: "no",
    clearable: true,
    examples: ["1099,00", ""],
    help: "Mai mic sau egal cu prețul întreg. „-” șterge promoția.",
  },
  {
    key: "categories",
    label: "Categorii",
    aliases: ["categorii", "categorie", "categories", "category"],
    kind: "categories",
    required: "no",
    clearable: false,
    examples: ["Pompe > Pompe de circulație", "Filtrare > Filtre cu nisip | Accesorii"],
    help: "Calea categoriei cu „>” între niveluri; mai multe categorii separate prin „|”. Prima e cea principală. Înlocuiește categoriile produsului. Categoria trebuie să existe.",
  },
  {
    key: "brand",
    label: "Brand",
    aliases: ["brand", "marca", "brands"],
    kind: "brand",
    required: "no",
    clearable: true,
    examples: ["Hayward", ""],
    help: "Numele brandului, care trebuie să existe. „-” scoate brandul.",
  },
  {
    key: "ean",
    label: "EAN",
    aliases: ["ean", "gtin", "cod de bare", "cod bare", "barcode", "upc"],
    kind: "ean",
    required: "no",
    clearable: true,
    examples: ["5901234123457", ""],
    help: "8–14 cifre. Formatează coloana ca text în Excel, ca zerourile de la început să nu se piardă. „-” șterge valoarea.",
  },
  {
    key: "warrantyMonths",
    label: "Garanție (luni)",
    aliases: ["garantie", "garantie luni", "garantie in luni", "warranty", "warranty months"],
    kind: "int",
    required: "no",
    clearable: true,
    examples: ["24", ""],
    help: "Număr întreg de luni, 0–240. „-” șterge valoarea.",
  },
  {
    key: "weightGrams",
    label: "Greutate (g)",
    aliases: ["greutate", "greutate g", "greutate grame", "weight"],
    kind: "int",
    required: "no",
    clearable: true,
    examples: ["4200", ""],
    help: "În grame, număr întreg. „-” șterge valoarea.",
  },
  {
    key: "lengthMm",
    label: "Lungime (mm)",
    aliases: ["lungime", "lungime mm", "length"],
    kind: "int",
    required: "no",
    clearable: true,
    examples: ["500", ""],
    help: "În milimetri, număr întreg. „-” șterge valoarea.",
  },
  {
    key: "widthMm",
    label: "Lățime (mm)",
    aliases: ["latime", "latime mm", "width"],
    kind: "int",
    required: "no",
    clearable: true,
    examples: ["300", ""],
    help: "În milimetri, număr întreg. „-” șterge valoarea.",
  },
  {
    key: "heightMm",
    label: "Înălțime (mm)",
    aliases: ["inaltime", "inaltime mm", "height"],
    kind: "int",
    required: "no",
    clearable: true,
    examples: ["400", ""],
    help: "În milimetri, număr întreg. „-” șterge valoarea.",
  },
  {
    key: "shippingClass",
    label: "Clasă de livrare",
    aliases: ["clasa de livrare", "clasa livrare", "shipping class", "clasa transport"],
    kind: "enum",
    required: "no",
    clearable: false,
    examples: ["Standard", "Paletizat"],
    help: "Standard, Supradimensionat sau Paletizat.",
  },
  {
    key: "status",
    label: "Stare",
    aliases: ["stare", "status", "stare produs"],
    kind: "enum",
    required: "no",
    clearable: false,
    examples: ["Ciornă", "Activ"],
    help: "Ciornă, Activ sau Arhivat. Lipsă la produs nou = Ciornă.",
  },
  {
    key: "unit",
    label: "Unitate de măsură",
    aliases: ["unitate de masura", "unitate", "um", "u m", "unit of measure", "unit"],
    kind: "unit",
    required: "no",
    clearable: true,
    examples: ["mp", "kg"],
    help: "Simbolul, numele sau codul unei unități din «Unități de măsură» (ex. mp, kg, ml). «buc» sau „-” = la bucată. Aceeași valoare pe toate rândurile unui produs = se aplică produsului; valori diferite = pe variantă.",
  },
  {
    key: "priceBasis",
    label: "Baza prețului",
    aliases: ["baza pretului", "baza de pret", "pret pe", "price basis"],
    kind: "enum",
    required: "no",
    clearable: false,
    examples: ["Pe unitate", "Pe pas"],
    help: "La ce se referă prețul din fișier: «Pe unitate» (ex. lei/mp) sau «Pe pas» (prețul unui ambalaj întreg, ex. un sac).",
  },
  {
    key: "saleStep",
    label: "Pas de vânzare",
    aliases: ["pas de vanzare", "pas vanzare", "pas", "sale step", "step"],
    kind: "quantity",
    required: "no",
    clearable: true,
    examples: ["41,25", "25"],
    help: "Cantitatea minimă vândută și unitatea de creștere, în unitatea aleasă, cu virgulă (ex. 2,03). Comanda e mereu un multiplu exact. „-” = o unitate.",
  },
  {
    key: "minSteps",
    label: "Minim (pași)",
    aliases: ["minim pasi", "minim", "cantitate minima pasi", "min steps"],
    kind: "int",
    required: "no",
    clearable: true,
    examples: ["2", ""],
    help: "Numărul minim de pași comandați (număr întreg, cel puțin 1). „-” = un pas.",
  },
  {
    key: "saleStepLabel",
    label: "Denumire pas",
    aliases: ["denumire pas", "denumirea pasului", "nume pas", "step label"],
    kind: "text",
    required: "no",
    clearable: true,
    examples: ["rolă", "sac"],
    help: "Cum se numește un pas întreg (sac, rolă, cutie), cel mult 30 de caractere. Apare în preț. Se aplică produsului. „-” șterge valoarea.",
  },
  {
    key: "smartbillMode",
    label: "Mod conversie SmartBill",
    aliases: ["mod conversie smartbill", "conversie smartbill", "mod smartbill", "smartbill mode"],
    kind: "enum",
    required: "no",
    clearable: true,
    examples: ["Aceeași unitate", "Raport"],
    help: "Cum ține SmartBill stocul variantei: «Aceeași unitate», «Pași» (o bucată SmartBill = un pas) sau «Raport» (cere «Raport SmartBill»). Se aplică variantei. „-” șterge conversia.",
  },
  {
    key: "smartbillUnitName",
    label: "Unitate SmartBill",
    aliases: ["unitate smartbill", "um smartbill", "smartbill unit"],
    kind: "text",
    required: "no",
    clearable: true,
    examples: ["mp", "sac"],
    help: "Numele unității în SmartBill (cel mult 40 de caractere). Se aplică variantei. „-” șterge valoarea.",
  },
  {
    key: "smartbillRatio",
    label: "Raport SmartBill",
    aliases: ["raport smartbill", "raport conversie", "smartbill ratio"],
    kind: "quantity",
    required: "no",
    clearable: true,
    examples: ["", "25"],
    help: "Doar la «Raport»: câte unități ale magazinului are o unitate SmartBill (cel mult 4 zecimale, cu virgulă). Trebuie să împartă exact pasul. „-” șterge valoarea.",
  },
  {
    key: "stockStatus",
    label: "Stare stoc",
    aliases: ["stare stoc", "disponibilitate", "stock status", "stare disponibilitate"],
    kind: "enum",
    required: "no",
    clearable: false,
    examples: ["În stoc", "La comandă"],
    help: "«În stoc», «Stoc epuizat» sau «La comandă». Se aplică doar produselor NEGESTIONATE; la cele cu stoc gestionat sau digitale e ignorată, cu avertisment.",
  },
  {
    key: "leadTimeDays",
    label: "Termen livrare (zile)",
    aliases: ["termen livrare", "termen livrare zile", "termen de livrare", "lead time"],
    kind: "int",
    required: "no",
    clearable: true,
    examples: ["14", ""],
    help: "Termenul «La comandă», în zile (0–365). Se aplică produsului. Gol = neschimbat; „-” = se folosește termenul brandului, apoi cel al magazinului.",
  },
];

const BY_KEY = new Map<ImportFieldKey, ImportFieldDef>(IMPORT_FIELDS.map((f) => [f.key, f]));

export function importField(key: ImportFieldKey): ImportFieldDef {
  const field = BY_KEY.get(key);
  if (!field) throw new Error(`câmp de import necunoscut: ${key}`);
  return field;
}

/** Minuscule, fără diacritice, doar litere și cifre separate prin spațiu: „Preț (lei)” → „pret lei”. */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const normalizeHeader = foldText;

/**
 * Antet de coloană care pare să conțină prețul de achiziție sau date de furnizor. Potrivire pe
 * fragmente (nu pe numele câmpului din baza de date), ca și un antet scris altfel să fie prins.
 */
const COST_HEADER = /cost|achizi|\bnir\b|furnizor|supplier|purchase|intrare/;
const IMAGE_HEADER = /^(imagini?|images?|poze?|fotografii|foto|img|galerie)(\b|$)/;

export const isCostLikeHeader = (header: string): boolean => COST_HEADER.test(foldText(header));
export const isImageHeader = (header: string): boolean => IMAGE_HEADER.test(foldText(header));

/** Un nume de câmp trimis în cerere care pare de cost (maparea lui se refuză cu mesaj dedicat). */
export const isCostLikeFieldKey = (key: string): boolean => COST_HEADER.test(foldText(key));

const ALIAS_INDEX = (() => {
  const index = new Map<string, ImportFieldKey>();
  for (const field of IMPORT_FIELDS) {
    for (const alias of [field.label, ...field.aliases]) {
      const folded = foldText(alias);
      if (!index.has(folded)) index.set(folded, field.key);
    }
  }
  return index;
})();

/**
 * Coloane doar pentru citire, adăugate la EXPORT după cele importabile (informative): importul le
 * recunoaște după antet și le ignoră cu mențiune, nu le mapează pe niciun câmp.
 */
export const EXPORT_READONLY_COLUMNS: readonly { key: "productId" | "updatedAt"; label: string }[] =
  [
    { key: "productId", label: "ID produs" },
    { key: "updatedAt", label: "Modificat la" },
  ];

const READONLY_HEADERS = new Set(EXPORT_READONLY_COLUMNS.map((c) => foldText(c.label)));
export const isReadonlyExportHeader = (header: string): boolean =>
  READONLY_HEADERS.has(foldText(header));

export interface SuggestedColumn {
  /** Câmpul propus (`null` = ignoră coloana). */
  field: ImportFieldKey | null;
  /** De ce coloana nu poate fi mapată (se afișează în interfață). */
  blocked: "cost" | "images" | "readonly" | null;
}

/**
 * Maparea propusă pentru antetele fișierului: potrivire pe nume cunoscute, fiecare câmp cel mult o
 * dată (prima coloană câștigă). Coloanele de cost și de imagini sunt marcate ca blocate.
 */
export function suggestMapping(headers: readonly string[]): SuggestedColumn[] {
  const used = new Set<ImportFieldKey>();
  return headers.map((header) => {
    if (isCostLikeHeader(header)) return { field: null, blocked: "cost" };
    if (isImageHeader(header)) return { field: null, blocked: "images" };
    if (isReadonlyExportHeader(header)) return { field: null, blocked: "readonly" };
    const field = ALIAS_INDEX.get(foldText(header)) ?? null;
    if (field && !used.has(field)) {
      used.add(field);
      return { field, blocked: null };
    }
    return { field: null, blocked: null };
  });
}
