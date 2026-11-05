import { richTextProps } from "./rich-text-props";

/**
 * Singurul loc din aplicație (în afara scriptului de temă) care pune HTML în pagină cu `dangerouslySetInnerHTML`
 * (testul de arhitectură `description-writes` o impune). Primește DOAR HTML produs de `renderRichText` din
 * `@ecom/core`: re-sanitizat pe server, cu imaginile rezolvate din biblioteca media. Nu are nicio altă sursă.
 */
export function RichTextView({
  html,
  className,
}: {
  html: string | null | undefined;
  className?: string;
}) {
  const props = richTextProps(html, className);
  if (!props) return null;
  return <div className={props.className} dangerouslySetInnerHTML={{ __html: props.html }} />;
}
