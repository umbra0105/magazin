import { describe, expect, it } from "vitest";
import {
  runGate,
  parseGateArgs,
  readyArgs,
  undoReadyArgs,
  mergeArgs,
  type GatePorts,
  type GateResult,
  type RunResult,
} from "../../scripts/autonom/gate";
import { STEP_NAMES } from "../../scripts/autonom/verification";

/**
 * Poarta de îmbinare (docs/20 §5), cu `git` și `gh` SIMULATE: un «univers» descrie starea depozitului, iar poarta îl citește prin
 * aceleași comenzi pe care le-ar da pe un depozit real. Fiecare condiție are teste de felul «pică exact aici și nu atinge nimic din
 * ce urmează»: niciun apel `gh pr merge`, nicio etichetă publicată. Mutanții din `scripts` rulează aceste teste.
 */

interface World {
  branch: string;
  headSha: string;
  tree: string;
  porcelain: string;
  diffFiles: string[];
  mainSha: string;
  behind: boolean;
  fetchCode: number;
  remoteTags: Record<string, string>;
  verification: unknown;
  files: Record<string, string | null>;
  prs: { number: number; headRefOid: string; isDraft: boolean }[];
  /** `null` = «no checks reported»; altfel lista verificărilor. */
  checks: { bucket: string; name: string; state: string; workflow: string }[] | null;
  checksCode: number;
  mergeCode: number;
  mergeCommit: string;
  /** Câți părinți are vârful lui `main` după îmbinare (2 = commit de îmbinare). */
  parentsAfterMerge: number;
  /** main avansează din alt motiv (altcineva a îmbinat între timp), chiar dacă îmbinarea noastră e refuzată. */
  mainAdvancesAnyway: boolean;
  /** `gh pr list --state all`: toate cererile ramurii, cu starea din GitHub și commit-ul de îmbinare. */
  allPrs: { number: number; state: string; mergeCommit: { oid: string } | null }[];
  readyCode: number;
  undoCode: number;
  /** Etichetele de pe GitHub sunt adnotate (ca cele puse de poartă): `ls-remote` arată obiectul etichetei și, doar la cerere, linia `^{}`. */
  annotated: boolean;
  /** Commit-urile care sunt strămoși ai lui origin/main (pentru `--doar-etichete`). */
  ancestors: string[];
  /** Părinții fiecărui commit (pentru `--doar-etichete`). */
  parents: Record<string, string[]>;
}

const HEAD = "1".repeat(40);
const MAIN = "2".repeat(40);
const MERGE = "3".repeat(40);
const TREE = "4".repeat(40);

const FINISAJE_OK =
  "# Finisaje\n\n- [ ] S3 | Media | aliniere | captura.png\n- [x] S2 | Media | rezolvat | captura.png\n";
const APROBARI_B = "# Aprobări\n\n- Faza 9: aprobat, 2026-12-01\n";

function greenVerification(tree = TREE) {
  const counted = new Set(["unit", "integrationDev", "integrationMigratedOnly", "e2e"]);
  return {
    version: 1,
    headSha: HEAD,
    treeHash: tree,
    startedAt: "2026-11-13T10:00:00.000Z",
    finishedAt: "2026-11-13T10:30:00.000Z",
    steps: STEP_NAMES.map((name) => ({
      name,
      exitCode: 0,
      counts: counted.has(name) ? { passed: 10, failed: 0, skipped: 0, notRun: 0, flaky: 0 } : null,
      log: `${name}.log`,
    })),
  };
}

function world(over: Partial<World> = {}): World {
  return {
    branch: "redesign-final",
    headSha: HEAD,
    tree: TREE,
    porcelain: "",
    diffFiles: ["apps/web/src/a.tsx", "docs/PROGRESS.md"],
    mainSha: MAIN,
    behind: false,
    fetchCode: 0,
    remoteTags: {},
    verification: greenVerification(),
    files: {
      "STOP.txt": null,
      "docs/FINISAJE.md": FINISAJE_OK,
      "docs/AUTONOM-APROBARI.md": APROBARI_B,
    },
    prs: [{ number: 12, headRefOid: HEAD, isDraft: false }],
    checks: [
      { bucket: "pass", name: "build", state: "SUCCESS", workflow: "CI" },
      { bucket: "pass", name: "e2e", state: "SUCCESS", workflow: "CI" },
    ],
    checksCode: 0,
    mergeCode: 0,
    mergeCommit: MERGE,
    parentsAfterMerge: 2,
    mainAdvancesAnyway: false,
    allPrs: [],
    readyCode: 0,
    undoCode: 0,
    annotated: false,
    ancestors: [],
    parents: {},
    ...over,
  };
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (code: number, stderr = "eroare"): RunResult => ({ code, stdout: "", stderr });

function build(w: World) {
  const calls: string[] = [];
  const logs: string[] = [];
  let merged = false;
  /** Starea «draft» din GitHub, schimbată de `gh pr ready` și `--undo`; GitHub refuză îmbinarea unei cereri draft. */
  let draft = w.prs[0]?.isDraft === true;
  const ports: GatePorts = {
    async git(args) {
      const cmd = args.join(" ");
      calls.push(`git ${cmd}`);
      if (cmd === "rev-parse --abbrev-ref HEAD") return ok(`${w.branch}\n`);
      if (cmd === "rev-parse HEAD") return ok(`${w.headSha}\n`);
      if (cmd === "rev-parse HEAD^{tree}") return ok(`${w.tree}\n`);
      if (cmd === "status --porcelain") return ok(w.porcelain);
      if (cmd === "fetch origin main") return w.fetchCode === 0 ? ok() : fail(w.fetchCode);
      if (cmd === "diff --name-only origin/main...HEAD") return ok(w.diffFiles.join("\n"));
      if (cmd === "merge-base --is-ancestor origin/main HEAD") return w.behind ? fail(1, "") : ok();
      if (cmd.startsWith("ls-remote --tags origin")) {
        // ca `git ls-remote` real: o linie apare doar dacă un model o cere; linia `^{}` (commit-ul țintă al unei etichete adnotate) la fel
        const patterns = args.slice(3);
        const lines: string[] = [];
        for (const [tag, sha] of Object.entries(w.remoteTags)) {
          if (patterns.includes(`refs/tags/${tag}`)) {
            lines.push(`${w.annotated ? "a".repeat(40) : sha}\trefs/tags/${tag}`);
          }
          if (w.annotated && patterns.includes(`refs/tags/${tag}^{}`)) {
            lines.push(`${sha}\trefs/tags/${tag}^{}`);
          }
        }
        return ok(lines.join("\n"));
      }
      if (cmd.startsWith("merge-base --is-ancestor ") && cmd.endsWith(" origin/main")) {
        const sha = args[2] as string;
        return w.ancestors.includes(sha) ? ok() : fail(1, "");
      }
      if (cmd.startsWith("rev-list --parents -n 1 ") && args[4] !== "origin/main") {
        const sha = args[4] as string;
        const parents = w.parents[sha];
        return parents ? ok(`${sha} ${parents.join(" ")}\n`) : fail(128, "commit necunoscut");
      }
      if (cmd === "rev-parse origin/main") {
        return ok(`${merged ? w.mergeCommit : w.mainSha}\n`);
      }
      if (cmd === "rev-list --parents -n 1 origin/main") {
        const parents = Array.from({ length: w.parentsAfterMerge }, (_, i) =>
          `${i + 5}`.repeat(40),
        );
        // vârful lui main: înainte de îmbinare e vârful vechi (care poate fi și el un commit de îmbinare), după, cel nou
        return ok(`${merged ? w.mergeCommit : w.mainSha} ${parents.join(" ")}\n`);
      }
      if (cmd.startsWith("tag -a ")) return ok();
      if (cmd.startsWith("push origin refs/tags/")) return ok();
      throw new Error(`comandă git neprevăzută în simulare: ${cmd}`);
    },
    async gh(args) {
      const cmd = args.join(" ");
      calls.push(`gh ${cmd}`);
      if (args[0] === "pr" && args[1] === "list") {
        if (args.includes("all")) return ok(JSON.stringify(w.allPrs));
        return ok(JSON.stringify(w.prs.map((pr) => ({ ...pr, isDraft: draft }))));
      }
      if (args[0] === "pr" && args[1] === "ready") {
        const undo = args.includes("--undo");
        if ((undo ? w.undoCode : w.readyCode) !== 0) return fail(1, "ready/undo refuzat");
        draft = undo;
        return ok();
      }
      if (args[0] === "pr" && args[1] === "checks") {
        if (w.checks === null) return fail(1, "no checks reported on the 'faza' branch");
        return { code: w.checksCode, stdout: JSON.stringify(w.checks), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "merge") {
        if (draft) return fail(1, "Pull request is still a draft");
        // main avansează fie prin îmbinarea noastră, fie (mainAdvancesAnyway) pentru că altcineva a îmbinat între timp
        if (w.mergeCode === 0 || w.mainAdvancesAnyway) merged = true;
        return w.mergeCode === 0 ? ok("merged") : fail(w.mergeCode, "merge refuzat");
      }
      throw new Error(`comandă gh neprevăzută în simulare: ${cmd}`);
    },
    async readText(rel) {
      return Object.prototype.hasOwnProperty.call(w.files, rel) ? (w.files[rel] ?? null) : null;
    },
    async readVerification() {
      return w.verification;
    },
    log(line) {
      logs.push(line);
    },
  };
  return { ports, calls, logs };
}

async function run(over: Partial<World> = {}, phase = "redesign-final", dryRun = false) {
  const w = world(over);
  const { ports, calls, logs } = build(w);
  const result = await runGate({ phase, dryRun }, ports);
  return { result, calls, logs };
}

const mergeCalls = (calls: string[]) => calls.filter((c) => c.startsWith("gh pr merge"));
const pushedTags = (calls: string[]) =>
  calls.filter((c) => c.startsWith("git push origin refs/tags/"));
const ghCalls = (calls: string[]) => calls.filter((c) => c.startsWith("gh "));

function failedId(result: GateResult): number | null {
  return result.ok ? null : result.failed.id;
}

/** Condiția nu e îndeplinită: poarta se oprește la ea și nu a îmbinat și nu a publicat nicio etichetă. */
function expectStopsAt(r: { result: GateResult; calls: string[] }, id: number) {
  expect(failedId(r.result), JSON.stringify(r.result)).toBe(id);
  expect(mergeCalls(r.calls)).toEqual([]);
  expect(pushedTags(r.calls)).toEqual([]);
}

describe("calea verde (faza redesign-final, modul A)", () => {
  it("trece toate condițiile, pune eticheta pre-faza, îmbină prin commit, pune eticheta de final, în această ordine", async () => {
    const { result, calls } = await run();
    expect(result).toEqual({ ok: true, dryRun: false, mergeCommit: MERGE });
    const iPre = calls.findIndex((c) => c.startsWith("git tag -a pre-faza-redesign-final"));
    const iPushPre = calls.indexOf("git push origin refs/tags/pre-faza-redesign-final");
    const iMerge = calls.findIndex((c) => c.startsWith("gh pr merge"));
    const iDone = calls.findIndex((c) => c.startsWith("git tag -a faza-redesign-final-completa"));
    const iPushDone = calls.indexOf("git push origin refs/tags/faza-redesign-final-completa");
    expect(iPre).toBeGreaterThan(-1);
    expect(iPushPre).toBeGreaterThan(iPre);
    expect(iMerge).toBeGreaterThan(iPushPre);
    expect(iDone).toBeGreaterThan(iMerge);
    expect(iPushDone).toBeGreaterThan(iDone);
  });

  it("eticheta pre-faza e pusă pe vârful actual al lui main, iar cea finală pe commit-ul de îmbinare", async () => {
    const { calls } = await run();
    expect(calls.find((c) => c.startsWith("git tag -a pre-faza-redesign-final"))).toMatch(
      new RegExp(`${MAIN}$`),
    );
    expect(calls.find((c) => c.startsWith("git tag -a faza-redesign-final-completa"))).toMatch(
      new RegExp(`${MERGE}$`),
    );
  });

  it("îmbinarea e EXACT «gh pr merge <n> --merge --match-head-commit <sha>»: fără squash, fără ștergerea ramurii, fără --admin, fără --auto", async () => {
    const { calls } = await run();
    expect(mergeCalls(calls)).toEqual([`gh pr merge 12 --merge --match-head-commit ${HEAD}`]);
  });

  it("--dry-run verifică toate condițiile și se oprește înainte de etichete și de îmbinare", async () => {
    const { result, calls } = await run({}, "redesign-final", true);
    expect(result).toEqual({ ok: true, dryRun: true, mergeCommit: null });
    expect(mergeCalls(calls)).toEqual([]);
    expect(pushedTags(calls)).toEqual([]);
    expect(calls.filter((c) => c.startsWith("git tag -a"))).toEqual([]);
  });

  it("o fază numerotată de modul B, cu aprobare, trece și ramura e faza-N", async () => {
    const { result, calls } = await run({ branch: "faza-9" }, "9");
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.startsWith("git tag -a pre-faza-9 "))).toBe(true);
  });
});

describe("condiția 0: pregătirea (fază, ramură, frâna de mână)", () => {
  it("o fază necunoscută sau un identificator nevalid nu trece, fără nicio comandă", async () => {
    for (const phase of ["99", "", "--force", "faza 9", "redesign-altceva"]) {
      const r = await run({}, phase);
      expectStopsAt(r, 0);
      expect(r.calls, phase).toEqual([]);
    }
  });

  it("STOP.txt în rădăcină oprește poarta (frâna de mână)", async () => {
    const r = await run({ files: { ...world().files, "STOP.txt": "" } });
    expectStopsAt(r, 0);
    expect(r.calls).toEqual([]);
  });

  it("trebuie să fii pe ramura fazei (faza-N sau redesign-final), nu pe main sau pe altă ramură", async () => {
    for (const branch of ["main", "faza-10", "alta"]) {
      expectStopsAt(await run({ branch }), 0);
    }
    expectStopsAt(await run({ branch: "redesign-final" }, "9"), 0);
  });
});

describe("condiția 1: arbore curat și fără fișiere din afara scopului", () => {
  it("orice linie din `git status --porcelain` (modificat, șters, nesuivit) oprește poarta", async () => {
    for (const porcelain of [
      " M apps/web/a.ts\n",
      "?? ceva.txt\n",
      "D  docs/x.md\n",
      "A  nou.ts\n",
    ]) {
      expectStopsAt(await run({ porcelain }), 1);
    }
  });

  it("fișierele de lucru din diferență (local-data, .env, loguri, copii, zz-*, rezultate de test, copii ale bazei) opresc poarta", async () => {
    const stray = [
      "local-data/arhiva/x.csv",
      ".env",
      "apps/web/.env.local",
      "STOP.txt",
      "e2e/zz-capturi.spec.ts",
      "test-results/x/error.png",
      "playwright-report/index.html",
      "apps/web/.next-probe/build.js",
      "build.log",
      "docs/x.md.bak",
      "backup-2026.sql",
      "notes.dump",
      "node_modules/x/index.js",
    ];
    for (const file of stray) {
      expectStopsAt(await run({ diffFiles: ["apps/web/a.ts", file] }), 1);
    }
  });

  it("docs/AUTONOM-APROBARI.md în diferența ramurii oprește poarta: îl scrie numai utilizatorul, iar aprobarea intră în main, nu pe ramura fazei", async () => {
    for (const diffFiles of [
      ["docs/AUTONOM-APROBARI.md"],
      ["apps/web/src/a.tsx", "docs/AUTONOM-APROBARI.md", "docs/PROGRESS.md"],
    ]) {
      const r = await run({ branch: "faza-9", diffFiles }, "9");
      expectStopsAt(r, 1);
      expect(JSON.stringify(r.result)).toContain("AUTONOM-APROBARI");
    }
  });

  it("migrările SQL și fișierele obișnuite din diferență nu sunt «din afara scopului»", async () => {
    const r = await run({
      diffFiles: [
        "packages/db/prisma/migrations/20261201090000_x/migration.sql",
        "apps/web/src/zzz-nu-e-temporar.ts",
        "docs/AUTONOM-LOG.md",
      ],
    });
    expect(r.result.ok).toBe(true);
  });
});

describe("condiția 2: ramura e actualizată față de main", () => {
  it("dacă main nu e strămoș al ramurii, poarta se oprește (nu aduce ea main în ramură)", async () => {
    expectStopsAt(await run({ behind: true }), 2);
  });

  it("dacă `git fetch` eșuează, poarta se oprește (nu judecă după un main vechi)", async () => {
    expectStopsAt(await run({ fetchCode: 128 }), 2);
  });
});

describe("condiția 3: verificarea completă locală pe codul final", () => {
  it("fără înregistrare nu trece", async () => {
    expectStopsAt(await run({ verification: null }), 3);
  });

  it("înregistrarea făcută pe alt cod (arbore diferit) nu trece", async () => {
    expectStopsAt(await run({ verification: greenVerification("9".repeat(40)) }), 3);
  });

  it("un pas lipsă, un pas picat, un test sărit sau intermitent nu trec", async () => {
    const base = greenVerification();
    const without = { ...base, steps: base.steps.filter((s) => s.name !== "e2e") };
    const failedStep = {
      ...base,
      steps: base.steps.map((s) => (s.name === "lint" ? { ...s, exitCode: 1 } : s)),
    };
    const skipped = {
      ...base,
      steps: base.steps.map((s) =>
        s.name === "unit" ? { ...s, counts: { ...s.counts, skipped: 2 } } : s,
      ),
    };
    const flaky = {
      ...base,
      steps: base.steps.map((s) =>
        s.name === "e2e" ? { ...s, counts: { ...s.counts, flaky: 1 } } : s,
      ),
    };
    for (const verification of [without, failedStep, skipped, flaky]) {
      expectStopsAt(await run({ verification }), 3);
    }
  });
});

describe("condiția 4: CI-ul de pe GitHub e verde pe vârful ramurii", () => {
  it("fără cerere de îmbinare deschisă pentru ramură, sau cu două, nu trece", async () => {
    expectStopsAt(await run({ prs: [] }), 4);
    expectStopsAt(
      await run({
        prs: [
          { number: 1, headRefOid: HEAD, isDraft: false },
          { number: 2, headRefOid: HEAD, isDraft: false },
        ],
      }),
      4,
    );
  });

  it("o cerere cu alt vârf decât codul local (ramura nepublicată sau în urmă) nu trece, nici dacă e draft", async () => {
    expectStopsAt(
      await run({ prs: [{ number: 12, headRefOid: "f".repeat(40), isDraft: true }] }),
      4,
    );
    expectStopsAt(
      await run({ prs: [{ number: 12, headRefOid: "f".repeat(40), isDraft: false }] }),
      4,
    );
  });

  it("nicio verificare raportată (CI care nu a pornit) nu înseamnă «verde»", async () => {
    expectStopsAt(await run({ checks: null }), 4);
    expectStopsAt(await run({ checks: [] }), 4);
  });

  it("orice verificare care nu e «pass» (în curs, picată, anulată, sărită) oprește poarta", async () => {
    for (const bucket of ["pending", "fail", "cancel", "skipping"]) {
      const checks = [
        { bucket: "pass", name: "build", state: "SUCCESS", workflow: "CI" },
        { bucket, name: "e2e", state: "X", workflow: "CI" },
      ];
      expectStopsAt(await run({ checks, checksCode: bucket === "pending" ? 8 : 1 }), 4);
    }
  });

  it("dacă `gh pr list` sau `gh pr checks` întorc ceva ce nu e JSON, poarta se oprește", async () => {
    const w = world();
    const { ports, calls } = build(w);
    const broken: GatePorts = {
      ...ports,
      gh: async (args) => (
        calls.push(`gh ${args.join(" ")}`),
        { code: 0, stdout: "nu e json", stderr: "" }
      ),
    };
    const result = await runGate({ phase: "redesign-final", dryRun: false }, broken);
    expect(failedId(result)).toBe(4);
    expect(mergeCalls(calls)).toEqual([]);
  });

  it("citește CI-ul pentru ramura fazei și baza main", async () => {
    const { calls } = await run();
    const list = calls.find((c) => c.startsWith("gh pr list")) ?? "";
    expect(list).toContain("--head redesign-final");
    expect(list).toContain("--base main");
    expect(calls.some((c) => c.startsWith("gh pr checks 12"))).toBe(true);
  });
});

describe("condiția 5: fără S1 sau S2 deschise în docs/FINISAJE.md", () => {
  const withFinisaje = (text: string | null) => ({
    files: { ...world().files, "docs/FINISAJE.md": text },
  });

  it("un S1 sau un S2 deschis opresc poarta", async () => {
    expectStopsAt(await run(withFinisaje("- [ ] S1 | x | y | z")), 5);
    expectStopsAt(await run(withFinisaje("- [ ] S2 | x | y | z")), 5);
  });

  it("o intrare deschisă fără severitate se socotește S2 și oprește", async () => {
    expectStopsAt(await run(withFinisaje("- [ ] ceva")), 5);
  });

  it("S3 deschis, S1/S2 rezolvate sau un fișier gol nu opresc", async () => {
    for (const text of ["- [ ] S3 | x | y | z", "- [x] S1 | x | y | z\n- [x] S2 | x | y | z", ""]) {
      expect((await run(withFinisaje(text))).result.ok, text).toBe(true);
    }
  });

  it("fără fișierul docs/FINISAJE.md poarta se oprește (configurare incompletă)", async () => {
    expectStopsAt(await run(withFinisaje(null)), 5);
  });
});

describe("condiția 6: aprobarea utilizatorului pentru fazele B și C", () => {
  const withApprovals = (text: string | null) => ({
    files: { ...world().files, "docs/AUTONOM-APROBARI.md": text },
  });

  it("faza de modul B fără «aprobat» pentru ea nu trece (lipsă, alt text, altă fază, neaprobat)", async () => {
    for (const text of [
      null,
      "",
      "- Faza 9: în așteptare",
      "- Faza 9: neaprobat",
      "- Faza 10: aprobat",
      "- Faza 19: aprobat",
    ]) {
      expectStopsAt(await run({ branch: "faza-9", ...withApprovals(text) }, "9"), 6);
    }
  });

  it("faza de modul C (storefront) cere și ea aprobare", async () => {
    expectStopsAt(
      await run({ branch: "faza-7", ...withApprovals("- Faza 7: în așteptare") }, "7"),
      6,
    );
    expect(
      (await run({ branch: "faza-7", ...withApprovals("- Faza 7: aprobat") }, "7")).result.ok,
    ).toBe(true);
  });

  it("faza 6 (modul C) cere «aprobat» pentru ea, nu pentru altă fază", async () => {
    for (const text of [null, "- Faza 6: în așteptare", "- Faza 7: aprobat"]) {
      expectStopsAt(await run({ branch: "faza-6", ...withApprovals(text) }, "6"), 6);
    }
    expect(
      (await run({ branch: "faza-6", ...withApprovals("- Faza 6: aprobat") }, "6")).result.ok,
    ).toBe(true);
  });

  it("faza de modul A nu cere aprobare (nici dacă fișierul lipsește)", async () => {
    expect((await run(withApprovals(null))).result.ok).toBe(true);
  });
});

describe("condiția 7: etichetele și îmbinarea prin commit", () => {
  it("eticheta pre-faza care există deja pe alt commit, sau eticheta finală existentă, opresc poarta", async () => {
    expectStopsAt(await run({ remoteTags: { "pre-faza-redesign-final": "a".repeat(40) } }), 7);
    expectStopsAt(await run({ remoteTags: { "faza-redesign-final-completa": MERGE } }), 7);
  });

  it("o reluare după o îmbinare eșuată: eticheta pre-faza deja pusă pe vârful actual al lui main se reutilizează", async () => {
    const { result, calls } = await run({ remoteTags: { "pre-faza-redesign-final": MAIN } });
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.startsWith("git tag -a pre-faza"))).toEqual([]);
    expect(mergeCalls(calls)).toHaveLength(1);
  });

  it("dacă îmbinarea e refuzată, nu se pune eticheta finală și poarta raportează eșecul", async () => {
    const { result, calls } = await run({ mergeCode: 1 });
    expect(failedId(result)).toBe(7);
    expect(calls.some((c) => c.startsWith("git tag -a faza-redesign-final-completa"))).toBe(false);
    expect(pushedTags(calls)).toEqual(["git push origin refs/tags/pre-faza-redesign-final"]);
  });

  it("dacă îmbinarea e refuzată, dar vârful lui main e deja un commit de îmbinare, poarta nu pune eticheta finală pe el (main nu a avansat)", async () => {
    const { result, calls } = await run({ mergeCode: 1, parentsAfterMerge: 2 });
    expect(failedId(result)).toBe(7);
    expect(calls.some((c) => c.startsWith("git tag -a faza-redesign-final-completa"))).toBe(false);
  });

  it("dacă îmbinarea e refuzată, dar main a avansat din alt motiv (altcineva a îmbinat între timp), poarta tot nu pune eticheta finală", async () => {
    const { result, calls } = await run({ mergeCode: 1, mainAdvancesAnyway: true });
    expect(failedId(result)).toBe(7);
    expect(calls.some((c) => c.startsWith("git tag -a faza-redesign-final-completa"))).toBe(false);
  });

  it("dacă îmbinarea reușește, dar main nu a avansat (răspuns neașteptat), poarta nu pune eticheta finală", async () => {
    const w = world();
    const { ports, calls } = build(w);
    // main rămâne la vârful vechi și după îmbinare, iar vârful vechi e un commit de îmbinare cu doi părinți (deci doar verificarea
    // «main a avansat» îl poate opri)
    const stuck: GatePorts = {
      ...ports,
      git: async (args) => {
        const cmd = args.join(" ");
        if (cmd === "rev-parse origin/main") {
          calls.push(`git ${cmd}`);
          return ok(`${w.mainSha}\n`);
        }
        if (cmd === "rev-list --parents -n 1 origin/main") {
          calls.push(`git ${cmd}`);
          return ok(`${w.mainSha} ${"5".repeat(40)} ${"6".repeat(40)}\n`);
        }
        return ports.git(args);
      },
    };
    const result = await runGate({ phase: "redesign-final", dryRun: false }, stuck);
    expect(failedId(result)).toBe(7);
    expect(calls.some((c) => c.startsWith("git tag -a faza-redesign-final-completa"))).toBe(false);
  });

  it("dacă vârful lui main după îmbinare nu e commit de îmbinare (squash sau fast-forward), poarta raportează eșecul și nu pune eticheta finală", async () => {
    const { result, calls } = await run({ parentsAfterMerge: 1 });
    expect(failedId(result)).toBe(7);
    expect(calls.some((c) => c.startsWith("git tag -a faza-redesign-final-completa"))).toBe(false);
  });
});

describe("ordinea condițiilor: poarta se oprește la prima neîndeplinită", () => {
  it("cu arbore murdar ȘI CI roșu, se oprește la 1 și nu întreabă GitHub deloc", async () => {
    const r = await run({
      porcelain: " M a.ts\n",
      checks: [{ bucket: "fail", name: "e2e", state: "X", workflow: "CI" }],
    });
    expectStopsAt(r, 1);
    expect(ghCalls(r.calls)).toEqual([]);
  });

  it("cu CI roșu ȘI un S2 deschis, se oprește la 4 (CI vine înaintea finisajelor)", async () => {
    const r = await run({
      checks: [{ bucket: "fail", name: "e2e", state: "X", workflow: "CI" }],
      files: { ...world().files, "docs/FINISAJE.md": "- [ ] S2 | x | y | z" },
    });
    expectStopsAt(r, 4);
  });

  it("cu verificarea locală lipsă ȘI CI roșu, se oprește la 3 și nu întreabă GitHub", async () => {
    const r = await run({ verification: null, checks: null });
    expectStopsAt(r, 3);
    expect(ghCalls(r.calls)).toEqual([]);
  });
});

describe("fără mod de a ocoli o condiție", () => {
  it("linia de comandă acceptă doar --faza <id> și --dry-run; orice altceva e respins", () => {
    expect(parseGateArgs(["--faza", "9"])).toEqual({
      ok: true,
      options: { phase: "9", dryRun: false },
    });
    expect(parseGateArgs(["--faza=redesign-final", "--dry-run"])).toEqual({
      ok: true,
      options: { phase: "redesign-final", dryRun: true },
    });
    for (const argv of [
      [],
      ["--faza"],
      ["--faza", "9", "--force"],
      ["--faza", "9", "--skip-ci"],
      ["--faza", "9", "--admin"],
      ["--faza", "9", "--no-verify"],
      ["--faza", "9", "--squash"],
      ["--faza", "9", "--delete-branch"],
      ["--faza", "9", "extra"],
      ["--faza", "9", "--faza", "10"],
      ["9"],
      ["--faza", "--force"],
      ["--force", "--faza", "9"],
    ]) {
      expect(parseGateArgs(argv).ok, JSON.stringify(argv)).toBe(false);
    }
  });

  it("identificatorul fazei din linia de comandă trece prin aceeași validare ca în poartă", () => {
    expect(parseGateArgs(["--faza", "9;rm"]).ok).toBe(false);
    expect(parseGateArgs(["--faza", "../x"]).ok).toBe(false);
  });
});

describe("faza 15d (ramura faza-15d, modul A)", () => {
  it("poarta acceptă numele ramurii și pune etichetele pre-faza-15d / faza-15d-completa", async () => {
    const { result, calls } = await run({ branch: "faza-15d" }, "15d");
    expect(result).toEqual({ ok: true, dryRun: false, mergeCommit: MERGE });
    expect(calls.some((c) => c.startsWith("git tag -a pre-faza-15d"))).toBe(true);
    expect(calls.some((c) => c.startsWith("git tag -a faza-15d-completa"))).toBe(true);
  });

  it("pe altă ramură decât faza-15d poarta se oprește la condiția 0", async () => {
    const r = await run({ branch: "redesign-final" }, "15d");
    expectStopsAt(r, 0);
  });
});

const readyCalls = (calls: string[]) => calls.filter((c) => c.startsWith("gh pr ready"));
const DRAFT_PRS = [{ number: 12, headRefOid: HEAD, isDraft: true }];

describe("cerere draft: condiția 4 o acceptă, poarta o marchează ready chiar înainte de îmbinare", () => {
  it("--dry-run cu o cerere draft și totul verde: trece, spune că o va marca ready și NU o modifică", async () => {
    const { result, calls, logs } = await run({ prs: DRAFT_PRS }, "redesign-final", true);
    expect(result).toEqual({ ok: true, dryRun: true, mergeCommit: null });
    expect(logs.join("\n")).toContain(
      "PR-ul e draft; poarta îl va marca ready înainte de îmbinare",
    );
    expect(readyCalls(calls)).toEqual([]);
    expect(mergeCalls(calls)).toEqual([]);
    expect(pushedTags(calls)).toEqual([]);
    // singurele apeluri către GitHub: citirea cererii și a verificărilor
    expect(
      ghCalls(calls).every((c) => c.startsWith("gh pr list") || c.startsWith("gh pr checks")),
    ).toBe(true);
  });

  it("ordinea la pasul 7: eticheta pre-faza → ready → îmbinare → eticheta finală", async () => {
    const { result, calls } = await run({ prs: DRAFT_PRS });
    expect(result).toEqual({ ok: true, dryRun: false, mergeCommit: MERGE });
    const iPushPre = calls.indexOf("git push origin refs/tags/pre-faza-redesign-final");
    const iReady = calls.indexOf("gh pr ready 12");
    const iMerge = calls.findIndex((c) => c.startsWith("gh pr merge"));
    const iDone = calls.findIndex((c) => c.startsWith("git tag -a faza-redesign-final-completa"));
    expect(iPushPre).toBeGreaterThan(-1);
    expect(iReady).toBeGreaterThan(iPushPre);
    expect(iMerge).toBeGreaterThan(iReady);
    expect(iDone).toBeGreaterThan(iMerge);
    expect(readyCalls(calls)).toEqual(["gh pr ready 12"]);
    expect(mergeCalls(calls)).toEqual([`gh pr merge 12 --merge --match-head-commit ${HEAD}`]);
  });

  it("dacă `gh pr ready` eșuează, poarta se oprește ÎNAINTE de îmbinare, cu un mesaj clar, fără eticheta finală și fără --undo", async () => {
    const { result, calls } = await run({ prs: DRAFT_PRS, readyCode: 1 });
    expect(failedId(result)).toBe(7);
    expect(JSON.stringify(result)).toContain("ready");
    expect(mergeCalls(calls)).toEqual([]);
    expect(readyCalls(calls)).toEqual(["gh pr ready 12"]);
    expect(calls.some((c) => c.startsWith("git tag -a faza-redesign-final-completa"))).toBe(false);
  });

  it("dacă îmbinarea e refuzată după ready, poarta readuce cererea în draft (--undo), după încercarea de îmbinare, și raportează", async () => {
    const { result, calls } = await run({ prs: DRAFT_PRS, mergeCode: 1 });
    expect(failedId(result)).toBe(7);
    expect(JSON.stringify(result)).toContain("draft");
    expect(readyCalls(calls)).toEqual(["gh pr ready 12", "gh pr ready 12 --undo"]);
    expect(calls.indexOf("gh pr ready 12 --undo")).toBeGreaterThan(
      calls.findIndex((c) => c.startsWith("gh pr merge")),
    );
    expect(calls.some((c) => c.startsWith("git tag -a faza-redesign-final-completa"))).toBe(false);
  });

  it("dacă și --undo eșuează, raportul spune că cererea a rămas ready și cum o readuci în draft", async () => {
    const { result } = await run({ prs: DRAFT_PRS, mergeCode: 1, undoCode: 1 });
    expect(failedId(result)).toBe(7);
    expect(JSON.stringify(result)).toContain("gh pr ready 12 --undo");
  });

  it("o cerere care era DEJA ready la început nu e modificată în niciun fel (nici ready, nici --undo), nici când îmbinarea e refuzată", async () => {
    const ok1 = await run({});
    expect(readyCalls(ok1.calls)).toEqual([]);
    const refused = await run({ mergeCode: 1 });
    expect(failedId(refused.result)).toBe(7);
    expect(readyCalls(refused.calls)).toEqual([]);
  });

  it("fiecare condiție 0–6 refuză tot o cerere draft, fără ready și fără îmbinare", async () => {
    const withApprovals = (text: string) => ({
      branch: "faza-9",
      files: { ...world().files, "docs/AUTONOM-APROBARI.md": text },
    });
    const cases: [string, Partial<World>, number, string?][] = [
      ["ramură greșită", { branch: "main" }, 0],
      ["arbore murdar", { porcelain: " M a.ts\n" }, 1],
      ["fișier din afara scopului", { diffFiles: ["local-data/x.csv"] }, 1],
      ["în urma lui main", { behind: true }, 2],
      ["fără verificare locală", { verification: null }, 3],
      ["CI roșu", { checks: [{ bucket: "fail", name: "e2e", state: "X", workflow: "CI" }] }, 4],
      ["fără verificări CI", { checks: null }, 4],
      ["vârf diferit", { prs: [{ number: 12, headRefOid: "f".repeat(40), isDraft: true }] }, 4],
      [
        "două cereri deschise",
        {
          prs: [
            { number: 1, headRefOid: HEAD, isDraft: true },
            { number: 2, headRefOid: HEAD, isDraft: true },
          ],
        },
        4,
      ],
      [
        "S2 deschis",
        { files: { ...world().files, "docs/FINISAJE.md": "- [ ] S2 | x | y | z" } },
        5,
      ],
      ["fără aprobare (modul B)", withApprovals("- Faza 9: în așteptare"), 6, "9"],
    ];
    for (const [name, over, id, phase] of cases) {
      const r = await run({ prs: DRAFT_PRS, ...over }, phase ?? "redesign-final");
      expectStopsAt(r, id);
      expect(readyCalls(r.calls), name).toEqual([]);
    }
  });

  it("comenzile ready și --undo sunt construite într-un singur loc, fără alte flag-uri", () => {
    expect(readyArgs(12)).toEqual(["pr", "ready", "12"]);
    expect(undoReadyArgs(12)).toEqual(["pr", "ready", "12", "--undo"]);
    expect(mergeArgs(12, HEAD)).toEqual([
      "pr",
      "merge",
      "12",
      "--merge",
      "--match-head-commit",
      HEAD,
    ]);
  });
});

describe("cerere deja îmbinată sau închisă: mesaj clar, fără a doua îmbinare", () => {
  const LIST_ALL =
    "gh pr list --head redesign-final --base main --state all --json number,state,mergeCommit";

  it("PR îmbinat: numește cererea și commit-ul, spune că nu îmbină a doua oară și arată --doar-etichete", async () => {
    for (const dry of [false, true]) {
      const r = await run(
        { prs: [], allPrs: [{ number: 7, state: "MERGED", mergeCommit: { oid: MERGE } }] },
        "redesign-final",
        dry,
      );
      expectStopsAt(r, 4);
      const text = JSON.stringify(r.result);
      expect(text).toContain("#7");
      expect(text).toContain("deja îmbinat");
      expect(text).toContain(MERGE);
      expect(text).toContain("--doar-etichete");
      expect(r.calls).toContain(LIST_ALL);
      expect(readyCalls(r.calls)).toEqual([]);
    }
  });

  it("PR închis fără îmbinare: spune asta și cum deschizi unul nou (draft)", async () => {
    const r = await run({
      prs: [],
      allPrs: [{ number: 5, state: "CLOSED", mergeCommit: null }],
    });
    expectStopsAt(r, 4);
    const text = JSON.stringify(r.result);
    expect(text).toContain("#5");
    expect(text).toContain("închis fără îmbinare");
    expect(text).toContain("--draft");
    expect(text).not.toContain("deja îmbinat");
  });

  it("dacă există și unul îmbinat, și unul închis, se raportează cel îmbinat", async () => {
    const r = await run({
      prs: [],
      allPrs: [
        { number: 5, state: "CLOSED", mergeCommit: null },
        { number: 7, state: "MERGED", mergeCommit: { oid: MERGE } },
      ],
    });
    expect(JSON.stringify(r.result)).toContain("deja îmbinat");
  });

  it("fără nicio cerere (nici îmbinată, nici închisă): mesajul cere crearea uneia draft", async () => {
    const r = await run({ prs: [], allPrs: [] });
    expectStopsAt(r, 4);
    expect(JSON.stringify(r.result)).toContain("gh pr create --draft");
  });

  it("dacă nu pot citi istoricul cererilor, tot se oprește la condiția 4", async () => {
    const w = world({ prs: [] });
    const { ports, calls } = build(w);
    const broken: GatePorts = {
      ...ports,
      gh: async (args) =>
        args.includes("all") ? { code: 1, stdout: "", stderr: "eroare" } : ports.gh(args),
    };
    const result = await runGate({ phase: "redesign-final", dryRun: false }, broken);
    expect(failedId(result)).toBe(4);
    expect(mergeCalls(calls)).toEqual([]);
  });
});

describe("eticheta adnotată: poarta citește commit-ul țintă (linia ^{}), nu obiectul etichetei", () => {
  it("o etichetă pre-faza adnotată, deja pe vârful actual al lui main, se reutilizează", async () => {
    const { result, calls } = await run({
      annotated: true,
      remoteTags: { "pre-faza-redesign-final": MAIN },
    });
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.startsWith("git tag -a pre-faza"))).toEqual([]);
    expect(mergeCalls(calls)).toHaveLength(1);
  });

  it("o etichetă pre-faza adnotată pe alt commit oprește poarta", async () => {
    expectStopsAt(
      await run({ annotated: true, remoteTags: { "pre-faza-redesign-final": "a".repeat(40) } }),
      7,
    );
  });

  it("o etichetă finală adnotată existentă oprește poarta", async () => {
    expectStopsAt(
      await run({ annotated: true, remoteTags: { "faza-redesign-final-completa": MERGE } }),
      7,
    );
  });
});

describe("--doar-etichete (fără îmbinare)", () => {
  const PARENT1 = "5".repeat(40);
  const PARENT2 = "6".repeat(40);
  const merged = (over: Partial<World> = {}): Partial<World> => ({
    allPrs: [{ number: 7, state: "MERGED", mergeCommit: { oid: MERGE } }],
    ancestors: [MERGE],
    parents: { [MERGE]: [PARENT1, PARENT2] },
    ...over,
  });

  async function runTags(over: Partial<World> = {}, phase = "7", dryRun = false) {
    const w = world(merged(over));
    const { ports, calls, logs } = build(w);
    const reads: string[] = [];
    let verificationReads = 0;
    const spied: GatePorts = {
      ...ports,
      readText: async (rel) => (reads.push(rel), ports.readText(rel)),
      readVerification: async () => (verificationReads++, ports.readVerification()),
    };
    const result = await runGate({ phase, dryRun, tagsOnly: true }, spied);
    return { result, calls, logs, reads, verificationReads };
  }
  const created = (calls: string[]) => calls.filter((c) => c.startsWith("git tag -a "));
  /** Nu s-a modificat nimic: nicio etichetă creată sau trimisă. */
  const untouched = (calls: string[]) => {
    expect(created(calls)).toEqual([]);
    expect(pushedTags(calls)).toEqual([]);
  };
  /** Singurul apel către GitHub e citirea listei de cereri: niciodată îmbinare, ready sau verificarea CI. */
  const onlyListsPrs = (calls: string[]) =>
    expect(ghCalls(calls).every((c) => c.startsWith("gh pr list"))).toBe(true);

  it("etichete lipsă: pre-faza-N pe primul părinte, faza-N-completa pe commit-ul de îmbinare, adnotate, împinse DOAR ele", async () => {
    const { result, calls, logs } = await runTags();
    expect(result).toEqual({ ok: true, dryRun: false, mergeCommit: MERGE });
    expect(created(calls)).toEqual([
      `git tag -a pre-faza-7 -m Înaintea fazei 7 ${PARENT1}`,
      `git tag -a faza-7-completa -m Faza 7 completă ${MERGE}`,
    ]);
    expect(pushedTags(calls)).toEqual([
      "git push origin refs/tags/pre-faza-7",
      "git push origin refs/tags/faza-7-completa",
    ]);
    expect(calls.filter((c) => c.startsWith("git push"))).toHaveLength(2);
    onlyListsPrs(calls);
    expect(logs.join("\n")).toContain("nu verifică CI");
  });

  it("citește cererile ramurii fazei spre main, în orice stare, și se bazează pe origin/main proaspăt", async () => {
    const { calls } = await runTags();
    expect(calls).toContain("git fetch origin main");
    expect(calls).toContain(
      "gh pr list --head faza-7 --base main --state all --json number,state,mergeCommit",
    );
    expect(calls).toContain(`git merge-base --is-ancestor ${MERGE} origin/main`);
    expect(calls).toContain(`git rev-list --parents -n 1 ${MERGE}`);
  });

  it("--dry-run arată ce ar crea și nu creează nimic", async () => {
    const { result, calls, logs } = await runTags({}, "7", true);
    expect(result).toEqual({ ok: true, dryRun: true, mergeCommit: MERGE });
    untouched(calls);
    onlyListsPrs(calls);
    expect(logs.join("\n")).toContain("pre-faza-7");
    expect(logs.join("\n")).toContain(PARENT1);
  });

  it("idempotent: etichetele deja pe commit-urile corecte (simple sau adnotate) nu se ating", async () => {
    for (const annotated of [false, true]) {
      const { result, calls } = await runTags({
        annotated,
        remoteTags: { "pre-faza-7": PARENT1, "faza-7-completa": MERGE },
      });
      expect(result.ok, `annotated=${annotated}`).toBe(true);
      untouched(calls);
    }
  });

  it("o etichetă lipsește, cealaltă e corectă: se creează doar cea lipsă", async () => {
    const onlyDone = await runTags({ remoteTags: { "pre-faza-7": PARENT1 } });
    expect(created(onlyDone.calls)).toEqual([
      `git tag -a faza-7-completa -m Faza 7 completă ${MERGE}`,
    ]);
    expect(pushedTags(onlyDone.calls)).toEqual(["git push origin refs/tags/faza-7-completa"]);
    const onlyPre = await runTags({ remoteTags: { "faza-7-completa": MERGE } });
    expect(created(onlyPre.calls)).toEqual([
      `git tag -a pre-faza-7 -m Înaintea fazei 7 ${PARENT1}`,
    ]);
  });

  it("o etichetă existentă pe ALT commit se refuză și nu se mută; nu se creează nici cealaltă", async () => {
    for (const [tags, name] of [
      [{ "pre-faza-7": "a".repeat(40) }, "pre-faza-7"],
      [{ "faza-7-completa": "a".repeat(40) }, "faza-7-completa"],
      [{ "pre-faza-7": MERGE }, "pre-faza-7 pe commit-ul de îmbinare"],
      [{ "faza-7-completa": PARENT1 }, "faza-7-completa pe primul părinte"],
    ] as const) {
      for (const annotated of [false, true]) {
        const { result, calls } = await runTags({ remoteTags: { ...tags }, annotated });
        expect(result.ok, `${name} annotated=${annotated}`).toBe(false);
        untouched(calls);
      }
    }
  });

  it("fără cerere îmbinată: nicio cerere, o cerere deschisă sau închisă, sau două îmbinate, se refuză", async () => {
    for (const allPrs of [
      [],
      // cu un commit valid (ca și cum ar fi îmbinat), doar starea le oprește
      [{ number: 7, state: "OPEN", mergeCommit: { oid: MERGE } }],
      [{ number: 7, state: "CLOSED", mergeCommit: { oid: MERGE } }],
      [
        { number: 7, state: "MERGED", mergeCommit: { oid: MERGE } },
        { number: 8, state: "MERGED", mergeCommit: { oid: "7".repeat(40) } },
      ],
    ]) {
      const { result, calls } = await runTags({ allPrs });
      expect(result.ok, JSON.stringify(allPrs)).toBe(false);
      untouched(calls);
      onlyListsPrs(calls);
    }
  });

  it("commit-ul de îmbinare trebuie să aibă exact doi părinți (squash, rebase sau octopus se refuză)", async () => {
    for (const parents of [[PARENT1], [], [PARENT1, PARENT2, "7".repeat(40)]]) {
      const { result, calls } = await runTags({ parents: { [MERGE]: parents } });
      expect(result.ok, `${parents.length} părinți`).toBe(false);
      untouched(calls);
    }
  });

  it("commit-ul de îmbinare trebuie să fie strămoș al lui origin/main", async () => {
    const { result, calls } = await runTags({ ancestors: [] });
    expect(result.ok).toBe(false);
    untouched(calls);
  });

  it("un identificator de commit care nu e un hash de 40 de caractere (sau lipsește) se refuză", async () => {
    for (const mergeCommit of [{ oid: "nu-e-hash" }, { oid: "--output=x" }, { oid: "" }, null]) {
      const bad = mergeCommit?.oid ?? "";
      const { result, calls } = await runTags({
        allPrs: [{ number: 7, state: "MERGED", mergeCommit }],
        // comenzile git de după ar „reuși” pe acest identificator: doar validarea lui îl poate opri
        ancestors: [bad],
        parents: { [bad]: [PARENT1, PARENT2] },
      });
      expect(result.ok, JSON.stringify(mergeCommit)).toBe(false);
      untouched(calls);
    }
  });

  it("faza necunoscută, STOP.txt sau fetch eșuat opresc modul, fără nicio modificare", async () => {
    const unknown = await runTags({}, "99");
    expect(unknown.result.ok).toBe(false);
    expect(unknown.calls).toEqual([]);
    const stop = await runTags({ files: { ...world().files, "STOP.txt": "" } });
    expect(stop.result.ok).toBe(false);
    expect(stop.calls).toEqual([]);
    const noFetch = await runTags({ fetchCode: 128 });
    expect(noFetch.result.ok).toBe(false);
    untouched(noFetch.calls);
  });

  it("nu apelează NICIODATĂ merge, ready, verificarea CI și nu citește verificarea locală sau aprobările", async () => {
    const scenarios: Partial<World>[] = [
      {},
      { remoteTags: { "pre-faza-7": PARENT1, "faza-7-completa": MERGE } },
      { remoteTags: { "pre-faza-7": "a".repeat(40) } },
      { allPrs: [] },
      { parents: { [MERGE]: [PARENT1] } },
    ];
    for (const over of scenarios) {
      for (const dry of [false, true]) {
        const r = await runTags(over, "7", dry);
        expect(ghCalls(r.calls).filter((c) => !c.startsWith("gh pr list"))).toEqual([]);
        expect(r.calls.some((c) => /pr (merge|ready|checks)/.test(c))).toBe(false);
        expect(r.verificationReads).toBe(0);
        expect(r.reads.filter((p) => p !== "STOP.txt")).toEqual([]);
      }
    }
  });

  it("nu cere CI verde, verificare locală sau aprobare: merge și cu CI roșu, fără verificare și cu aprobare lipsă", async () => {
    const r = await runTags({
      checks: [{ bucket: "fail", name: "e2e", state: "X", workflow: "CI" }],
      verification: null,
      files: { ...world().files, "docs/AUTONOM-APROBARI.md": null },
    });
    expect(r.result.ok).toBe(true);
  });

  it("funcționează pe etichete adnotate (citește commit-ul țintă)", async () => {
    const { result, calls } = await runTags({
      annotated: true,
      remoteTags: { "pre-faza-7": PARENT1 },
    });
    expect(result.ok).toBe(true);
    expect(created(calls)).toEqual([`git tag -a faza-7-completa -m Faza 7 completă ${MERGE}`]);
  });
});

describe("linia de comandă: doar --doar-etichete se adaugă", () => {
  it("--doar-etichete merge cu --faza și, opțional, --dry-run", () => {
    expect(parseGateArgs(["--faza", "7", "--doar-etichete"])).toEqual({
      ok: true,
      options: { phase: "7", dryRun: false, tagsOnly: true },
    });
    expect(parseGateArgs(["--faza=7", "--doar-etichete", "--dry-run"])).toEqual({
      ok: true,
      options: { phase: "7", dryRun: true, tagsOnly: true },
    });
    expect(parseGateArgs(["--doar-etichete", "--faza", "7"]).ok).toBe(true);
  });

  it("fără --doar-etichete, opțiunile rămân cele vechi (nicio cheie tagsOnly)", () => {
    expect(parseGateArgs(["--faza", "9"])).toEqual({
      ok: true,
      options: { phase: "9", dryRun: false },
    });
  });

  it("--doar-etichete fără --faza sau cu o fază nevalidă se respinge", () => {
    expect(parseGateArgs(["--doar-etichete"]).ok).toBe(false);
    expect(parseGateArgs(["--doar-etichete", "--faza", "9;rm"]).ok).toBe(false);
  });

  it("orice alt flag rămâne respins, și cu --doar-etichete", () => {
    for (const extra of [
      "--force",
      "--admin",
      "--squash",
      "--ready",
      "--skip-ci",
      "--merge",
      "--doar-etichete=1",
      "--doar-eticheta",
    ]) {
      expect(parseGateArgs(["--faza", "7", extra]).ok, extra).toBe(false);
      expect(parseGateArgs(["--faza", "7", "--doar-etichete", extra]).ok, extra).toBe(false);
    }
    expect(parseGateArgs(["--faza", "7", "--doar-etichete", "--doar-etichete"]).ok).toBe(false);
  });
});
