import { createDbMediaResolver, renderRichText } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getMessages } from "@/messages";
import { getStorage } from "./media";

/** `sizes` al imaginilor din descriere: coloana de conținut e cel mult ~48rem lată. */
const IMAGE_SIZES = "(min-width: 48rem) 48rem, 100vw";

/** HTML-ul descrierii, re-sanitizat și cu imaginile rezolvate din biblioteca media (doar pe server). */
export function renderDescriptionHtml(html: string | null | undefined): Promise<string> {
  return renderRichText(html, createDbMediaResolver(getDb(), getStorage()), {
    tableLabel: getMessages().richText.tableLabel,
    imageSizes: IMAGE_SIZES,
  });
}
