"use client";

import { useRouter } from "next/navigation";
import { Select } from "@ecom/ui";
import { getMessages } from "@/messages";

const m = getMessages().admin.products.pagination;

/**
 * «Rânduri pe pagină» din stânga paginării (docs/17 §3). Pagina dă, pentru fiecare valoare permisă, adresa deja construită
 * (păstrează căutarea și filtrele, duce la prima pagină), deci aici nu se construiește și nu se convertește nimic.
 */
export function RowsPerPage({
  options,
  value,
}: {
  options: readonly { size: number; href: string }[];
  value: number;
}) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-compact text-ink-secondary">
      <span>{m.rowsPerPage}</span>
      <Select
        name="size"
        value={String(value)}
        className="w-20"
        onChange={(event) => {
          const choice = options.find((option) => String(option.size) === event.target.value);
          if (choice) router.push(choice.href);
        }}
      >
        {options.map((option) => (
          <option key={option.size} value={option.size}>
            {option.size}
          </option>
        ))}
      </Select>
    </label>
  );
}
