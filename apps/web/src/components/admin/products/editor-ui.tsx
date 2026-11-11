import type { ReactNode } from "react";
import { Label } from "@ecom/ui";

// Bara de salvare lipită jos și secțiunea cu linie sunt componente din `@ecom/ui` (docs/17 §4.2); tab-urile le importă de aici.
export { SaveBar, Section } from "@ecom/ui";

/** Proprietățile de accesibilitate pe care `Field` le dă controlului din interior. */
export interface FieldControlProps {
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
}

/**
 * Câmp de formular cu etichetă, ajutor și eroare legate de control (`for`, `aria-describedby`,
 * `aria-invalid`). Eroarea apare sub câmp și e citită împreună cu eticheta.
 */
export function Field({
  id,
  label,
  help,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  help?: string | undefined;
  error?: string | undefined;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}) {
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className ?? "flex flex-col gap-1.5"}>
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        ...(error && { "aria-invalid": true as const }),
        ...(describedBy && { "aria-describedby": describedBy }),
      })}
      {help && (
        <p id={helpId} className="text-label text-ink-secondary">
          {help}
        </p>
      )}
      {error && (
        <p id={errorId} data-problem className="text-body text-tone-problem-fg">
          {error}
        </p>
      )}
    </div>
  );
}

/** Bifă cu etichetă și ajutor, pe aceeași linie. */
export function CheckField({
  id,
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  help?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={help ? `${id}-help` : undefined}
        className="mt-0.5 size-4 accent-brand"
      />
      <div className="flex flex-col">
        <Label htmlFor={id}>{label}</Label>
        {help && (
          <p id={`${id}-help`} className="text-label text-ink-secondary">
            {help}
          </p>
        )}
      </div>
    </div>
  );
}
