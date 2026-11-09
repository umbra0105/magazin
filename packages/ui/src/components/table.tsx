import type {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { cn } from "../lib/cn";

/**
 * Tabelul din docs/17 §3: antet `--surface-subtle` cu rază 8 px pe capete, text de antet 12 px / 500 în `--text-secondary`,
 * fără linii verticale, linii orizontale `--border-subtle`, rând de 48 px (compact 40 px), cifre tabulare la dreapta,
 * rândul selectat în `--surface-hover`. Pe ecrane înguste se derulează orizontal în propria regiune (nu lărgește pagina).
 * Antetele au `scope="col"` implicit; sortarea se marchează cu `aria-sort` pe `Th`.
 */
export function Table({
  className,
  compact = false,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & { compact?: boolean }) {
  return (
    <div className="w-full overflow-x-auto">
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
  scope = "col",
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope={scope}
      className={cn(
        "h-10 px-3 text-left align-middle text-label text-ink-secondary first:rounded-l-md last:rounded-r-md",
        numeric && "text-right",
        className,
      )}
      {...props}
    />
  );
}

export function Td({
  className,
  numeric = false,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn("px-3 py-2 align-middle", numeric && "text-right tabular-nums", className)}
      {...props}
    />
  );
}
