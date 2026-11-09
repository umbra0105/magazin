import type {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { cn } from "../lib/cn";

/**
 * Prioritatea unei coloane (docs/17 §3, «Prioritatea coloanelor»): `primary` se vede mereu; `secondary` apare când tabelul are cel
 * puțin 48rem lățime; `detail` (detalii care se găsesc și în altă parte) apare de la 64rem. Se măsoară lățimea TABELULUI (nu a
 * ferestrei): bara laterală și marginile paginii îi iau din lățime, deci pe aceeași fereastră tabelul poate avea mai mult sau
 * mai puțin loc. Același `priority` se pune pe antet și pe toate celulele coloanei, inclusiv pe rândurile de total.
 */
export type TablePriority = "primary" | "secondary" | "detail";

const PRIORITY_CLASS: Record<TablePriority, string> = {
  primary: "",
  secondary: "hidden @3xl/table:table-cell",
  detail: "hidden @5xl/table:table-cell",
};

export function tablePriorityClass(priority: TablePriority): string {
  return PRIORITY_CLASS[priority];
}

/**
 * Tabelul din docs/17 §3: antet `--surface-subtle` cu rază 8 px pe capete, text de antet 12 px / 500 în `--text-secondary`,
 * fără linii verticale, linii orizontale `--border-subtle`, rând de 48 px (compact 40 px), cifre tabulare la dreapta,
 * rândul selectat în `--surface-hover`. Regiunea tabelului e un container numit `table` (coloanele își aleg vizibilitatea după el,
 * vezi `TablePriority`); dacă tot nu încape, se derulează orizontal în propria regiune (nu lărgește pagina).
 * Antetele au `scope="col"` implicit; sortarea se marchează cu `aria-sort` pe `Th`.
 */
export function Table({
  className,
  compact = false,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & { compact?: boolean }) {
  return (
    <div className="@container/table w-full overflow-x-auto">
      <table
        data-density={compact ? "compact" : undefined}
        className={cn(
          "group/table w-full border-collapse text-body data-[density=compact]:text-compact",
          className,
        )}
        {...props}
      />
    </div>
  );
}

/** Titlul tabelului pentru cititoarele de ecran (vizual ascuns: titlul paginii e deja pe ecran). */
export function TableCaption({ className, ...props }: HTMLAttributes<HTMLTableCaptionElement>) {
  return <caption className={cn("sr-only", className)} {...props} />;
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("bg-surface-subtle", className)} {...props} />;
}

export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

export function Tr({
  className,
  selected = false,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { selected?: boolean }) {
  return (
    <tr
      aria-selected={selected ? true : undefined}
      className={cn(
        "h-(--row-h) border-b border-line-subtle group-data-[density=compact]/table:h-(--row-h-compact)",
        selected && "bg-surface-hover",
        className,
      )}
      {...props}
    />
  );
}

export function Th({
  className,
  numeric = false,
  priority = "primary",
  scope = "col",
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean; priority?: TablePriority }) {
  return (
    <th
      scope={scope}
      className={cn(
        "h-10 px-3 text-left align-middle text-label text-ink-secondary first:rounded-l-md last:rounded-r-md @max-2xl/table:px-2",
        numeric && "text-right",
        tablePriorityClass(priority),
        className,
      )}
      {...props}
    />
  );
}

export function Td({
  className,
  numeric = false,
  priority = "primary",
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean; priority?: TablePriority }) {
  return (
    <td
      className={cn(
        "px-3 py-2 align-middle @max-2xl/table:px-2",
        numeric && "text-right tabular-nums",
        tablePriorityClass(priority),
        className,
      )}
      {...props}
    />
  );
}
