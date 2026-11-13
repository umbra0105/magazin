/**
 * Frâna de mână (docs/20 §6.4): dacă există `STOP.txt` în rădăcina proiectului (necomis, în `.gitignore`), Claude Code termină pasul
 * curent, comite, notează starea și se oprește. Utilizatorul îl poate crea de oriunde. Se verifică la începutul fiecărui pas.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface StopCheck {
  stop: boolean;
  message: string;
}

export function checkStop(root: string): StopCheck {
  if (existsSync(join(root, "STOP.txt"))) {
    return {
      stop: true,
      message:
        "STOP.txt există: termină pasul curent, comite, notează starea în docs/PROGRESS.md și oprește-te.",
    };
  }
  return { stop: false, message: "Fără STOP.txt: poți continua." };
}
