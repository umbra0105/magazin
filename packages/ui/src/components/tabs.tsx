"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../lib/cn";

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
  /** Apelat la schimbarea tabului activ (mouse sau tastatură). */
  onChange?: (id: string) => void;
}

/**
 * Taburi accesibile (WAI-ARIA Tabs, activare automată): `tablist`/`tab`/`tabpanel`, un singur tab în
 * ordinea Tab (roving tabindex), săgeți stânga/dreapta, Home și End mută și activează. Panourile
 * inactive sunt `hidden`, dar rămân în DOM.
 */
export function Tabs({ label, tabs, defaultTab, className, onChange }: TabsProps) {
  const base = useId();
  const initial = tabs.some((t) => t.id === defaultTab) ? (defaultTab as string) : tabs[0]?.id;
  const [active, setActive] = useState<string | undefined>(initial);
  const refs = useRef(new Map<string, HTMLButtonElement>());

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
      <div
        role="tablist"
        aria-label={label}
        className="flex flex-wrap gap-1 border-b border-border"
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
              className={cn(
                "-mb-px inline-flex min-h-11 items-center gap-1.5 rounded-t-md border border-transparent px-4 text-sm font-medium",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                selected
                  ? "border-border border-b-background bg-background text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.badge}
            </button>
          );
        })}
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
