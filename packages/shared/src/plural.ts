/**
 * Acordul numeralului cu substantivul în română: `1 brand`, `2–19 branduri` (și `0 branduri`), apoi `20 de branduri`, `100 de
 * branduri`, `120 de branduri`. Se judecă după ultimele două cifre: 1–19 = plural fără «de», 0 sau 20–99 = plural cu «de»
 * (`101 branduri`, `119 branduri`, `120 de branduri`); exact 1 = singular; exact 0 = plural fără «de». Numărul se scrie cu
 * separatorul de mii românesc (`12.345`). Fără dependențe: se folosește în mesaje, rapoarte și teste.
 */
export function pluralRo(n: number, one: string, many: string, manyDe: string): string {
  const shown = n.toLocaleString("ro-RO");
  if (n === 1) return `${shown} ${one}`;
  const tail = Math.abs(n) % 100;
  if (n === 0 || (tail >= 1 && tail <= 19)) return `${shown} ${many}`;
  return `${shown} ${manyDe}`;
}
