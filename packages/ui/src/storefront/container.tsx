import type { ElementType, HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export interface ContainerProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
}

/**
 * Coloana de conținut a vitrinei: lățimea maximă din `--container-width` (setarea «lățime container», 72 / 80 / 90 rem) și
 * marginea laterală din `--sf-gutter` (fluidă, 16 → 32 px). Un singur loc pentru alinierea tuturor secțiunilor.
 */
export function Container({ as: Tag = "div", className, ...props }: ContainerProps) {
  return (
    <Tag
      className={cn("mx-auto w-full max-w-(--container-width) px-gutter", className)}
      {...props}
    />
  );
}
