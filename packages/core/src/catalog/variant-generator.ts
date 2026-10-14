import { DomainError } from "@ecom/shared";
import { slugify } from "./slug";

/**
 * Generatorul de variante: din opțiuni („Mărime”: S, M / „Culoare”: roșu, albastru) produce toate
 * combinațiile, cu SKU-uri unice, și compară cu variantele existente ca la modificarea opțiunilor să
 * se adauge doar ce lipsește (nu se șterge nimic automat).
 */

export const MAX_OPTIONS_PER_PRODUCT = 3;
export const MAX_VALUES_PER_OPTION = 50;
export const MAX_VARIANTS_PER_PRODUCT = 100;

export interface OptionInput {
  name: string;
  values: readonly string[];
}

export interface VariantCombination {
  /** Valoarea aleasă pentru fiecare opțiune, în ordinea opțiunilor: `[{ option: "Mărime", value: "S" }]`. */
  selections: readonly { option: string; value: string }[];
  /** Cheie stabilă a combinației (pentru comparare), independentă de majuscule: `marime=s|culoare=rosu`. */
  key: string;
}

export class VariantGenerationError extends DomainError {}

const norm = (text: string): string => text.trim().replace(/\s+/g, " ");
const fold = (text: string): string => norm(text).toLocaleLowerCase("ro");

/** Valideaza și curăță opțiunile; aceeași valoare (fără diferență de majuscule) nu se repetă. */
export function normalizeOptions(options: readonly OptionInput[]): OptionInput[] {
  if (options.length === 0) {
    throw new VariantGenerationError("CATALOG_OPTIONS_EMPTY", "Adaugă cel puțin o opțiune");
  }
  if (options.length > MAX_OPTIONS_PER_PRODUCT) {
    throw new VariantGenerationError(
      "CATALOG_OPTIONS_LIMIT",
      `Un produs poate avea cel mult ${MAX_OPTIONS_PER_PRODUCT} opțiuni`,
    );
  }
  const seenNames = new Set<string>();
  return options.map((option) => {
    const name = norm(option.name);
    if (name === "") {
      throw new VariantGenerationError("CATALOG_OPTION_NAME_EMPTY", "O opțiune nu are nume");
    }
    if (seenNames.has(fold(name))) {
      throw new VariantGenerationError(
        "CATALOG_OPTION_DUPLICATE",
        `Opțiunea «${name}» apare de două ori`,
      );
    }
    seenNames.add(fold(name));
    const seenValues = new Set<string>();
    const values: string[] = [];
    for (const raw of option.values) {
      const value = norm(raw);
      if (value === "" || seenValues.has(fold(value))) continue;
      seenValues.add(fold(value));
      values.push(value);
    }
    if (values.length === 0) {
      throw new VariantGenerationError(
        "CATALOG_OPTION_VALUES_EMPTY",
        `Opțiunea «${name}» nu are nicio valoare`,
      );
    }
    if (values.length > MAX_VALUES_PER_OPTION) {
      throw new VariantGenerationError(
        "CATALOG_OPTION_VALUES_LIMIT",
        `Opțiunea «${name}» are peste ${MAX_VALUES_PER_OPTION} valori`,
      );
    }
    return { name, values };
  });
}

/** Produsul cartezian al valorilor, în ordinea opțiunilor și a valorilor. */
export function generateCombinations(
  options: readonly OptionInput[],
  limit = MAX_VARIANTS_PER_PRODUCT,
): VariantCombination[] {
  const clean = normalizeOptions(options);
  const total = clean.reduce((n, o) => n * o.values.length, 1);
  if (total > limit) {
    throw new VariantGenerationError(
      "CATALOG_VARIANT_LIMIT",
      `Combinațiile ar produce ${total} variante; limita este ${limit}. Reduce valorile sau opțiunile`,
    );
  }
  let combos: { option: string; value: string }[][] = [[]];
  for (const option of clean) {
    combos = combos.flatMap((prefix) =>
      option.values.map((value) => [...prefix, { option: option.name, value }]),
    );
  }
  return combos.map((selections) => ({ selections, key: combinationKey(selections) }));
}

export function combinationKey(selections: readonly { option: string; value: string }[]): string {
  return selections.map((s) => `${fold(s.option)}=${fold(s.value)}`).join("|");
}

/**
 * SKU-uri unice pentru combinații: `<BAZA>-<VALOARE1>-<VALOARE2>`, majuscule, fără diacritice. La
 * coliziune (cu `taken` sau între combinații) se adaugă `-2`, `-3`...
 */
export function buildSkus(
  baseSku: string,
  combinations: readonly VariantCombination[],
  taken: ReadonlySet<string> = new Set(),
): string[] {
  const base = baseSku.trim().toUpperCase();
  if (base === "") {
    throw new VariantGenerationError("CATALOG_SKU_EMPTY", "Codul de bază al variantelor lipsește");
  }
  const used = new Set([...taken].map((s) => s.toUpperCase()));
  return combinations.map((combo) => {
    const suffix = combo.selections
      .map((s) => slugify(s.value, "x").toUpperCase())
      .filter((part) => part !== "");
    const root = [base, ...suffix].join("-");
    let candidate = root;
    for (let n = 2; used.has(candidate); n++) candidate = `${root}-${n}`;
    used.add(candidate);
    return candidate;
  });
}

export interface VariantSyncPlan {
  /** Combinații care lipsesc și trebuie create. */
  toCreate: VariantCombination[];
  /** Combinații care există deja (nu se ating). */
  existing: string[];
  /** Chei ale variantelor existente care nu mai corespund niciunei combinații (se raportează; NU se șterg). */
  orphaned: string[];
}

/** Compară combinațiile dorite cu cheile variantelor existente. */
export function planVariantSync(
  desired: readonly VariantCombination[],
  existingKeys: readonly string[],
): VariantSyncPlan {
  const have = new Set(existingKeys);
  const want = new Set(desired.map((d) => d.key));
  return {
    toCreate: desired.filter((d) => !have.has(d.key)),
    existing: desired.filter((d) => have.has(d.key)).map((d) => d.key),
    orphaned: existingKeys.filter((k) => !want.has(k)),
  };
}
