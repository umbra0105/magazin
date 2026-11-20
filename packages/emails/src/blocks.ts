/**
 * Blocurile din care se compun emailurile de comenzi (Faza 11): date simple, fără React. Același conținut se randează în HTML și
 * în text, iar șabloanele le construiesc din modelul comenzii. Tot textul vine formatat de apelant (sume, date): aici nu se
 * calculează nimic și nu există valori de brand.
 */
export type EmailBlock =
  | { type: "paragraph"; text: string; tone?: "muted" | "strong" }
  | { type: "button"; label: string; link: string }
  | { type: "section"; title: string; paragraphs: readonly string[] }
  | { type: "keyvalue"; title?: string; rows: readonly { label: string; value: string }[] }
  | {
      type: "lines";
      title: string;
      rows: readonly { title: string; detail: string | null; quantity: string; amount: string }[];
      totals: readonly { label: string; value: string; strong?: boolean }[];
    };
