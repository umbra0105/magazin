"use client";

import { useRouter } from "next/navigation";
import { Label, Select } from "@ecom/ui";
import { stockHref, type StockUrlQuery } from "@/lib/stock-url";
import { getMessages } from "@/messages";

const m = getMessages().admin.inventory.warehouse;

export interface WarehouseOption {
  code: string;
  name: string;
  isDefault: boolean;
}

/**
 * Selectorul de depozit al paginii Stoc (13d). Pagina îl desenează doar cu steagul de multi-depozit pornit și cel puțin două
 * depozite active. Depozitul implicit are valoarea goală (adresa canonică nu are `?depozit=`); celelalte, codul lor. Schimbarea
 * păstrează căutarea și filtrele, dar duce la prima pagină.
 */
export function WarehouseSwitcher({
  query,
  options,
  value,
}: {
  query: StockUrlQuery;
  options: readonly WarehouseOption[];
  /** Codul depozitului ales; gol = depozitul implicit */
  value: string;
}) {
  const router = useRouter();
  return (
    <div className="flex max-w-sm flex-col gap-1.5" data-warehouse-switcher>
      <Label htmlFor="stock-warehouse">{m.label}</Label>
      <Select
        id="stock-warehouse"
        value={value}
        aria-describedby="stock-warehouse-hint"
        onChange={(event) => {
          const code = event.target.value;
          const next: StockUrlQuery = { ...query, page: 1 };
          // depozitul implicit = adresa canonică, fără cod
          if (code) next.warehouseCode = code;
          else delete next.warehouseCode;
          router.push(stockHref(next));
        }}
      >
        {options.map((option) => (
          <option key={option.code} value={option.isDefault ? "" : option.code}>
            {option.name}
          </option>
        ))}
      </Select>
      <p id="stock-warehouse-hint" className="text-xs text-muted-foreground">
        {m.hint}
      </p>
    </div>
  );
}
