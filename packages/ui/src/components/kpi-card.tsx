import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Cardul de indicator (docs/17 §3): fundal pastelat din §2.3 (numai ca fundal; textul rămâne `--text-primary`), rază 12 px, fără
 * bordură și fără umbră. Cu `interactive` (card-legătură) are cursor deasupra și inel de focus. Semnificația stării nu stă în culoarea
 * fundalului, ci în cifră, text sau pastilă.
 */
export const kpiCardVariants = cva("relative flex flex-col gap-1 rounded-lg p-4 text-ink", {
  variants: {
    tone: {
      cyan: "bg-kpi-cyan",
      green: "bg-kpi-green",
      indigo: "bg-kpi-indigo",
      peach: "bg-kpi-peach",
    },
    interactive: {
      true:
        "transition-colors duration-(--motion) hover:brightness-95 " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
      false: "",
    },
  },
  defaultVariants: { tone: "indigo", interactive: false },
});

export interface KpiContentProps {
  label: string;
  /** Cifra mare (28 px) sau, pentru o stare, o pastilă. */
  value: ReactNode;
  /** Rândul de explicație de sub valoare. */
  detail?: ReactNode;
}

/** Conținutul cardului, separat ca să se poată pune și într-o legătură (`kpiCardVariants` pe `Link`). */
export function KpiContent({ label, value, detail }: KpiContentProps) {
  const isNumber = typeof value === "string" || typeof value === "number";
  return (
    <>
      <span className="text-label text-ink-secondary">{label}</span>
      {isNumber ? (
        <span data-value className="text-kpi tabular-nums">
          {value}
        </span>
      ) : (
        <span data-value>{value}</span>
      )}
      {detail ? <span className="text-label text-ink-secondary">{detail}</span> : null}
    </>
  );
}

export interface KpiCardProps
  extends
    Omit<HTMLAttributes<HTMLDivElement>, "children">,
    VariantProps<typeof kpiCardVariants>,
    KpiContentProps {}

export function KpiCard({
  className,
  tone,
  interactive,
  label,
  value,
  detail,
  ...props
}: KpiCardProps) {
  return (
    <div className={cn(kpiCardVariants({ tone, interactive }), className)} {...props}>
      <KpiContent label={label} value={value} detail={detail} />
    </div>
  );
}
