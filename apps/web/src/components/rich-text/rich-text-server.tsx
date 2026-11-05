import { renderDescriptionHtml } from "@/lib/rich-text";
import { RichTextView } from "./rich-text";

/**
 * Descrierea unui produs, gata de afișat (Server Component): re-sanitizată și cu imaginile din media rezolvate pe server.
 * Pagina produsului din magazin (Faza 7) și previzualizarea din administrare o folosesc la fel.
 */
export async function RichText({
  html,
  className,
}: {
  html: string | null | undefined;
  className?: string;
}) {
  const rendered = await renderDescriptionHtml(html);
  return <RichTextView html={rendered} {...(className !== undefined && { className })} />;
}
