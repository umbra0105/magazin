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
 *   4. exact o cerere de îmbinare deschisă (ciornă sau nu), cu vârful = codul local și `gh pr checks` verde;
 *   5. fără S1 sau S2 deschise în `docs/FINISAJE.md`;
 *   6. fazele B și C: «aprobat» în `docs/AUTONOM-APROBARI.md`;
 *   7. eticheta `pre-faza-N`, apoi (doar dacă cererea e ciornă) `gh pr ready`, apoi îmbinarea prin commit, apoi eticheta
 *      `faza-N-completa`. Cererea de fază stă ciornă (draft) până la poartă: un draft nu se poate îmbina din butonul GitHub, deci
 *      poarta e singura cale. Dacă îmbinarea e refuzată după ce poarta a marcat cererea ready, o readuce în draft (`--undo`).
 *
 * Modul separat `--doar-etichete` (`runTagsOnly`) pune doar etichetele unei faze îmbinate din GitHub, direct de pe un commit de
 * îmbinare verificat; nu îmbină, nu marchează ready și nu verifică CI, aprobarea sau `verify:full`.
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
  /** `--doar-etichete`: nu îmbină nimic, doar pune etichetele unei faze deja îmbinate din GitHub. Prezent doar când e cerut. */
  tagsOnly?: boolean;
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

/** Marcarea cererii ca «ready for review» (iese din draft): UN SINGUR loc, fără alte flag-uri. */
export function readyArgs(prNumber: number): string[] {
  return ["pr", "ready", String(prNumber)];
}

/** Readucerea în draft a unei cereri pe care poarta a marcat-o ready, dacă îmbinarea e refuzată: UN SINGUR loc. */
export function undoReadyArgs(prNumber: number): string[] {
  return ["pr", "ready", String(prNumber), "--undo"];
}

/** Modelele pentru `git ls-remote`: obiectul etichetei și, la cele adnotate, linia `^{}` cu commit-ul țintă. */
function tagPatterns(names: readonly string[]): string[] {
  return names.flatMap((name) => [`refs/tags/${name}`, `refs/tags/${name}^{}`]);
}

const FULL_SHA = /^[0-9a-f]{40}$/;

export async function runGate(options: GateOptions, ports: GatePorts): Promise<GateResult> {
  if (options.tagsOnly === true) return runTagsOnly(options, ports);
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
  if (prs.length === 0) {
    // nicio cerere DESCHISĂ: se caută în istoric, ca mesajul să spună adevărul (deja îmbinată sau închisă), nu «0 cereri deschise»
    const history = await ports.gh([
      "pr",
      "list",
      "--head",
      branch,
      "--base",
      "main",
      "--state",
      "all",
      "--json",
      "number,state,mergeCommit",
    ]);
    const rows = parseJson(history.stdout);
    if (history.code === 0 && Array.isArray(rows)) {
      const asRow = (item: unknown) =>
        item as { number?: unknown; state?: unknown; mergeCommit?: { oid?: unknown } | null };
      const mergedRow = rows.map(asRow).find((row) => row.state === "MERGED");
      if (mergedRow !== undefined) {
        const oid =
          typeof mergedRow.mergeCommit?.oid === "string" ? mergedRow.mergeCommit.oid : "necunoscut";
        return failure(
          4,
          "cerere de îmbinare",
          `PR #${String(mergedRow.number)} e deja îmbinat (commit ${oid}); poarta nu îmbină a doua oară`,
          `dacă a fost îmbinat din GitHub, etichetele se pun cu: npm.cmd run gate:merge -- --faza ${phase} --doar-etichete`,
        );
      }
      const closedRow = rows.map(asRow).find((row) => row.state === "CLOSED");
      if (closedRow !== undefined) {
        return failure(
          4,
          "cerere de îmbinare",
          `PR #${String(closedRow.number)} e închis fără îmbinare; poarta nu îmbină a doua oară`,
          `deschide o cerere nouă, în draft: gh pr create --draft --base main --head ${branch}`,
        );
      }
    }
    return failure(
      4,
      "CI verde",
      "ramura are 0 cereri de îmbinare deschise spre main (trebuie exact una)",
      `gh pr create --draft --base main --head ${branch}`,
    );
  }
  if (prs.length !== 1) {
    return failure(
      4,
      "CI verde",
      `ramura are ${prs.length} cereri de îmbinare deschise spre main (trebuie exact una)`,
      "închide cererile în plus; poarta cere exact una",
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
  // o cerere draft e normală: poarta o marchează ready chiar înainte de îmbinare (pasul 7); restul condițiilor rămân neschimbate
  const wasDraft = pr.isDraft === true;
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
  if (wasDraft) ports.log("  • PR-ul e draft; poarta îl va marca ready înainte de îmbinare");

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
  // și liniile `^{}`: etichetele puse de poartă sunt adnotate, iar `ls-remote` arată altfel doar obiectul etichetei, nu commit-ul țintă
  const remote = await ports.git([
    "ls-remote",
    "--tags",
    "origin",
    ...tagPatterns([tags.pre, tags.done]),
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

  // cererea de fază stă draft până aici; ready se pune ULTIMUL, imediat înaintea îmbinării. O cerere care era deja ready nu se atinge.
  let markedReady = false;
  if (wasDraft) {
    const ready = await ports.gh(readyArgs(pr.number));
    if (ready.code !== 0) {
      return failure(
        7,
        "etichete și îmbinare",
        `nu pot marca cererea #${pr.number} ca ready (gh pr ready a eșuat); nu am îmbinat nimic și cererea a rămas draft`,
        ready.stderr.trim() || ready.stdout.trim(),
      );
    }
    markedReady = true;
    pass(`cererea #${pr.number} marcată ready (era draft)`);
  }

  const merged = await ports.gh(mergeArgs(pr.number, head));
  if (merged.code !== 0) {
    let note = "";
    if (markedReady) {
      const undo = await ports.gh(undoReadyArgs(pr.number));
      note =
        undo.code === 0
          ? `; cererea #${pr.number} a fost readusă în draft`
          : `; ATENȚIE: nu am putut readuce cererea #${pr.number} în draft, e încă ready și se poate îmbina din butonul GitHub: gh pr ready ${pr.number} --undo`;
    }
    return failure(
      7,
      "etichete și îmbinare",
      `îmbinarea a fost refuzată de GitHub${note}`,
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
 * `--doar-etichete`: etichetele unei faze îmbinate DIRECT din GitHub (în afara porții). Nu îmbină, nu marchează ready și nu verifică
 * CI, aprobarea sau `verify:full`: nu îmbină nimic, iar etichetele nu sunt o aprobare. Verifică doar că:
 *  - există exact o cerere îmbinată spre `main` de pe ramura fazei, al cărei commit de îmbinare e strămoș al lui `origin/main`;
 *  - acel commit are EXACT doi părinți (îmbinare prin commit, nu squash sau rebase);
 *  - `pre-faza-N` arată (sau va arăta) spre primul părinte, iar `faza-N-completa` spre commit-ul de îmbinare.
 * O etichetă care lipsește se creează adnotată (aceleași mesaje ca la poartă) și se trimite singură (`refs/tags/<nume>`); una aflată
 * deja pe commit-ul corect nu se atinge (idempotent); una aflată pe ALT commit oprește totul, fără nicio modificare: o etichetă nu
 * se mută niciodată.
 */
async function runTagsOnly(options: GateOptions, ports: GatePorts): Promise<GateResult> {
  const { phase, dryRun } = options;
  if (modeOf(phase) === null) {
    return failure(
      0,
      "pregătire",
      `faza ${JSON.stringify(phase)} nu e în tabelul din docs/20 §3`,
      "folosește --faza <id> din tabel",
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
  const tags = tagsOf(phase);
  ports.log(
    "  (--doar-etichete) nu îmbină nimic și nu verifică CI, aprobarea sau verify:full; etichetele nu sunt o aprobare",
  );

  const fetched = await ports.git(["fetch", "origin", "main"]);
  if (fetched.code !== 0) {
    return failure(
      0,
      "main la zi",
      "`git fetch origin main` a eșuat",
      fetched.stderr.trim() || "verifică rețeaua și contul GitHub",
    );
  }

  // exact o cerere ÎMBINATĂ spre main de pe ramura fazei
  const listed = await ports.gh([
    "pr",
    "list",
    "--head",
    branch,
    "--base",
    "main",
    "--state",
    "all",
    "--json",
    "number,state,mergeCommit",
  ]);
  const rows = parseJson(listed.stdout);
  if (listed.code !== 0 || !Array.isArray(rows)) {
    return failure(
      7,
      "cerere îmbinată",
      "nu pot citi cererile de îmbinare din GitHub",
      listed.stderr.trim() || "verifică gh auth status",
    );
  }
  type Row = { number?: unknown; state?: unknown; mergeCommit?: { oid?: unknown } | null };
  const all = rows as Row[];
  const mergedRows = all.filter((row) => row.state === "MERGED");
  if (mergedRows.length === 0) {
    const others = all.map((row) => `#${String(row.number)} (${String(row.state)})`).join(", ");
    return failure(
      7,
      "cerere îmbinată",
      all.length === 0
        ? `nu există nicio cerere de îmbinare de pe ${branch} spre main`
        : `nicio cerere de pe ${branch} nu e îmbinată: ${others}`,
      "etichetele se pun doar pentru o fază îmbinată; ruta obișnuită e poarta (gate:merge --faza <id>)",
    );
  }
  if (mergedRows.length > 1) {
    return failure(
      7,
      "cerere îmbinată",
      `${mergedRows.length} cereri îmbinate de pe ${branch}: nu știu pe care să o iau`,
      "verifică istoricul în GitHub",
    );
  }
  const merged = mergedRows[0] as Row;
  const oid = typeof merged.mergeCommit?.oid === "string" ? merged.mergeCommit.oid : "";
  if (!FULL_SHA.test(oid)) {
    return failure(
      7,
      "commit de îmbinare",
      `GitHub nu dă un commit de îmbinare valid pentru PR #${String(merged.number)}`,
      "verifică cererea în GitHub",
    );
  }

  // commit-ul de îmbinare: strămoș al lui origin/main, cu exact doi părinți
  const ancestor = await ports.git(["merge-base", "--is-ancestor", oid, "origin/main"]);
  if (ancestor.code !== 0) {
    return failure(
      7,
      "commit de îmbinare",
      `commitul ${oid} nu e strămoș al lui origin/main`,
      "verifică în GitHub dacă îmbinarea a ajuns în main",
    );
  }
  const parentsOut = await ports.git(["rev-list", "--parents", "-n", "1", oid]);
  const tokens = parentsOut.stdout.trim().split(/\s+/);
  if (
    parentsOut.code !== 0 ||
    tokens.length !== 3 ||
    tokens[0] !== oid ||
    !FULL_SHA.test(tokens[1] ?? "") ||
    !FULL_SHA.test(tokens[2] ?? "")
  ) {
    return failure(
      7,
      "commit de îmbinare",
      `commitul ${oid} nu are exact doi părinți (nu e o îmbinare prin commit: squash, rebase sau alt fel)`,
      "poarta cere îmbinare prin commit; verifică în GitHub cum a fost îmbinat",
    );
  }
  const firstParent = tokens[1] as string;

  // etichetele: cele existente trebuie să fie pe commit-urile corecte
  const remote = await ports.git([
    "ls-remote",
    "--tags",
    "origin",
    ...tagPatterns([tags.pre, tags.done]),
  ]);
  if (remote.code !== 0) {
    return failure(7, "etichete", "nu pot citi etichetele din GitHub", remote.stderr.trim());
  }
  const expected = [
    { name: tags.pre, sha: firstParent, message: `Înaintea fazei ${phase}` },
    { name: tags.done, sha: oid, message: `Faza ${phase} completă` },
  ];
  const moved = expected
    .map((tag) => ({ ...tag, actual: remoteTag(remote.stdout, tag.name) }))
    .filter((tag) => tag.actual !== null && tag.actual !== tag.sha);
  if (moved.length > 0) {
    const list = moved
      .map((tag) => `${tag.name} e pe ${String(tag.actual)}, nu pe ${tag.sha}`)
      .join("; ");
    return failure(
      7,
      "etichete",
      `etichetă existentă pe alt commit: ${list}`,
      "nu se mută etichete; nu am modificat nimic; verifică istoricul",
    );
  }
  const missing = expected.filter((tag) => remoteTag(remote.stdout, tag.name) === null);
  for (const tag of expected) {
    if (!missing.includes(tag)) ports.log(`  ✓ eticheta ${tag.name} e deja pe ${tag.sha}`);
  }
  if (dryRun) {
    for (const tag of missing) {
      ports.log(`  (--dry-run) ar crea eticheta ${tag.name} pe ${tag.sha}`);
    }
    if (missing.length === 0) ports.log("  (--dry-run) nimic de făcut: etichetele există");
    return { ok: true, dryRun: true, mergeCommit: oid };
  }
  for (const tag of missing) {
    const tagged = await ports.git(["tag", "-a", tag.name, "-m", tag.message, tag.sha]);
    if (tagged.code !== 0) {
      return failure(7, "etichete", `nu pot crea eticheta ${tag.name}`, tagged.stderr.trim());
    }
    const pushed = await ports.git(["push", "origin", `refs/tags/${tag.name}`]);
    if (pushed.code !== 0) {
      return failure(7, "etichete", `nu pot trimite eticheta ${tag.name}`, pushed.stderr.trim());
    }
    ports.log(`  ✓ eticheta ${tag.name} pusă pe ${tag.sha} și trimisă`);
  }
  return { ok: true, dryRun: false, mergeCommit: oid };
}

/**
 * Linia de comandă: DOAR `--faza <id>` (sau `--faza=<id>`), `--dry-run` și `--doar-etichete`. Orice altceva (inclusiv `--force`,
 * `--skip-ci`, `--admin`, `--squash`, `--ready`) e respins: nu există flag care să ocolească o condiție.
 */
export function parseGateArgs(
  argv: readonly string[],
): { ok: true; options: GateOptions } | { ok: false; error: string } {
  let phase: string | null = null;
  let dryRun = false;
  let tagsOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--doar-etichete") {
      if (tagsOnly) return { ok: false, error: "--doar-etichete apare de două ori" };
      tagsOnly = true;
    } else if (arg === "--faza" || arg.startsWith("--faza=")) {
      if (phase !== null) return { ok: false, error: "--faza apare de două ori" };
      phase = arg === "--faza" ? (argv[(i += 1)] ?? "") : arg.slice("--faza=".length);
    } else {
      return {
        ok: false,
        error: `argument nepermis: ${arg} (poarta acceptă doar --faza <id>, --dry-run și --doar-etichete)`,
      };
    }
  }
  if (phase === null) return { ok: false, error: "lipsește --faza <id>" };
  if (!isValidPhaseId(phase))
    return { ok: false, error: `identificator de fază nevalid: ${JSON.stringify(phase)}` };
  return { ok: true, options: tagsOnly ? { phase, dryRun, tagsOnly: true } : { phase, dryRun } };
}
