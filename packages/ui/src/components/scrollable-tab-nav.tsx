"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { TabsFade, scrollEdges } from "./tabs-fade";

/**
 * Vederile unei pagini desenate ca legături (`<nav>` cu `Link` stilat cu `scrollableTabClass`), pe UN SINGUR RÂND derulabil pe
 * orizontală (docs/17 §3, ca `Tabs scrollable`): taburile nu se strâng și nu se rup pe mai multe rânduri, cel curent
 * (`aria-current="page"`) e adus în câmpul vizual la montare, iar pe marginea unde mai sunt taburi ascunse apare estomparea
 * discretă `TabsFade` (doar vizuală, dispare la capătul derulării). Legăturile rămân legături: fiecare vedere are adresa ei.
 */
export function ScrollableTabNav({
  label,
  children,
  className,
}: {
  /** Numele grupului de vederi, pentru cititoarele de ecran. */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const listRef = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  // tabul curent se aduce în câmpul vizual (doar pe orizontală: pagina nu se mișcă)
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !tab) return;
    if (tab.offsetLeft < list.scrollLeft) list.scrollLeft = tab.offsetLeft;
    else if (tab.offsetLeft + tab.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = tab.offsetLeft + tab.offsetWidth - list.clientWidth;
    }
  });

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
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
  }, [children]);

  return (
    <div className={`relative border-b border-line-subtle ${className ?? ""}`.trim()}>
      <nav
        ref={listRef}
        aria-label={label}
        className="relative -mb-px flex flex-nowrap gap-1 overflow-x-auto"
      >
        {children}
      </nav>
      {edges.start && <TabsFade edge="start" />}
      {edges.end && <TabsFade edge="end" />}
    </div>
  );
}
