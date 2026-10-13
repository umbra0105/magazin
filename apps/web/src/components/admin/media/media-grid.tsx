"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@ecom/ui";

/**
 * Grila de carduri a bibliotecii (și a selectorului): `ul` cu navigare prin săgeți, Home și End
 * între elementele `[data-media-card]`. Numărul de coloane se deduce din poziția cardurilor, deci
 * funcționează la orice lățime (telefon, desktop).
 */
export function MediaGrid({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const grid = useRef<HTMLUListElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const cards = [
      ...(grid.current?.querySelectorAll<HTMLButtonElement>("[data-media-card]") ?? []),
    ];
    const index = cards.findIndex((c) => c === document.activeElement);
    if (index < 0 || cards.length === 0) return;
    const firstTop = cards[0]?.offsetTop ?? 0;
    const columns = Math.max(cards.filter((c) => c.offsetTop === firstTop).length, 1);
    const delta: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -columns,
      ArrowDown: columns,
    };
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? cards.length - 1
          : Math.min(Math.max(index + (delta[event.key] ?? 0), 0), cards.length - 1);
    event.preventDefault();
    cards[target]?.focus();
  };

  return (
    <ul
      ref={grid}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4", className)}
    >
      {children}
    </ul>
  );
}
