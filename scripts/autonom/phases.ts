/**
 * Fazele modului autonom și modul fiecăreia (docs/20 §3). O fază care nu e în tabel nu trece de poartă: nu se presupune «A».
 *  - A: autonom, fără aprobare la îmbinare;
 *  - B: autonom cu poartă umană (aprobare în `docs/AUTONOM-APROBARI.md`);
 *  - C: cu punct de control (aprobare, ca la B).
 */
export type Mode = "A" | "B" | "C";

export const PHASE_MODES: Readonly<Record<string, Mode>> = {
  "redesign-final": "A",
  "redesign-finisaje": "A",
  "11": "A",
  "12": "A",
  "14": "A",
  "16": "A",
  "17": "A",
  "19": "A",
  "20": "A",
  "8": "B",
  "9": "B",
  "10": "B",
  "13": "B",
  "14b": "B",
  "15": "B",
  "15b": "B",
  "6": "C",
  "7": "C",
  "18": "C",
  "22": "C",
};

/** Identificatorul intră în nume de ramură, de etichete și în comenzi `git`/`gh`: doar litere mici, cifre, «-» și «.». */
const PHASE_ID = /^[a-z0-9][a-z0-9.-]{0,30}$/;

export function isValidPhaseId(phase: string): boolean {
  return PHASE_ID.test(phase);
}

export function modeOf(phase: string): Mode | null {
  return Object.prototype.hasOwnProperty.call(PHASE_MODES, phase)
    ? (PHASE_MODES[phase] ?? null)
    : null;
}

/** Ramura de fază: `faza-N`, iar redesignul își păstrează numele (`redesign-final`). */
export function branchOf(phase: string): string {
  return phase.startsWith("redesign-") ? phase : `faza-${phase}`;
}

export function tagsOf(phase: string): { pre: string; done: string } {
  return { pre: `pre-faza-${phase}`, done: `faza-${phase}-completa` };
}
