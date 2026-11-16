import type { SpecRow } from "@ecom/core";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog.product;

/** Numărul exact din bază (`12.5000`) în forma din limba magazinului («12,5»); fără rotunjire peste 4 zecimale. */
export function formatSpecNumber(value: string, locale: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(number);
}

export function specText(row: SpecRow, locale: string): string {
  if (row.type === "number") {
    const number = formatSpecNumber(row.value, locale);
    return row.unit ? `${number} ${row.unit}` : number;
  }
  if (row.type === "bool") return row.value === "true" ? m.specBool.true : m.specBool.false;
  return row.value;
}

/**
 * Specificațiile tehnice ca tabel real (în HTML-ul de pe server): un rând per atribut, nume în stânga, valoare în dreapta.
 * Atributele numerice poartă unitatea de măsură din atribut.
 */
export function SpecsTable({ rows, locale }: { rows: readonly SpecRow[]; locale: string }) {
  if (rows.length === 0) return <p className="text-ink-secondary">{m.specsEmpty}</p>;
  return (
    <table className="w-full max-w-3xl border-collapse text-left">
      <caption className="sr-only">{m.specsCaption}</caption>
      <tbody>
        {rows.map((row) => (
          <tr key={row.code} className="border-b border-line-subtle last:border-b-0">
            <th scope="row" className="w-2/5 py-3 pr-4 align-top font-medium text-ink-secondary">
              {row.name}
            </th>
            <td className="py-3 align-top">{specText(row, locale)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
