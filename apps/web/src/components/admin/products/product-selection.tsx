"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

/**
 * Selecția de produse din lista de produse (bifele din tabel), ținută deasupra tabelului ca s-o vadă și butonul «Exportă» din
 * bara de unelte a paginii (cu o selecție, exportul pornește pe ea). Furnizorul se remontează la fiecare adresă nouă a listei
 * (pagina pune `key`), deci selecția e mereu a paginii curente: nu rămân id-uri ale unei pagini de mai înainte.
 */
interface ProductSelection {
  selected: ReadonlySet<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
}

const SelectionContext = createContext<ProductSelection | null>(null);

export function ProductSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const value = useMemo(() => ({ selected, setSelected }), [selected]);
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useProductSelection(): ProductSelection {
  const value = useContext(SelectionContext);
  if (!value) throw new Error("useProductSelection se folosește doar în ProductSelectionProvider");
  return value;
}
