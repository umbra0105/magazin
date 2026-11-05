/**
 * Alegerea depozitului afișat în pagina Stoc (Faza 5, punctul 13d). Funcție pură: nu știe de baza de date sau de interfață.
 *
 * Regula: selectorul de depozit, butonul de transfer și parametrul `?depozit=` există DOAR cu steagul de multi-depozit pornit
 * și cu cel puțin DOUĂ depozite active. În rest pagina rămâne exact ca înainte (depozitul implicit, fără selector), iar cu
 * steagul oprit depozitele nici nu se citesc (`loadActive` nu se apelează). Un cod necunoscut sau al unui depozit dezactivat
 * (care nu e în lista primită) revine la depozitul implicit, fără eroare: o adresă veche nu trebuie să strice pagina.
 *
 * Nu importă serviciul de depozite și nu numește steagul: `enabled` și `loadActive` le dă aplicația (`getWarehouseChoice`).
 */

export interface SelectableWarehouse {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
}

export interface WarehouseChoice {
  /** Selectorul și transferul se desenează doar când e adevărat */
  visible: boolean;
  /** Depozitul afișat; `null` = nicio alegere (pagina folosește depozitul implicit, ca până acum) */
  selected: SelectableWarehouse | null;
  /** Codul de pus în adresă: `null` pentru depozitul implicit (adresa canonică nu are cod) */
  urlCode: string | null;
  /** Depozitele active, în ordinea primită */
  options: SelectableWarehouse[];
  /** Destinațiile unui transfer din depozitul afișat: toate cele active, în afară de el */
  destinations: SelectableWarehouse[];
}

export interface ResolveWarehouseChoiceInput {
  /** Steagul de multi-depozit, citit de aplicație */
  enabled: boolean;
  /** Valoarea parametrului `depozit` din adresă (prima, dacă sunt mai multe) */
  requested: string | readonly string[] | undefined;
  /** Depozitele ACTIVE; apelat doar cu steagul pornit */
  loadActive: () => Promise<SelectableWarehouse[]>;
}

const HIDDEN: WarehouseChoice = {
  visible: false,
  selected: null,
  urlCode: null,
  options: [],
  destinations: [],
};

/** Steagul poate fi oprit între verificare și citire: serviciul refuză cu `FEATURE_DISABLED`, iar asta înseamnă «oprit». */
function isFeatureDisabled(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "FEATURE_DISABLED";
}

export async function resolveWarehouseChoice(
  input: ResolveWarehouseChoiceInput,
): Promise<WarehouseChoice> {
  if (!input.enabled) return { ...HIDDEN };
  let active: SelectableWarehouse[];
  try {
    active = await input.loadActive();
  } catch (error) {
    if (isFeatureDisabled(error)) return { ...HIDDEN };
    throw error;
  }
  if (active.length < 2) return { ...HIDDEN };

  const code = Array.isArray(input.requested) ? input.requested[0] : input.requested;
  const fallback = active.find((warehouse) => warehouse.isDefault) ?? active[0];
  const requested = typeof code === "string" ? active.find((w) => w.code === code) : undefined;
  const selected = requested ?? fallback;
  if (!selected) return { ...HIDDEN };
  return {
    visible: true,
    selected,
    urlCode: selected.isDefault ? null : selected.code,
    options: active,
    destinations: active.filter((warehouse) => warehouse.id !== selected.id),
  };
}
