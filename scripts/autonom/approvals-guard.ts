/**
 * `docs/AUTONOM-APROBARI.md` îl scrie numai utilizatorul (docs/20 §5, condiția 6): Claude Code nu-l scrie și nu-l modifică niciodată.
 * Garda pură: pe o ramură de fază (`faza-N` sau `redesign-…`), niciun commit al ramurii față de `main` nu are voie să atingă fișierul
 * (nici dacă modificarea a fost anulată mai târziu). Pe `main` și pe orice altă ramură nu verifică nimic: aprobarea intră în `main`
 * prin commit-ul utilizatorului, iar ramura fazei o preia odată cu `main`. Local, fără baza `origin/main` garda pică (nu poate dovedi
 * că fișierul e neatins); în CI, unde checkout-ul e superficial, nu se poate compara și nu pică din această cauză.
 */
export const APPROVALS_FILE = "docs/AUTONOM-APROBARI.md";

export interface GuardInput {
  /** Ramura curentă (în CI, ramura cererii de îmbinare), sau `null` dacă nu se știe. */
  branch: string | null;
  /** `origin/main` există în depozit (se poate calcula ce a adăugat ramura). */
  baseAvailable: boolean;
  /** Rulează în CI (checkout superficial). */
  ci: boolean;
  /** Commit-urile ramurii (fără îmbinări), față de `origin/main`, care ating fișierul de aprobări. */
  touchingCommits: readonly string[];
}

const PHASE_BRANCH = /^(faza-[a-z0-9][a-z0-9.-]*|redesign-[a-z0-9][a-z0-9.-]*)$/;

export function isPhaseBranch(name: string): boolean {
  return PHASE_BRANCH.test(name);
}

export function approvalsGuardProblems(input: GuardInput): string[] {
  const { branch, baseAvailable, ci, touchingCommits } = input;
  if (branch === null || !isPhaseBranch(branch)) return [];
  if (!baseAvailable) {
    return ci
      ? []
      : [
          `ramura ${branch}: lipsește origin/main, deci nu pot dovedi că ${APPROVALS_FILE} e neatins (git fetch origin main)`,
        ];
  }
  if (touchingCommits.length > 0) {
    return [
      `ramura ${branch}: commit-urile ${touchingCommits.join(", ")} modifică ${APPROVALS_FILE}; îl scrie numai utilizatorul, iar aprobarea intră în main prin commit-ul lui`,
    ];
  }
  return [];
}
