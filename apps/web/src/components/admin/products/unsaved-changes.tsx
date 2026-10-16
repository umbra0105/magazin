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
import { Button, Dialog } from "@ecom/ui";
import { getMessages } from "@/messages";

/**
 * Protecție la pierderea modificărilor. Fiecare tab își declară starea „modificat” cu
 * `useDirtyFlag(cheie, dirty)`; cât timp cel puțin unul e modificat:
 *  - închiderea sau reîncărcarea paginii cere confirmare (`beforeunload`);
 *  - click pe un link către altă pagină cere confirmare (interceptat în faza de capture, înaintea
 *    navigării Next), într-un dialog propriu al aplicației (nu `window.confirm`: textele native ies în
 *    limba browserului); la «Ies» se repetă click-ul pe același link;
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

type Pending = { kind: "link"; anchor: HTMLAnchorElement } | { kind: "back" };

export function UnsavedChangesProvider({
  message,
  children,
}: {
  message: string;
  children: ReactNode;
}) {
  const labels = getMessages().admin.products.editor;
  const [dirtyKeys, setDirtyKeys] = useState<readonly string[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const dirty = dirtyKeys.length > 0;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const sentinel = useRef(false);
  const stayButton = useRef<HTMLButtonElement>(null);
  /** Setat cât timp se execută o ieșire confirmată: interceptările stau deoparte. */
  const leaving = useRef(false);

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
      // dialogul nativ al browserului rămâne (îl controlează browserul); nu apare la o ieșire confirmată
      if (leaving.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      if (leaving.current || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#") || sameDocument(href)) return;
      // navigarea așteaptă decizia din dialogul aplicației
      event.preventDefault();
      event.stopPropagation();
      setPending({ kind: "link", anchor });
    };
    const onPopState = () => {
      if (leaving.current || !dirtyRef.current) return;
      // rămânem pe pagină până decide utilizatorul: refacem intrarea sentinelă
      window.history.pushState(null, "", window.location.href);
      setPending({ kind: "back" });
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
  }, [dirty]);

  // butonul sigur („rămân”) primește focusul după ce dialogul modal s-a deschis
  useEffect(() => {
    if (pending === null) return;
    const frame = window.requestAnimationFrame(() => stayButton.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [pending]);

  const stay = useCallback(() => setPending(null), []);
  const leave = useCallback(() => {
    const target = pending;
    setPending(null);
    if (!target) return;
    leaving.current = true;
    if (target.kind === "link") target.anchor.click();
    // două intrări în urmă: sentinela și pagina curentă
    else window.history.go(-2);
    window.setTimeout(() => {
      leaving.current = false;
    }, 1500);
  }, [pending]);

  const value = useMemo(() => ({ setDirty, dirtyKeys }), [setDirty, dirtyKeys]);
  return (
    <UnsavedContext.Provider value={value}>
      {children}
      <Dialog
        open={pending !== null}
        onClose={stay}
        title={labels.unsavedTitle}
        description={message}
        closeLabel={labels.unsavedClose}
        className="max-w-md"
      >
        <div className="flex flex-wrap justify-end gap-2" data-unsaved-dialog>
          <Button variant="outline" onClick={leave} data-unsaved-leave>
            {labels.unsavedLeave}
          </Button>
          <Button ref={stayButton} onClick={stay} data-unsaved-stay>
            {labels.unsavedStay}
          </Button>
        </div>
      </Dialog>
    </UnsavedContext.Provider>
  );
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
