/**
 * Reguli de aspect ale vitrinei care depind de conținut, scoase din pagini ca să se poată testa.
 */

/**
 * Mărimea titlului de produs după lungime: numele scurte rămân mari, cele de peste ~60 de caractere coboară o treaptă, iar cele
 * foarte lungi (denumiri de import cu model, cod și specificații) încă una, ca să nu umple patru rânduri pe ecran lat.
 */
export function productTitleSize(title: string): string {
  const length = title.trim().length;
  if (length > 110) return "text-lg sm:text-xl";
  if (length > 60) return "text-xl sm:text-2xl";
  return "text-2xl sm:text-3xl";
}

/**
 * Plăcile de categorie ocupă rânduri complete: pe telefon (2 coloane) o placă rămasă singură se întinde pe lățime; pe ecrane late (6
 * coloane) rândul de 3 se completează, iar un rând cu rest se împarte egal (o placă rămasă = tot rândul, două = jumătate fiecare).
 */
export function tileSpan(index: number, count: number): string {
  const small = count % 2 === 1 && index === count - 1 ? "col-span-2" : "col-span-1";
  const rest = count % 3;
  const inLastRow = rest !== 0 && index >= count - rest;
  const wide = inLastRow ? (rest === 1 ? "lg:col-span-6" : "lg:col-span-3") : "lg:col-span-2";
  return `${small} ${wide}`;
}
