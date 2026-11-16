import { cn } from "../lib/cn";

export interface AnnouncementBarProps {
  text: string;
  /** Cale locală (`/…`) sau adresă `https://`; lipsă = doar text. Validarea adreselor e în setări; aici doar se alege atributul. */
  href?: string | undefined;
  /** `brand`: culoarea de acțiune a magazinului; `neutral`: suprafața cardurilor. */
  tone?: "brand" | "neutral";
  /** Numele regiunii pentru cititoarele de ecran. */
  label?: string | undefined;
  className?: string;
}

/**
 * Bara de anunț de deasupra header-ului: o frază scurtă, opțional cu un link. Server-rendered, fără JavaScript și fără buton de
 * închidere (nu reține nicio stare). Culorile sunt doar tokeni (acțiune sau card), deci contrastul e cel verificat pentru brand.
 * Textul se afișează mereu ca text, niciodată ca HTML.
 */
export function AnnouncementBar({
  text,
  href,
  tone = "brand",
  label,
  className,
}: AnnouncementBarProps) {
  const external = href ? /^https:\/\//.test(href) : false;
  const link =
    "underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";
  return (
    <aside
      aria-label={label}
      className={cn(
        "px-gutter py-2.5 text-center text-sm font-medium",
        tone === "brand" ? "bg-action text-action-fg" : "bg-card text-ink",
        className,
      )}
    >
      {href ? (
        <a
          href={href}
          className={cn(link, tone === "brand" && "focus-visible:ring-action-fg")}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        >
          {text}
        </a>
      ) : (
        <p>{text}</p>
      )}
    </aside>
  );
}
