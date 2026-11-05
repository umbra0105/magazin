/**
 * Ce desenează `RichTextView`, ca funcție pură (testată fără JSX): clasa containerului (stilurile `.rich-text` sunt în
 * `globals.css`) și HTML-ul, sau `null` când nu e nimic de afișat.
 */
export function richTextProps(
  html: string | null | undefined,
  extraClassName?: string,
): { className: string; html: string } | null {
  if (!html) return null;
  return { className: extraClassName ? `rich-text ${extraClassName}` : "rich-text", html };
}
