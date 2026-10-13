import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export interface ProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** 0–100; `undefined` = nedeterminat. */
  value?: number;
  /** Etichetă pentru cititoarele de ecran (obligatorie). */
  label: string;
}

export function Progress({ value, label, className, ...props }: ProgressProps) {
  const clamped = value === undefined ? undefined : Math.min(100, Math.max(0, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(clamped !== undefined && { "aria-valuenow": clamped })}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-border/60", className)}
      {...props}
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary transition-[width]",
          clamped === undefined && "w-1/3 animate-pulse",
        )}
        style={clamped === undefined ? undefined : { width: `${clamped}%` }}
      />
    </div>
  );
}
