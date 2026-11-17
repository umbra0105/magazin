import { cn } from "../lib/cn";

export const ENERGY_SCALE = ["A+++", "A++", "A+", "A", "B", "C", "D", "E", "F", "G"] as const;

export interface EnergyLabelProps {
  /** Clasa energetică de pe scara europeană (A+++ … G); o valoare din afara scării nu desenează nimic. */
  energyClass: string;
  /** Textul pentru cititoarele de ecran și pentru `title` («Clasa energetică A+++»); vine de la apelant. */
  label: string;
  /** `sm` pe card, `lg` pe pagina de produs. */
  size?: "sm" | "lg";
  className?: string;
}

/**
 * Eticheta energetică (docs/15): treapta produsului pe scara A+++ … G, cu culoarea convenției europene (tokeni `.energy-label`,
 * fără hex în componentă). Se arată pe card și pe pagina de produs, înainte de finalizarea comenzii; nu e doar în specificații.
 */
export function EnergyLabel({ energyClass, label, size = "sm", className }: EnergyLabelProps) {
  if (!(ENERGY_SCALE as readonly string[]).includes(energyClass)) return null;
  return (
    <span
      className={cn(
        "energy-label inline-flex items-center justify-center rounded-sm font-bold leading-none",
        size === "sm" ? "min-h-6 px-2 text-xs" : "min-h-9 px-3 text-base",
        className,
      )}
      data-energy={energyClass}
      role="img"
      aria-label={label}
      title={label}
    >
      {energyClass}
    </span>
  );
}
