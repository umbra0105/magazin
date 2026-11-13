/**
 * Poarta de îmbinare în `main` (docs/20 §5). Verifică, în ordine, șapte condiții și se oprește la PRIMA neîndeplinită; abia după
 * ce le trec pe toate pune eticheta `pre-faza-N`, îmbină prin commit și pune eticheta `faza-N-completa`. NU are niciun mod de a
 * ocoli o condiție: linia de comandă nu acceptă niciun flag de forțare, comanda de îmbinare e construită într-un singur loc, fără
 * `--squash`, `--delete-branch`, `--admin` sau `--auto`, iar `gh` și `git` sunt apelate printr-un port, ca testele să-l simuleze.
 *
 *   0. pregătirea: fază cunoscută, fără `STOP.txt`, pe ramura fazei;
 *   1. arbore curat și fără fișiere de lucru în diferență;
 *   2. ramura e actualizată față de `main`;
 *   3. verificarea completă locală pe codul final (înregistrarea lui `verify:full`);
 *   4. `gh pr checks` verde pe vârful ramurii;
 *   5. fără S1 sau S2 deschise în `docs/FINISAJE.md`;
 *   6. fazele B și C: «aprobat» în `docs/AUTONOM-APROBARI.md`;
 *   7. eticheta `pre-faza-N`, îmbinarea prin commit, eticheta `faza-N-completa`.
 */
import { isApproved } from "./aprobari";
import { blockingEntries, parseFinisaje } from "./finisaje";
import { branchOf, isValidPhaseId, modeOf, tagsOf } from "./phases";
import { validateVerification } from "./verification";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GatePorts {
  git(args: string[]): Promise<RunResult>;
  gh(args: string[]): Promise<RunResult>;
  /** Citește un fișier din depozit (cale relativă la rădăcină); `null` dacă nu există. */
  readText(relPath: string): Promise<string | null>;
  /** Înregistrarea lui `verify:full` (JSON), sau `null` dacă nu există. */
  readVerification(): Promise<unknown>;
  log(line: string): void;
}

export interface GateOptions {
  phase: string;
  dryRun: boolean;
}

export interface GateFailure {
  id: number;
  name: string;
  reason: string;
  hint: string;
}

export type GateResult =
  { ok: true; dryRun: boolean; mergeCommit: string | null } | { ok: false; failed: GateFailure };

export const STOP_FILE = "STOP.txt";
export const FINISAJE_FILE = "docs/FINISAJE.md";
export const APROBARI_FILE = "docs/AUTONOM-APROBARI.md";

/** Fișiere de lucru care nu au ce căuta în diferența fazei (date locale, secrete, rezultate de test, copii ale bazei, jurnale). */
const STRAY: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /^local-data\//, label: "local-data/" },
  { pattern: /(^|\/)\.env($|\.)/, label: "fișier .env" },
  { pattern: /^STOP\.txt$/, label: "STOP.txt" },
  {
    pattern: /^docs\/AUTONOM-APROBARI\.md$/,
    label: "docs/AUTONOM-APROBARI.md: îl scrie numai utilizatorul, nu ramura fazei",
  },
  { pattern: /(^|\/)zz-[^/]*$/, label: "fișier temporar zz-*" },
  { pattern: /(^|\/)test-results\//, label: "test-results/" },
  { pattern: /(^|\/)playwright-report\//, label: "playwright-report/" },
  { pattern: /(^|\/)\.next(-[^/]*)?\//, label: "director de build .next" },
  { pattern: /(^|\/)node_modules\//, label: "node_modules/" },
  { pattern: /\.log$/, label: "jurnal .log" },
  { pattern: /\.bak$/, label: "copie .bak" },
  { pattern: /\.dump$/, label: "copie .dump" },
];

/** Un fișier `.sql` e normal doar în pachetul bazei de date (migrări, seed); în altă parte e probabil o copie a unei baze. */
function strayLabel(path: string): string | null {
  for (const { pattern, label } of STRAY) if (pattern.test(path)) return label;
  if (/\.sql$/.test(path) && !path.startsWith("packages/db/"))
    return "fișier .sql în afara packages/db";
  return null;
}

function failure(id: number, name: string, reason: string, hint: string): GateResult {
  return { ok: false, failed: { id, name, reason, hint } };
}

/** Eticheta de pe linia `<sha>\trefs/tags/<nume>`; pentru etichete adnotate se preferă linia `^{}` (commit-ul țintă). */
function remoteTag(lsRemote: string, tag: string): string | null {
  let plain: string | null = null;
  let peeled: string | null = null;
  for (const line of lsRemote.split(/\r?\n/)) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref) continue;
    if (ref === `refs/tags/${tag}^{}`) peeled = sha;
    else if (ref === `refs/tags/${tag}`) plain = sha;
  }
  return peeled ?? plain;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Comanda de îmbinare: UN SINGUR loc. Doar îmbinare prin commit, legată de vârful verificat; niciun alt flag. */
export function mergeArgs(prNumber: number, headSha: string): string[] {
  return ["pr", "merge", String(prNumber), "--merge", "--match-head-commit", headSha];
}

export async function runGate(options: GateOptions, ports: GatePorts): Promise<GateResult> {
  const { phase, dryRun } = options;
  const pass = (line: string): void => ports.log(`  ✓ ${line}`);

  // 0. pregătirea
  // doar o fază din tabel ajunge în nume de ramură, de etichete și în comenzile git/gh (toate au identificatori valizi)
  const mode = modeOf(phase);
  if (!mode) {
    return failure(
      0,
      "pregătire",
      `faza ${JSON.stringify(phase)} nu e în tabelul din docs/20 §3`,
      "poarta nu îmbină o fază necunoscută; folosește --faza <id> din tabel",
    );
  }
  if ((await ports.readText(STOP_FILE)) !== null) {
    return failure(
      0,
      "frâna de mână",
      "există STOP.txt în rădăcina proiectului",
      "șterge STOP.txt când vrei să continui",
    );
  }
  const branch = branchOf(phase);
  const current = await ports.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current.code !== 0 || current.stdout.trim() !== branch) {
    return failure(
      0,
      "pregătire",
      `ești pe «${current.stdout.trim()}», nu pe ramura fazei «${branch}»`,
      `git switch ${branch}`,
    );
  }
  pass(`faza ${phase} (modul ${mode}), ramura ${branch}, fără STOP.txt`);

  // 1. arbore curat (partea 1)
  const status = await ports.git(["status", "--porcelain"]);
  if (status.code !== 0)
    return failure(1, "arbore curat", "`git status` a eșuat", status.stderr.trim());
  if (status.stdout.trim() !== "") {
    return failure(
      1,
      "arbore curat",
      "există modificări necomise sau fișiere nesuivite",
      "comite sau șterge-le; poarta cere un arbore curat",
    );
  }

  // main la zi (pregătește condițiile 1 și 2)
  const fetched = await ports.git(["fetch", "origin", "main"]);
  if (fetched.code !== 0) {
    return failure(
      2,
      "ramura la zi față de main",
      "`git fetch origin main` a eșuat",
      fetched.stderr.trim() || "verifică rețeaua și contul GitHub",
    );
  }

  // 1. fără fișiere din afara scopului (partea 2)
  const diff = await ports.git(["diff", "--name-only", "origin/main...HEAD"]);
  if (diff.code !== 0)
    return failure(1, "fișiere din afara scopului", "`git diff` a eșuat", diff.stderr.trim());
  const strays = diff.stdout
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter((path) => path !== "")
    .map((path) => ({ path, label: strayLabel(path) }))
    .filter((item) => item.label !== null);
  if (strays.length > 0) {
    const list = strays.map((item) => `${item.path} (${item.label})`).join(", ");
    return failure(
      1,
      "fișiere din afara scopului",
      `în diferența față de main: ${list}`,
      "scoate-le din istoric (git rm, apoi un commit) sau pune-le în .gitignore",
    );
  }
  pass("arbore curat, fără fișiere de lucru în diferență");

  // 2. ramura e actualizată față de main
  const ancestor = await ports.git(["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
  if (ancestor.code !== 0) {
    return failure(
      2,
      "ramura la zi față de main",
      "main are commit-uri pe care ramura nu le are",
      "git merge origin/main, apoi rulează din nou verify:full și trimite ramura",
    );
  }
  pass("ramura conține vârful lui main");

  // 3. verificarea completă locală, pe codul final
  const head = (await ports.git(["rev-parse", "HEAD"])).stdout.trim();
  const tree = (await ports.git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
  const record = await ports.readVerification();
  if (record === null || record === undefined) {
    return failure(
      3,
      "verificarea completă locală",
      "nu există nicio înregistrare a verificării",
      "rulează npm.cmd run verify:full",
    );
  }
  const verdict = validateVerification(record, { treeHash: tree });
  if (!verdict.ok) {
    return failure(
      3,
      "verificarea completă locală",
      verdict.reason,
      "rulează npm.cmd run verify:full pe codul final",
    );
  }
  pass("verificarea completă locală e făcută pe codul final, fără picate, sărite sau intermitente");

  // 4. CI-ul de pe GitHub, pe vârful ramurii
  const listed = await ports.gh([
    "pr",
    "list",
    "--head",
    branch,
    "--base",
    "main",
    "--state",
    "open",
    "--json",
    "number,headRefOid,isDraft",
  ]);
  const prs = parseJson(listed.stdout);
  if (listed.code !== 0 || !Array.isArray(prs)) {
    return failure(
      4,
      "CI verde",
      "nu pot citi cererile de îmbinare din GitHub",
      listed.stderr.trim() || "verifică gh auth status",
    );
  }
  if (prs.length !== 1) {
    return failure(
      4,
      "CI verde",
      `ramura are ${prs.length} cereri de îmbinare deschise spre main (trebuie exact una)`,
      `gh pr create --base main --head ${branch}`,
    );
  }
  const pr = prs[0] as { number?: unknown; headRefOid?: unknown; isDraft?: unknown };
  if (typeof pr.number !== "number" || typeof pr.headRefOid !== "string") {
    return failure(
      4,
      "CI verde",
      "răspunsul GitHub pentru cererea de îmbinare nu poate fi citit",
      "",
    );
  }
  if (pr.isDraft === true) {
    return failure(4, "CI verde", "cererea de îmbinare e ciornă (draft)", "gh pr ready");
  }
  if (pr.headRefOid !== head) {
    return failure(
      4,
      "CI verde",
      "vârful cererii din GitHub diferă de codul local (ramura nu e trimisă sau e în urmă)",
      `git push origin ${branch}`,
    );
  }
  const checked = await ports.gh([
    "pr",
    "checks",
    String(pr.number),
    "--json",
    "bucket,name,state,workflow",
  ]);
  const checks = parseJson(checked.stdout);
  if (!Array.isArray(checks) || checks.length === 0) {
    return failure(
      4,
      "CI verde",
      "GitHub nu raportează nicio verificare pentru cerere",
      "așteaptă pornirea CI-ului; fără verificări nu e «verde»",
    );
  }
  const notGreen = checks.filter((item) => (item as { bucket?: unknown }).bucket !== "pass");
  if (notGreen.length > 0) {
    const names = notGreen
      .map(
        (item) =>
          `${String((item as { name?: unknown }).name)}: ${String((item as { bucket?: unknown }).bucket)}`,
      )
      .join(", ");
    return failure(
      4,
      "CI verde",
      `verificări care nu sunt «pass»: ${names}`,
      "repară și trimite din nou ramura",
    );
  }
  pass(`CI verde (${checks.length} verificări) pe vârful ramurii, cererea #${pr.number}`);

  // 5. fără S1 sau S2 deschise
  const finisaje = await ports.readText(FINISAJE_FILE);
  if (finisaje === null) {
    return failure(
      5,
      "fără S1/S2 deschise",
      `lipsește ${FINISAJE_FILE}`,
      "creează fișierul din șablon",
    );
  }
  const blocking = blockingEntries(parseFinisaje(finisaje));
  if (blocking.length > 0) {
    const list = blocking.map((entry) => `linia ${entry.line} (${entry.severity})`).join(", ");
    return failure(
      5,
      "fără S1/S2 deschise",
      `intrări deschise în ${FINISAJE_FILE}: ${list}`,
      "rezolvă-le sau, dacă sunt doar finisaje, reclasifică-le S3",
    );
  }
  pass("nicio intrare S1 sau S2 deschisă în docs/FINISAJE.md");

  // 6. aprobarea utilizatorului (B și C)
  if (mode !== "A") {
    const approvals = await ports.readText(APROBARI_FILE);
    if (approvals === null || !isApproved(approvals, phase)) {
      return failure(
        6,
        "aprobarea utilizatorului",
        `în ${APROBARI_FILE} nu scrie «- Faza ${phase}: aprobat»`,
        "utilizatorul scrie aprobarea după verificarea manuală a fazei",
      );
    }
    pass(`aprobat de utilizator (modul ${mode})`);
  } else {
    pass("modul A: nu cere aprobare");
  }

  // 7. etichete și îmbinare
  const tags = tagsOf(phase);
  const mainSha = (await ports.git(["rev-parse", "origin/main"])).stdout.trim();
  const remote = await ports.git([
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tags.pre}`,
    `refs/tags/${tags.done}`,
  ]);
  if (remote.code !== 0) {
    return failure(
      7,
      "etichete și îmbinare",
      "nu pot citi etichetele din GitHub",
      remote.stderr.trim(),
    );
  }
  if (remoteTag(remote.stdout, tags.done) !== null) {
    return failure(
      7,
      "etichete și îmbinare",
      `eticheta ${tags.done} există deja (faza a fost îmbinată)`,
      "alege alt identificator sau verifică istoricul",
    );
  }
  const existingPre = remoteTag(remote.stdout, tags.pre);
  if (existingPre !== null && existingPre !== mainSha) {
    return failure(
      7,
      "etichete și îmbinare",
      `eticheta ${tags.pre} există deja pe alt commit decât vârful actual al lui main`,
      "nu se mută etichete; verifică istoricul",
    );
  }
  if (dryRun) {
    ports.log("  (--dry-run) condițiile 0-6 sunt îndeplinite; nu pun etichete și nu îmbin");
    return { ok: true, dryRun: true, mergeCommit: null };
  }
  if (existingPre === null) {
    const tagged = await ports.git([
      "tag",
      "-a",
      tags.pre,
      "-m",
      `Înaintea fazei ${phase}`,
      mainSha,
    ]);
    if (tagged.code !== 0)
      return failure(
        7,
        "etichete și îmbinare",
        `nu pot crea eticheta ${tags.pre}`,
        tagged.stderr.trim(),
      );
    const pushed = await ports.git(["push", "origin", `refs/tags/${tags.pre}`]);
    if (pushed.code !== 0)
      return failure(
        7,
        "etichete și îmbinare",
        `nu pot trimite eticheta ${tags.pre}`,
        pushed.stderr.trim(),
      );
  }
  pass(`eticheta ${tags.pre} pe vârful actual al lui main`);

  const merged = await ports.gh(mergeArgs(pr.number, head));
  if (merged.code !== 0) {
    return failure(
      7,
      "etichete și îmbinare",
      "îmbinarea a fost refuzată de GitHub",
      merged.stderr.trim() || merged.stdout.trim(),
    );
  }
  await ports.git(["fetch", "origin", "main"]);
  const mergeSha = (await ports.git(["rev-parse", "origin/main"])).stdout.trim();
  const parents = (await ports.git(["rev-list", "--parents", "-n", "1", "origin/main"])).stdout
    .trim()
    .split(/\s+/);
  if (mergeSha === mainSha) {
    return failure(
      7,
      "etichete și îmbinare",
      "main nu a avansat după îmbinare",
      "verifică în GitHub dacă îmbinarea a avut loc",
    );
  }
  if (parents.length !== 3 || parents[0] !== mergeSha) {
    return failure(
      7,
      "etichete și îmbinare",
      "vârful lui main după îmbinare nu e un commit de îmbinare (cu doi părinți)",
      "verifică în GitHub: îmbinarea nu trebuie să fie squash sau rebase",
    );
  }
  pass(`îmbinat prin commit: ${mergeSha}`);

  const doneTag = await ports.git([
    "tag",
    "-a",
    tags.done,
    "-m",
    `Faza ${phase} completă`,
    mergeSha,
  ]);
  if (doneTag.code !== 0) {
    return failure(
      7,
      "etichete și îmbinare",
      `îmbinat (${mergeSha}), dar nu pot crea eticheta ${tags.done}`,
      doneTag.stderr.trim(),
    );
  }
  const donePush = await ports.git(["push", "origin", `refs/tags/${tags.done}`]);
  if (donePush.code !== 0) {
    return failure(
      7,
      "etichete și îmbinare",
      `îmbinat (${mergeSha}), dar nu pot trimite eticheta ${tags.done}`,
      donePush.stderr.trim(),
    );
  }
  pass(`eticheta ${tags.done} pusă și trimisă`);
  return { ok: true, dryRun: false, mergeCommit: mergeSha };
}

/**
 * Linia de comandă: DOAR `--faza <id>` (sau `--faza=<id>`) și `--dry-run`. Orice altceva (inclusiv `--force`, `--skip-ci`, `--admin`,
 * `--squash`) e respins: nu există flag care să ocolească o condiție.
 */
export function parseGateArgs(
  argv: readonly string[],
): { ok: true; options: GateOptions } | { ok: false; error: string } {
  let phase: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--faza" || arg.startsWith("--faza=")) {
      if (phase !== null) return { ok: false, error: "--faza apare de două ori" };
      phase = arg === "--faza" ? (argv[(i += 1)] ?? "") : arg.slice("--faza=".length);
    } else {
      return {
        ok: false,
        error: `argument nepermis: ${arg} (poarta acceptă doar --faza <id> și --dry-run)`,
      };
    }
  }
  if (phase === null) return { ok: false, error: "lipsește --faza <id>" };
  if (!isValidPhaseId(phase))
    return { ok: false, error: `identificator de fază nevalid: ${JSON.stringify(phase)}` };
  return { ok: true, options: { phase, dryRun } };
}
