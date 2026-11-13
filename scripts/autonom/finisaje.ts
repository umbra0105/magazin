/**
 * `docs/FINISAJE.md`: intrările de gravitate (docs/20 §2). O intrare e o linie `- [ ] S3 | ecran | problemă | captură`: căsuța spune
 * starea (`[x]` = rezolvată, orice altceva = deschisă), iar primul cuvânt după ea e severitatea. Liniile din blocuri de cod și
 * textul obișnuit nu sunt intrări. O intrare deschisă fără severitate recunoscută se socotește S2 («la îndoială, nivelul mai grav»).
 */
export type Severity = "S1" | "S2" | "S3";

export interface FinisajEntry {
  severity: Severity;
  open: boolean;
  line: number;
  text: string;
}

const ENTRY = /^\s*[-*]\s*\[([^\]])\]\s*(.*)$/;
const SEVERITY = /^(S[123])\b/;
const FENCE = /^\s*```/;

export function parseFinisaje(markdown: string): FinisajEntry[] {
  const entries: FinisajEntry[] = [];
  let inFence = false;
  markdown.split(/\r?\n/).forEach((raw, index) => {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = ENTRY.exec(raw);
    if (!match) return;
    const mark = match[1] ?? " ";
    const text = (match[2] ?? "").trim();
    const found = SEVERITY.exec(text);
    entries.push({
      severity: (found?.[1] as Severity | undefined) ?? "S2",
      open: mark !== "x" && mark !== "X",
      line: index + 1,
      text,
    });
  });
  return entries;
}

/** Intrările care opresc îmbinarea: S1 și S2 deschise. */
export function blockingEntries(entries: readonly FinisajEntry[]): FinisajEntry[] {
  return entries.filter(
    (entry) => entry.open && (entry.severity === "S1" || entry.severity === "S2"),
  );
}
