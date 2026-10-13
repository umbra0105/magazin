"use client";

import { AlertTriangle, ImageOff, Loader2 } from "lucide-react";
import { Badge, cn } from "@ecom/ui";
import { getMessages } from "@/messages";
import type { LibraryItem } from "./media-types";

const m = getMessages().admin.media;

const STATUS_VARIANT = {
  pending: "neutral",
  processing: "info",
  ready: "success",
  failed: "danger",
} as const;

/**
 * Cardul unui fișier: folosește DOAR varianta thumb (niciodată originalul) și, cât timp aceasta nu
 * există sau se încarcă, placeholderul calculat din blurhash. Butonul întreg e ținta de atingere.
 */
export function MediaCard({ item, onOpen }: { item: LibraryItem; onOpen: (id: string) => void }) {
  const status = item.status as keyof typeof STATUS_VARIANT;
  const busy = item.status === "pending" || item.status === "processing";
  return (
    <li>
      <button
        type="button"
        data-media-card
        onClick={() => onOpen(item.id)}
        aria-label={m.grid.open(item.originalName)}
        className={cn(
          "group flex w-full flex-col overflow-hidden rounded-lg border border-border bg-background text-left " +
            "hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        )}
      >
        <span
          className="relative block aspect-[4/3] w-full overflow-hidden bg-border/40"
          style={
            item.placeholder
              ? { backgroundImage: `url(${item.placeholder})`, backgroundSize: "cover" }
              : undefined
          }
        >
          {item.thumb ? (
            // eslint-disable-next-line @next/next/no-img-element -- thumb-uri deja optimizate de worker
            <img
              src={item.thumb.url}
              alt={item.alt}
              width={item.thumb.width}
              height={item.thumb.height}
              loading="lazy"
              decoding="async"
              className="size-full object-cover"
            />
          ) : (
            <span className="flex size-full flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
              {busy ? (
                <Loader2 aria-hidden="true" className="size-5 animate-spin" />
              ) : item.status === "failed" ? (
                <AlertTriangle aria-hidden="true" className="size-5" />
              ) : (
                <ImageOff aria-hidden="true" className="size-5" />
              )}
              {m.grid.noPreview}
            </span>
          )}
        </span>
        <span className="flex flex-col gap-1 p-2">
          <span className="truncate text-sm font-medium">{item.originalName}</span>
          <span className="flex flex-wrap items-center gap-1">
            <Badge variant={STATUS_VARIANT[status] ?? "neutral"}>
              {m.status[status] ?? item.status}
            </Badge>
            {!item.alt && item.status === "ready" && (
              <Badge variant="neutral">{m.grid.noAlt}</Badge>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}
