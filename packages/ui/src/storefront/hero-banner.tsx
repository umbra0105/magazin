import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { Container } from "./container";
import { StoreImage, type StoreImageProps } from "./store-image";

export interface HeroBannerProps {
  /**
   * Fotografia hero-ului. E imaginea LCP: se încarcă MEREU cu prioritate mare, imediat, cu dimensiuni explicite (nu se poate cere
   * leneșă). Umple tot hero-ul.
   */
  image?: Omit<StoreImageProps, "priority" | "className">;
  /** Alternativă la `image`, doar pentru galeria de design (un înlocuitor fără fotografie); în pagini se folosește `image`. */
  media?: ReactNode;
  /** Începutul titlului. */
  title: string;
  /** Expresia pusă în culoarea de accent, la sfârșitul titlului (una singură, în acest loc; `docs/21` §4). */
  accent?: string | undefined;
  lede?: string | undefined;
  /** Butoanele (de obicei `storeButtonVariants({ variant: "onImage" })` și `outlineOnImage`). */
  actions?: ReactNode;
  /** `h1` pe pagina care are hero ca prim element; `h2` când pagina are deja un `h1`. */
  titleAs?: "h1" | "h2";
  className?: string;
}

/**
 * Hero fotografic pe toată lățimea (docs/21 §3.2): fotografia, un strat întunecat dat de preset (`--hero-scrim`, text deschis
 * peste, AA în orice temă), titlul foarte mare cu expresia în accent, o singură frază de ghidare și cel mult două acțiuni.
 * Textul e aliniat la stânga, în coloana comună de conținut. Nicio animație de intrare.
 */
export function HeroBanner({
  image,
  media,
  title,
  accent,
  lede,
  actions,
  titleAs: Title = "h1",
  className,
}: HeroBannerProps) {
  return (
    <section
      data-hero
      className={cn(
        "relative isolate flex min-h-128 items-end overflow-hidden text-on-image",
        className,
      )}
    >
      <div className="absolute inset-0 -z-20 bg-photo-fallback [&_img]:size-full [&_img]:object-cover">
        {image ? <StoreImage {...image} priority /> : media}
      </div>
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-image-scrim" />
      <Container className="py-section">
        <div className="max-w-4xl">
          <Title className="heading-display text-hero text-balance">
            {title}
            {accent ? (
              <>
                {" "}
                <span className="text-accent-on-image">{accent}</span>
              </>
            ) : null}
          </Title>
          {lede ? <p className="mt-6 max-w-2xl text-lede text-on-image">{lede}</p> : null}
          {actions ? <div className="mt-8 flex flex-wrap gap-3">{actions}</div> : null}
        </div>
      </Container>
    </section>
  );
}
