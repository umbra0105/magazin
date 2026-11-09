"use client";

import { useRouter } from "next/navigation";
import { Select } from "@ecom/ui";
import { stockHref, type StockUrlQuery } from "@/lib/stock-url";
import { getMessages } from "@/messages";

const m = getMessages().admin.inventory.pagination;

/**
 * «Rânduri pe pagină» din stânga paginării (docs/17 §3). Schimbarea păstrează căutarea, filtrele și depozitul, dar duce la prima
 * pagină (pagina veche ar putea să nu mai existe). Valorile le dă pagina din nucleu (`STOCK_PAGE_SIZES`).
 */
export function PageSizeSelect({
  query,
  sizes,
  value,
}: {
  query: StockUrlQuery;
  sizes: readonly number[];
  value: number;
}) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-compact text-ink-secondary">
      <span>{m.rowsPerPage}</span>
      <Select
        name="pe-pagina"
        value={String(value)}
        className="w-20"
        onChange={(event) => {
          // se alege dintre valorile permise (nu se convertește textul în număr: regula de arhitectură pentru stoc)
          const size = sizes.find((candidate) => String(candidate) === event.target.value);
          if (size !== undefined) router.push(stockHref({ ...query, pageSize: size, page: 1 }));
        }}
      >
        {sizes.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </Select>
    </label>
  );
}
