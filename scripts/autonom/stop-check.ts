/**
 * `npm.cmd run autonom:stop-check`: frâna de mână (docs/20 §6.4), la începutul fiecărui pas al unei faze autonome. Cod de ieșire 3 =
 * există `STOP.txt`, deci pasul curent se termină, se comite, se notează starea și Claude Code se oprește. Logica e în `stop-core.ts`.
 */
import { checkStop } from "./stop-core";

const result = checkStop(process.cwd());
if (result.stop) {
  console.error(result.message);
  process.exit(3);
}
console.log(result.message);
