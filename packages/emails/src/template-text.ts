/**
 * Textul șabloanelor cu `{{variabile}}` (Faza 11): interpolare și validarea suprascrierilor. Regula: o suprascriere poate folosi
 * DOAR variabilele șablonului; una necunoscută sau o acoladă nepereche se refuză la salvare (nu se «reparează» pe tăcute).
 * Textul e doar text (nu HTML): randarea îl escapează.
 */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export const SUBJECT_MAX = 200;
export const INTRO_MAX = 2000;

/** Numele variabilelor folosite într-un text, în ordinea apariției, fără dubluri. */
export function placeholdersOf(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] as string;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** Înlocuiește `{{nume}}` cu valoarea; o variabilă lipsă devine șir gol (șabloanele implicite își acoperă variabilele). */
export function interpolate(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (_all, name: string) => vars[name] ?? "");
}

/** Subiectul stă pe o singură linie, oricare ar fi valorile variabilelor. */
export const singleLine = (value: string): string => value.replace(/\s+/g, " ").trim();

export type OverrideProblem =
  | { code: "subject_empty" | "subject_too_long" | "intro_empty" | "intro_too_long" }
  | { code: "unknown_variable"; names: string[] }
  | { code: "unbalanced_braces" }
  | { code: "subject_multiline" };

/** Verifică o suprascriere față de variabilele permise ale șablonului; lista goală = validă. */
export function validateOverride(
  input: { subject: string; intro: string },
  allowed: readonly string[],
): OverrideProblem[] {
  const problems: OverrideProblem[] = [];
  const subject = input.subject.trim();
  const intro = input.intro.trim();
  if (subject === "") problems.push({ code: "subject_empty" });
  else if (subject.length > SUBJECT_MAX) problems.push({ code: "subject_too_long" });
  if (/[\r\n]/.test(subject)) problems.push({ code: "subject_multiline" });
  if (intro === "") problems.push({ code: "intro_empty" });
  else if (intro.length > INTRO_MAX) problems.push({ code: "intro_too_long" });
  const unknown = [...placeholdersOf(subject), ...placeholdersOf(intro)].filter(
    (name) => !allowed.includes(name),
  );
  if (unknown.length > 0) problems.push({ code: "unknown_variable", names: [...new Set(unknown)] });
  // acolade rămase după scoaterea variabilelor valide: «{{», «}}» sau «{nume}» nepereche
  const stripped = `${subject}\n${intro}`.replace(PLACEHOLDER, "");
  if (/[{}]/.test(stripped)) problems.push({ code: "unbalanced_braces" });
  return problems;
}
