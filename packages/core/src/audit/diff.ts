export interface Changes {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** `{ a: { b: 1 }, c: [1] }` → `{ "a.b": 1, c: [1] }` (obiectele se desfac, array-urile rămân întregi). */
function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}) {
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0 && prefix) out[prefix] = {};
    for (const [key, child] of entries) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out[prefix || "value"] = value;
  }
  return out;
}

const same = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return JSON.stringify(a) === JSON.stringify(b);
};

/**
 * Doar ce s-a schimbat între două stări: căile (cu punct) care diferă, cu valoarea dinainte și cea de
 * după. `null` dacă nu s-a schimbat nimic. Jurnalul de audit păstrează astfel diferențele, nu
 * obiecte întregi (care ar duplica date nemodificate, inclusiv eventuale valori sensibile).
 */
export function diffChanges(before: unknown, after: unknown): Changes | null {
  const a = before === undefined || before === null ? {} : flatten(before);
  const b = after === undefined || after === null ? {} : flatten(after);
  const changes: Changes = { before: {}, after: {} };
  let changed = false;
  for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!same(a[path], b[path])) {
      changed = true;
      changes.before[path] = path in a ? a[path] : null;
      changes.after[path] = path in b ? b[path] : null;
    }
  }
  return changed ? changes : null;
}
