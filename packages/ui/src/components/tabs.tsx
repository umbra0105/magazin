"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { TabsFade, scrollEdges } from "./tabs-fade";
import { TAB_LIST_CLASS, tabClass } from "./tab-styles";

export interface TabItem {
  id: string;
  label: string;
  /** Conținutul panoului. Panourile rămân montate (starea câmpurilor se păstrează între taburi). */
  panel: ReactNode;
  /** Text scurt lângă etichetă (ex. „●” pentru modificări nesalvate), citit de cititoare de ecran. */
  badge?: ReactNode;
}

export interface TabsProps {
  /** Numele grupului de taburi, pentru cititoare de ecran. */
  label: string;
  tabs: readonly TabItem[];
  defaultTab?: string;
  className?: string;
  /**
   * Un singur rând derulabil pe orizontală, în loc de rânduri multiple (pagini cu multe taburi, ca editarea produsului): tabul nu se
   * strânge și nu se rupe, iar tabul activ e adus în câmpul vizual la montare și la fiecare schimbare.
   */
  scrollable?: boolean;
  /** Apelat la schimbarea tabului activ (mouse sau tastatură). */
  onChange?: (id: string) => void;
}

/**
 * Taburi accesibile (WAI-ARIA Tabs, activare automată): `tablist`/`tab`/`tabpanel`, un singur tab în
 * ordinea Tab (roving tabindex), săgeți stânga/dreapta, Home și End mută și activează. Panourile
 * inactive sunt `hidden`, dar rămân în DOM.
 */
export function Tabs({
  label,
  tabs,
  defaultTab,
  className,
  scrollable = false,
  onChange,
}: TabsProps) {
  const base = useId();
  const initial = tabs.some((t) => t.id === defaultTab) ? (defaultTab as string) : tabs[0]?.id;
  const [active, setActive] = useState<string | undefined>(initial);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  // lista derulabilă: pe ce margini mai sunt taburi ascunse (estompare discretă; doar vizual)
  const [edges, setEdges] = useState({ start: false, end: false });

  // lista derulabilă: tabul activ se aduce în câmpul vizual (doar pe orizontală: pagina nu se mișcă)
  useEffect(() => {
    if (!scrollable || !active) return;
    const tab = refs.current.get(active);
    const list = tab?.parentElement;
    if (!tab || !list) return;
    if (tab.offsetLeft < list.scrollLeft) list.scrollLeft = tab.offsetLeft;
    else if (tab.offsetLeft + tab.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = tab.offsetLeft + tab.offsetWidth - list.clientWidth;
    }
  }, [active, scrollable]);

  useEffect(() => {
    const list = listRef.current;
    if (!scrollable || !list) return;
    const update = () => {
      const next = scrollEdges(list);
      setEdges((current) =>
        current.start === next.start && current.end === next.end ? current : next,
      );
    };
    update();
    list.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(list);
    return () => {
      list.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [scrollable, tabs.length]);

  const select = (id: string, focus = false) => {
    setActive(id);
    onChange?.(id);
    if (focus) refs.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next];
    if (target) select(target.id, true);
  };

  return (
    <div className={className}>
      <div className={scrollable ? "relative border-b border-line-subtle" : undefined}>
        <div
          ref={listRef}
          role="tablist"
          aria-label={label}
          className={
            scrollable ? "relative -mb-px flex flex-nowrap gap-1 overflow-x-auto" : TAB_LIST_CLASS
          }
        >
          {tabs.map((tab, index) => {
            const selected = tab.id === active;
            return (
              <button
                key={tab.id}
                ref={(node) => {
                  if (node) refs.current.set(tab.id, node);
                  else refs.current.delete(tab.id);
                }}
                type="button"
                role="tab"
                id={`${base}-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`${base}-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => select(tab.id)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className={cn(tabClass(selected), scrollable && "mb-0 shrink-0 whitespace-nowrap")}
              >
                {tab.label}
                {tab.badge}
              </button>
            );
          })}
        </div>
        {scrollable && edges.start && <TabsFade edge="start" />}
        {scrollable && edges.end && <TabsFade edge="end" />}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${base}-panel-${tab.id}`}
          aria-labelledby={`${base}-tab-${tab.id}`}
          hidden={tab.id !== active}
          tabIndex={0}
          className="pt-5 focus-visible:outline-none"
        >
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
