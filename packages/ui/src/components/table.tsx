import type {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { cn } from "../lib/cn";

/**
 * Prioritatea unei coloane (docs/17 §3, «Prioritatea coloanelor»): `primary` se vede mereu; `secondary` apare când tabelul are cel
 * puțin 48rem lățime, `tertiary` de la 60rem și `detail` de la 68rem (containerele `@3xl`, `@tier-3` și `@tier-4`; ultimele două
 * sunt definite în `globals.css`). Se măsoară lățimea TABELULUI (nu a ferestrei): bara laterală și marginile paginii îi iau din
 * lățime, deci pe aceeași fereastră tabelul poate avea mai mult sau mai puțin loc. Același `priority` se pune pe antet și pe toate
 * celulele coloanei, inclusiv pe rândurile de total. În modul stivuit (`Table stacked`), coloanele ne-principale rămân ascunse.
 */
export type TablePriority = "primary" | "secondary" | "tertiary" | "detail";

/**
 * Locul unei celule în cardul modului stivuit (`Table stacked`, sub 42rem de tabel): `title` = pe toată lățimea, în capul cardului;
 * `lead` = capul cardului, dar pe aceeași linie cu celulele dinaintea lui (caseta de selecție, imaginea): umple restul liniei;
 * `inline` = pe aceeași linie cu celelalte (implicit); `actions` = pe toată lățimea, ultima linie, cu butoanele.
 */
export type TableStack = "title" | "lead" | "inline" | "actions";

// Clasele sunt scrise întregi (nu compuse): Tailwind găsește clasele doar ca text. Modul stivuit e activat doar de `data-stacked`
// de pe tabel, deci celelalte tabele rămân neatinse; «sub 42rem» = `@max-2xl` pe containerul `table`.
const PRIORITY_CLASS: Record<TablePriority, string> = {
  primary: "group-data-[stacked]/table:@max-2xl/table:block",
  secondary: "hidden @3xl/table:table-cell",
  tertiary: "hidden @tier-3/table:table-cell",
  detail: "hidden @tier-4/table:table-cell",
};

const STACK_CLASS: Record<TableStack, string> = {
  title: "group-data-[stacked]/table:@max-2xl/table:basis-full",
  lead: "group-data-[stacked]/table:@max-2xl/table:min-w-48 group-data-[stacked]/table:@max-2xl/table:flex-1",
  inline: "",
  actions: "group-data-[stacked]/table:@max-2xl/table:basis-full",
};

export function tablePriorityClass(priority: TablePriority): string {
  return PRIORITY_CLASS[priority];
}

export function tableStackClass(stack: TableStack): string {
  return STACK_CLASS[stack];
}

/** În card celula nu mai are umplutură proprie (o dă rândul), cifrele merg la stânga și celula goală dispare (fără goluri). */
const STACKED_CELL =
  "group-data-[stacked]/table:@max-2xl/table:p-0 group-data-[stacked]/table:@max-2xl/table:empty:hidden";
const STACKED_NUMERIC = "group-data-[stacked]/table:@max-2xl/table:text-left";

const STACKED_ROW =
  "group-data-[stacked]/table:@max-2xl/table:flex group-data-[stacked]/table:@max-2xl/table:flex-wrap " +
  "group-data-[stacked]/table:@max-2xl/table:items-center group-data-[stacked]/table:@max-2xl/table:gap-x-3 " +
  "group-data-[stacked]/table:@max-2xl/table:gap-y-1 group-data-[stacked]/table:@max-2xl/table:h-auto " +
  "group-data-[stacked]/table:@max-2xl/table:px-2 group-data-[stacked]/table:@max-2xl/table:py-2";

/**
 * Tabelul din docs/17 §3: antet `--surface-subtle` cu rază 8 px pe capete, text de antet 12 px / 500 în `--text-secondary`,
 * fără linii verticale, linii orizontale `--border-subtle`, rând de 48 px (compact 40 px), cifre tabulare la dreapta,
 * rândul selectat în `--surface-hover`. Regiunea tabelului e un container numit `table` (coloanele își aleg vizibilitatea după el,
 * vezi `TablePriority`); dacă tot nu încape, se derulează orizontal în propria regiune (nu lărgește pagina).
 * Antetele au `scope="col"` implicit; sortarea se marchează cu `aria-sort` pe `Th`.
 *
 * Cu `stacked`, sub 42rem de tabel (telefon) tabelul devine o listă de carduri: fiecare rând e un card (flex cu împachetare),
 * antetul rămâne doar pentru cititoarele de ecran, iar celulele se așază după `stack` (`title`, `inline`, `actions`). Rolurile ARIA
 * sunt explicite pe toate elementele (tabelul își păstrează semantica și când se schimbă `display`).
 */
export function Table({
  className,
  compact = false,
  stacked = false,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & { compact?: boolean; stacked?: boolean }) {
  return (
    <div className="@container/table w-full overflow-x-auto">
      <table
        role="table"
        data-density={compact ? "compact" : undefined}
        data-stacked={stacked ? "" : undefined}
        className={cn(
          "group/table w-full border-collapse text-body data-[density=compact]:text-compact data-[stacked]:@max-2xl/table:block",
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
  return (
    <thead
      role="rowgroup"
      className={cn(
        "bg-surface-subtle group-data-[stacked]/table:@max-2xl/table:sr-only",
        className,
      )}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody
      role="rowgroup"
      className={cn("group-data-[stacked]/table:@max-2xl/table:block", className)}
      {...props}
    />
  );
}

export function Tr({
  className,
  selected = false,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { selected?: boolean }) {
  return (
    <tr
      role="row"
      aria-selected={selected ? true : undefined}
      className={cn(
        "h-(--row-h) border-b border-line-subtle group-data-[density=compact]/table:h-(--row-h-compact)",
        STACKED_ROW,
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
      role="columnheader"
      className={cn(
        "h-10 px-3 text-left align-middle text-label text-ink-secondary first:rounded-l-md last:rounded-r-md",
        numeric && "text-right",
        tablePriorityClass(priority),
        className,
      )}
      {...props}
    />
  );
}

/**
 * Celula-antet a rândului (de obicei numele): `th scope="row"`. În modul stivuit stă în capul cardului, pe toată lățimea.
 * Textul lung se rupe oriunde doar când nu mai încape (cod lung într-o coloană îngustă), nu lărgește tabelul.
 */
export function RowHeader({
  className,
  stack = "title",
  ...props
}: Omit<ThHTMLAttributes<HTMLTableCellElement>, "scope"> & { stack?: TableStack }) {
  return (
    <th
      scope="row"
      role="rowheader"
      className={cn(
        "px-3 py-2 text-left align-middle font-normal wrap-anywhere",
        STACKED_CELL,
        tablePriorityClass("primary"),
        tableStackClass(stack),
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
  stack = "inline",
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & {
  numeric?: boolean;
  priority?: TablePriority;
  stack?: TableStack;
}) {
  return (
    <td
      role="cell"
      className={cn(
        "px-3 py-2 align-middle",
        STACKED_CELL,
        numeric && `text-right tabular-nums ${STACKED_NUMERIC}`,
        tablePriorityClass(priority),
        tableStackClass(stack),
        className,
      )}
      {...props}
    />
  );
}
