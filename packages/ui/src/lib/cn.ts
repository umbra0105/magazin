import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Îmbină clase Tailwind fără conflicte (ultima câștigă). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
