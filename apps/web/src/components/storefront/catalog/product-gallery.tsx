"use client";

import { useState } from "react";
import { StoreImage } from "@ecom/ui";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog.product;

export interface GalleryItem {
  thumb: { src: string; width: number; height: number; alt: string };
  large: { src: string; width: number; height: number; alt: string };
}

/**
 * Galeria produsului. Prima imagine mare e imaginea LCP (prioritate, dimensiuni explicite) și e în HTML-ul de pe server;
 * miniaturile sunt legături către imaginea mare (fără JavaScript deschid imaginea; cu JavaScript o schimbă în loc). Nu folosește
 * `<select>` și nu își ține starea în adresă: alegerea e doar a vizitatorului.
 */
export function ProductGallery({ items }: { items: readonly GalleryItem[] }) {
  const [index, setIndex] = useState(0);
  if (items.length === 0) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-card bg-media text-ink-secondary">
        {m.noImage}
      </div>
    );
  }
  const current = items[index] ?? items[0];
  if (!current) return null;
  return (
    <section aria-label={m.gallery.label} className="flex flex-col gap-4">
      <div
        data-gallery-main
        className="relative isolate aspect-square overflow-hidden rounded-card bg-media p-4 [&_img]:size-full [&_img]:object-contain [&_img]:mix-blend-multiply"
      >
        <StoreImage
          key={current.large.src}
          src={current.large.src}
          alt={current.large.alt}
          width={current.large.width}
          height={current.large.height}
          sizes="(min-width: 64rem) 50vw, 100vw"
          priority={index === 0}
        />
      </div>
      {items.length > 1 ? (
        <ul aria-label={m.gallery.thumbnails} className="grid grid-cols-5 gap-2 sm:grid-cols-6">
          {items.map((item, i) => (
            <li key={item.thumb.src}>
              <a
                href={item.large.src}
                aria-label={m.gallery.show(i + 1, items.length)}
                {...(i === index ? { "aria-current": "true" as const } : {})}
                onClick={(event) => {
                  event.preventDefault();
                  setIndex(i);
                }}
                className={
                  "relative isolate block aspect-square overflow-hidden rounded-card bg-media p-1.5 outline-none transition-shadow duration-(--motion) " +
                  "[&_img]:size-full [&_img]:object-contain [&_img]:mix-blend-multiply focus-visible:ring-2 focus-visible:ring-brand " +
                  (i === index ? "ring-2 ring-brand" : "hover:ring-2 hover:ring-line-control")
                }
              >
                <StoreImage
                  src={item.thumb.src}
                  alt=""
                  width={item.thumb.width}
                  height={item.thumb.height}
                />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
