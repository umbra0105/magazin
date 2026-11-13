/**
 * `docs/AUTONOM-APROBARI.md`: aprobările utilizatorului pentru fazele B și C (docs/20 §5, condiția 6). O linie `- Faza N: aprobat …`
 * aprobă faza N; orice alt cuvânt după două puncte (în așteptare, neaprobat, retras) nu e aprobare, iar ULTIMA mențiune a fazei
 * decide. Liniile din blocuri de cod nu contează. Poarta nu poate dovedi cine a scris linia: aprobarea o scrie utilizatorul.
 */
const LINE = /^\s*[-*]\s*Faza\s+(\S+?)\s*:\s*(\S+)/i;
const FENCE = /^\s*```/;

export function isApproved(markdown: string, phase: string): boolean {
  let status: string | null = null;
  let inFence = false;
  for (const raw of markdown.split(/\r?\n/)) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = LINE.exec(raw);
    if (match && (match[1] ?? "").toLowerCase() === phase.toLowerCase()) {
      status = (match[2] ?? "").replace(/[,.;:—–-]+$/, "").toLowerCase();
    }
  }
  return status === "aprobat";
}
