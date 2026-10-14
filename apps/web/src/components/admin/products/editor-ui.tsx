import type { ReactNode } from "react";
import { Button, Label } from "@ecom/ui";

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
        <p id={helpId} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
      {error && (
        <p id={errorId} data-problem className="text-sm text-danger">
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
        className="mt-1 h-4 w-4"
      />
      <div className="flex flex-col">
        <Label htmlFor={id}>{label}</Label>
        {help && (
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {help}
          </p>
        )}
      </div>
    </div>
  );
}

/** Rândul de jos al unui tab: mesaj de stare, mesaj de eroare și butonul de salvare. */
export function SaveBar({
  pending,
  canSave,
  dirty,
  status,
  problem,
  labels,
}: {
  pending: boolean;
  canSave: boolean;
  dirty: boolean;
  status: string | null;
  problem: string | null;
  labels: { save: string; saving: string; unsavedMark: string };
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      {problem && (
        <p
          role="alert"
          data-problem
          className="rounded-md border border-danger p-3 text-sm text-danger"
        >
          {problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {canSave && (
          <Button type="submit" disabled={pending}>
            {pending ? labels.saving : labels.save}
          </Button>
        )}
        {dirty && !pending && (
          <span className="text-sm text-muted-foreground">{labels.unsavedMark}</span>
        )}
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      </div>
    </div>
  );
}
