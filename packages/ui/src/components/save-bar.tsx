import { cn } from "../lib/cn";
import { Button } from "./button";

export interface SaveBarProps {
  /** Salvarea e în curs: butonul e dezactivat și spune «Se salvează…». */
  pending: boolean;
  /** Fără drept de salvare nu există buton (bara rămâne doar cu starea). */
  canSave: boolean;
  /** Formularul are modificări nesalvate: apare mențiunea din `labels.unsavedMark`. */
  dirty: boolean;
  /** Mesajul de stare (ex. «Salvat.»), citit ca `status`. */
  status: string | null;
  /** Eroarea de salvare, citită ca alertă, în tonul Problemă. */
  problem: string | null;
  labels: { save: string; saving: string; unsavedMark: string };
  /**
   * A doua formă a unui tab (ex. variantele din tabul Stoc): bară obișnuită, nelipită, cu buton secundar. Un tab are o singură
   * bară lipită jos și un singur buton principal.
   */
  secondary?: boolean;
  className?: string;
}

/**
 * Bara de salvare a paginii de editare (docs/17 §4.2): lipită de marginea de jos a ferestrei cât timp formularul e mai înalt decât
 * ea (`sticky bottom-0`), pe fundal propriu și cu linie deasupra, ca să nu se vadă conținutul prin ea. Conține singurul buton
 * principal al formularului («Salvează»), mențiunea «modificări nesalvate» și starea salvării. Se pune ca ultim copil al
 * `<form>`-ului: butonul trimite acel formular. Nu ține nicio logică de modificări: starea o dau cei care o folosesc.
 */
export function SaveBar({
  pending,
  canSave,
  dirty,
  status,
  problem,
  labels,
  secondary = false,
  className,
}: SaveBarProps) {
  return (
    <div
      data-save-bar
      className={cn(
        "flex flex-col gap-2 border-t border-line-subtle bg-surface-page py-3",
        !secondary && "sticky bottom-0 z-10",
        className,
      )}
    >
      {problem && (
        <p
          role="alert"
          data-problem
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {canSave && (
          <Button type="submit" variant={secondary ? "outline" : "default"} disabled={pending}>
            {pending ? labels.saving : labels.save}
          </Button>
        )}
        {dirty && !pending && (
          <span
            data-unsaved-mark
            className="text-body text-ink-secondary before:mr-1.5 before:inline-block before:size-1.5 before:rounded-full before:bg-brand before:align-middle before:content-['']"
          >
            {labels.unsavedMark}
          </span>
        )}
        <p role="status" className="text-body text-ink-secondary">
          {status}
        </p>
      </div>
    </div>
  );
}
