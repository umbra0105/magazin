"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog.product;

export interface ProductTab {
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * Taburile paginii de produs. Toate panourile sunt în HTML-ul de pe server (descrierea și specificațiile se indexează și se
 * citesc fără JavaScript, una sub alta, fiecare cu titlul ei); după hidratare apare bara de taburi și se arată un singur panou.
 * Navigare cu săgeți, `role="tablist"`.
 */
export function ProductTabs({ tabs }: { tabs: readonly ProductTab[] }) {
  const base = useId();
  const [active, setActive] = useState(0);
  const [enhanced, setEnhanced] = useState(false);
  useEffect(() => setEnhanced(true), []);
  if (tabs.length === 0) return null;

  const move = (to: number) => {
    const next = (to + tabs.length) % tabs.length;
    setActive(next);
    document.getElementById(`${base}-tab-${next}`)?.focus();
  };

  return (
    <div data-product-tabs>
      {enhanced ? (
        <div
          role="tablist"
          aria-label={m.tabs.label}
          className="flex flex-wrap gap-2 border-b border-line-subtle pb-3"
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") move(active + 1);
            else if (event.key === "ArrowLeft") move(active - 1);
            else if (event.key === "Home") move(0);
            else if (event.key === "End") move(tabs.length - 1);
            else return;
            event.preventDefault();
          }}
        >
          {tabs.map((tab, i) => (
            <button
              key={tab.id}
              id={`${base}-tab-${i}`}
              type="button"
              role="tab"
              aria-selected={i === active}
              aria-controls={`${base}-panel-${i}`}
              tabIndex={i === active ? 0 : -1}
              onClick={() => setActive(i)}
              className={
                "inline-flex h-11 items-center rounded-full px-5 text-sm font-semibold transition-colors duration-(--motion) " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand " +
                (i === active ? "bg-action text-action-fg" : "bg-card text-ink hover:bg-card-hover")
              }
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-col gap-10 pt-6">
        {tabs.map((tab, i) => (
          <section
            key={tab.id}
            id={`${base}-panel-${i}`}
            role={enhanced ? "tabpanel" : undefined}
            aria-labelledby={enhanced ? `${base}-tab-${i}` : undefined}
            hidden={enhanced && i !== active}
          >
            {enhanced ? null : <h2 className="heading-display mb-4 text-2xl">{tab.label}</h2>}
            {tab.content}
          </section>
        ))}
      </div>
    </div>
  );
}
