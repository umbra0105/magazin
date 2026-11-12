import type { ReactNode } from "react";

/**
 * Antetul unei pagini de listă din administrare (docs/17 §4.1): titlul cu numărul de elemente între paranteze («Branduri (12)»),
 * o frază de descriere și, dacă e cazul, note (doar citire, doar conținut) pe fundal propriu, fără bordură. Componentă de server,
 * fără logică: butonul principal al paginii stă în lista de sub antet (acolo e starea dialogurilor).
 */
export function PageHeader({
  title,
  count,
  description,
  notes = [],
}: {
  title: string;
  /** Numărul de elemente din listă; lipsă = titlul fără număr. */
  count?: number;
  description?: ReactNode;
  notes?: readonly ReactNode[];
}) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-title">
        {title}
        {count !== undefined && (
          <>
            {" "}
            <span className="font-normal text-ink-secondary">
              ({count.toLocaleString("ro-RO")})
            </span>
          </>
        )}
      </h1>
      {description && <p className="text-body text-ink-secondary">{description}</p>}
      {notes.map((note, index) => (
        <p key={index} role="note" className="mt-2 rounded-lg bg-surface-subtle p-3 text-body">
          {note}
        </p>
      ))}
    </header>
  );
}
