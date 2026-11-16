"use client";

import { Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { STORE_SEARCH_FIELD, cn } from "@ecom/ui";
import { getMessages } from "@/messages";

const m = getMessages().storefront.header;

interface Suggestions {
  products: {
    title: string;
    href: string;
    image: { src: string; alt: string } | null;
    price: string | null;
  }[];
  categories: { name: string; href: string }[];
  brands: { name: string; href: string }[];
}

const EMPTY: Suggestions = { products: [], categories: [], brands: [] };
const MIN_LENGTH = 2;
const DEBOUNCE_MS = 200;

/**
 * Câmpul de căutare din header, cu autocomplete. Fără JavaScript rămâne un formular GET către `/cautare` (funcționează complet);
 * cu JavaScript, după o pauză de tastare, cere sugestii (produse, categorii, mărci) și le arată într-o listă navigabilă cu
 * săgeți (`combobox`/`listbox`). Enter fără o sugestie aleasă trimite căutarea întreagă; Escape închide lista.
 */
export function HeaderSearch({ className }: { className?: string }) {
  const id = useId();
  const [text, setText] = useState("");
  const [found, setFound] = useState<Suggestions>(EMPTY);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLFormElement>(null);

  const links = [
    ...found.products.map((p) => p.href),
    ...found.categories.map((c) => c.href),
    ...found.brands.map((b) => b.href),
  ];

  useEffect(() => {
    if (text.trim().length < MIN_LENGTH) {
      setFound(EMPTY);
      setOpen(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search/suggest?q=${encodeURIComponent(text.trim())}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body = (await response.json()) as Suggestions;
        setFound(body);
        setActive(-1);
        setOpen(body.products.length + body.categories.length + body.brands.length > 0);
      } catch {
        // întrerupt sau fără rețea: formularul rămâne funcțional
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
    } else if (event.key === "ArrowDown" && links.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % links.length);
    } else if (event.key === "ArrowUp" && links.length > 0) {
      event.preventDefault();
      setActive((i) => (i <= 0 ? links.length - 1 : i - 1));
    } else if (event.key === "Enter" && active >= 0 && links[active]) {
      event.preventDefault();
      window.location.assign(links[active]);
    }
  };

  let index = -1;
  const row = (href: string, content: ReactNode, groupStart = false) => {
    index += 1;
    const current = index;
    return (
      <li
        key={href}
        data-group-start={groupStart ? "" : undefined}
        role="option"
        aria-selected={current === active}
        id={`${id}-o${current}`}
      >
        <a
          href={href}
          tabIndex={-1}
          className={cn(
            "flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-card",
            current === active && "bg-card",
          )}
        >
          {content}
        </a>
      </li>
    );
  };

  return (
    <form
      ref={box}
      role="search"
      action="/cautare"
      method="get"
      noValidate
      aria-label={m.searchLabel}
      className={cn("relative", className)}
    >
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-ink-secondary"
      />
      <input
        type="search"
        name="q"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => links.length > 0 && setOpen(true)}
        aria-label={m.searchLabel}
        placeholder={m.searchPlaceholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        {...(active >= 0 ? { "aria-activedescendant": `${id}-o${active}` } : {})}
        className={STORE_SEARCH_FIELD}
      />
      {open ? (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={m.suggestions}
          className="absolute inset-x-0 top-full z-50 mt-2 overflow-hidden rounded-card bg-surface-page py-2 text-ink shadow-popover [&>li[data-group-start]]:mt-2 [&>li[data-group-start]]:border-t [&>li[data-group-start]]:border-line-subtle [&>li[data-group-start]]:pt-2"
        >
          {found.products.map((product) =>
            row(
              product.href,
              <>
                {product.image ? (
                  <img
                    src={product.image.src}
                    alt=""
                    width={40}
                    height={40}
                    className="size-10 shrink-0 rounded-sm bg-media object-contain mix-blend-multiply"
                  />
                ) : null}
                <span className="min-w-0 flex-1 truncate">{product.title}</span>
                {product.price ? (
                  <span className="shrink-0 text-ink-secondary">{product.price}</span>
                ) : null}
              </>,
            ),
          )}
          {found.categories.map((category, i) =>
            row(
              category.href,
              <>
                <span className="text-ink-secondary">{m.suggestCategory}</span>
                <span className="truncate font-medium">{category.name}</span>
              </>,
              i === 0,
            ),
          )}
          {found.brands.map((brand, i) =>
            row(
              brand.href,
              <>
                <span className="text-ink-secondary">{m.suggestBrand}</span>
                <span className="truncate font-medium">{brand.name}</span>
              </>,
              i === 0 && found.categories.length === 0,
            ),
          )}
        </ul>
      ) : null}
    </form>
  );
}
