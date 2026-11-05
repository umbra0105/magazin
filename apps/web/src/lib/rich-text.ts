import { createDbMediaResolver, renderRichText, renderRichTextForEditor } from "@ecom/core";
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

/** Conținutul de pornire al editorului vizual: re-sanitizat, cu imaginile arătate prin adresa de previzualizare. */
export function renderDescriptionForEditor(html: string | null | undefined): Promise<string> {
  return renderRichTextForEditor(html, createDbMediaResolver(getDb(), getStorage()));
}

export interface EditorImage {
  id: string;
  src: string;
  alt: string;
}

/** Imaginile alese din bibliotecă pentru descriere: adresa de previzualizare (de pe server) și textul alternativ implicit. */
export async function describeEditorImages(ids: readonly string[]): Promise<EditorImage[]> {
  const db = getDb();
  const resolved = await createDbMediaResolver(db, getStorage())(ids);
  const rows = await db.media.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, alt: true },
  });
  const alts = new Map(rows.map((row) => [row.id, row.alt]));
  return ids.flatMap((id) => {
    const media = resolved.get(id);
    return media ? [{ id, src: media.src, alt: alts.get(id) ?? "" }] : [];
  });
}
