"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Protecție la pierderea modificărilor. Fiecare tab își declară starea „modificat” cu
 * `useDirtyFlag(cheie, dirty)`; cât timp cel puțin unul e modificat:
 *  - închiderea sau reîncărcarea paginii cere confirmare (`beforeunload`);
 *  - click pe un link către altă pagină cere confirmare (interceptat în faza de capture, înaintea
 *    navigării Next);
 *  - butonul „înapoi” al browserului cere confirmare (o intrare sentinelă în istoric, o singură dată).
 * Mesajul vine din mesajele aplicației (`message`). Starea nu se scrie nicăieri (doar în memorie).
 */

interface Registry {
  setDirty: (key: string, dirty: boolean) => void;
  dirtyKeys: readonly string[];
}

const UnsavedContext = createContext<Registry | null>(null);

function sameDocument(href: string): boolean {
  try {
    const url = new URL(href, window.location.href);
    return (
      url.origin === window.location.origin &&
      url.pathname === window.location.pathname &&
      url.search === window.location.search
    );
  } catch {
    return false;
  }
}

export function UnsavedChangesProvider({
  message,
  children,
}: {
  message: string;
  children: ReactNode;
}) {
  const [dirtyKeys, setDirtyKeys] = useState<readonly string[]>([]);
  const dirty = dirtyKeys.length > 0;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const sentinel = useRef(false);

  const setDirty = useCallback((key: string, value: boolean) => {
    setDirtyKeys((current) => {
      const has = current.includes(key);
      if (value === has) return current;
      return value ? [...current, key] : current.filter((k) => k !== key);
    });
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#") || sameDocument(href)) return;
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const onPopState = () => {
      if (!dirtyRef.current) return;
      if (window.confirm(message)) {
        window.removeEventListener("popstate", onPopState);
        window.history.back();
      } else {
        window.history.pushState(null, "", window.location.href);
      }
    };

    if (!sentinel.current) {
      window.history.pushState(null, "", window.location.href);
      sentinel.current = true;
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
    };
  }, [dirty, message]);

  const value = useMemo(() => ({ setDirty, dirtyKeys }), [setDirty, dirtyKeys]);
  return <UnsavedContext.Provider value={value}>{children}</UnsavedContext.Provider>;
}

/** Declară dacă tabul `key` are modificări nesalvate. Se curăță singur la demontare. */
export function useDirtyFlag(key: string, dirty: boolean): void {
  const registry = useContext(UnsavedContext);
  const setDirty = registry?.setDirty;
  useEffect(() => {
    setDirty?.(key, dirty);
    return () => setDirty?.(key, false);
  }, [setDirty, key, dirty]);
}

/** Cheile taburilor cu modificări nesalvate (pentru indicatorul din bara de taburi). */
export function useDirtyKeys(): readonly string[] {
  return useContext(UnsavedContext)?.dirtyKeys ?? [];
}
