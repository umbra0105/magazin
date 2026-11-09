import type { LabelHTMLAttributes } from "react";
import { cn } from "../lib/cn";

/** Eticheta de câmp (docs/17 §3): deasupra câmpului, 12 px / 500, `--text-secondary`. */
export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-label text-ink-secondary", className)} {...props} />;
}
