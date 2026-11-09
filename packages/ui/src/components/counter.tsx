import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

/** Contor (docs/17 §3): pastilă mică în culoarea brandului, cu text `--on-brand`, cifre tabulare. */
export function Counter({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-label tabular-nums text-on-brand",
        className,
      )}
      {...props}
    />
  );
}
