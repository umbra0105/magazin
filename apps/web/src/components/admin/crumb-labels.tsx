"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Etichetele ultimei migi pe paginile de detaliu (Faza 11, C4). Firimiturile se calculează în browser din adresă, iar adresa
 * `/admin/comenzi/<id>` nu are în ea numărul comenzii: pagina (care a citit deja comanda) îl înregistrează cu `<CrumbLabel>`, iar
 * `Breadcrumbs` îl citește de aici. Înregistrarea se face înainte de desenare (`useLayoutEffect`), deci la navigarea în aplicație
 * nu apare nicio clipă id-ul; la încărcarea inițială, până se hidratează pagina, migă arată numele generic al paginii.
 */
interface CrumbLabelsValue {
  labels: Readonly<Record<string, string>>;
  set: (path: string, label: string | null) => void;
}

const CrumbLabelsContext = createContext<CrumbLabelsValue>({ labels: {}, set: () => undefined });

export function CrumbLabelsProvider({ children }: { children: ReactNode }) {
  const [labels, setLabels] = useState<Readonly<Record<string, string>>>({});
  const set = useCallback((path: string, label: string | null) => {
    setLabels((current) => {
      if (label === null) {
        if (!(path in current)) return current;
        const rest = { ...current };
        delete rest[path];
        return rest;
      }
      return current[path] === label ? current : { ...current, [path]: label };
    });
  }, []);
  const value = useMemo(() => ({ labels, set }), [labels, set]);
  return <CrumbLabelsContext.Provider value={value}>{children}</CrumbLabelsContext.Provider>;
}

export function useCrumbLabels(): Readonly<Record<string, string>> {
  return useContext(CrumbLabelsContext).labels;
}

/** Înregistrează eticheta migi pentru adresa paginii curente (nu desenează nimic). Eticheta nu are date personale: număr sau nume de șablon. */
export function CrumbLabel({ label }: { label: string }) {
  const pathname = usePathname();
  const { set } = useContext(CrumbLabelsContext);
  useLayoutEffect(() => {
    set(pathname, label);
    return () => set(pathname, null);
  }, [pathname, label, set]);
  return null;
}
