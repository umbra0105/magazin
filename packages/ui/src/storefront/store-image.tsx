import { cn } from "../lib/cn";

export interface StoreImageProps {
  src: string;
  /** Textul alternativ: obligatoriu (gol doar pentru o imagine pur decorativă, la alegerea apelantului). */
  alt: string;
  /** Dimensiunile intrinseci: mereu explicite, ca pagina să nu se mute la încărcare (CLS). */
  width: number;
  height: number;
  srcSet?: string;
  sizes?: string;
  /** Imaginea LCP (prima imagine mare din ecran): încărcare imediată și prioritate mare. Restul se încarcă târziu. */
  priority?: boolean;
  className?: string;
}

/**
 * Imaginea vitrinei (docs/19 §1: «imaginea LCP cu prioritate și dimensiuni explicite»). Un singur loc decide încărcarea: cu
 * `priority` pleacă imediat cu `fetchpriority="high"`, altfel e leneșă cu decodare asincronă. Componenta nu alege sursa
 * (variantele generate de pipeline-ul media vin de la apelant).
 */
export function StoreImage({
  src,
  alt,
  width,
  height,
  srcSet,
  sizes,
  priority = false,
  className,
}: StoreImageProps) {
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      srcSet={srcSet}
      sizes={sizes}
      loading={priority ? "eager" : "lazy"}
      decoding={priority ? "sync" : "async"}
      fetchPriority={priority ? "high" : undefined}
      className={cn("block", className)}
    />
  );
}
