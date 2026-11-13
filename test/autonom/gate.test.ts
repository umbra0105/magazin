import { describe, expect, it } from "vitest";
import {
  runGate,
  parseGateArgs,
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
    ...over,
  };
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (code: number, stderr = "eroare"): RunResult => ({ code, stdout: "", stderr });

function build(w: World) {
  const calls: string[] = [];
  let merged = false;
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
        return ok(
          Object.entries(w.remoteTags)
            .map(([tag, sha]) => `${sha}\trefs/tags/${tag}`)
            .join("\n"),
        );
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
      if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify(w.prs));
      if (args[0] === "pr" && args[1] === "checks") {
        if (w.checks === null) return fail(1, "no checks reported on the 'faza' branch");
        return { code: w.checksCode, stdout: JSON.stringify(w.checks), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "merge") {
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
    log() {},
  };
  return { ports, calls };
}

async function run(over: Partial<World> = {}, phase = "redesign-final", dryRun = false) {
  const w = world(over);
  const { ports, calls } = build(w);
  const result = await runGate({ phase, dryRun }, ports);
  return { result, calls };
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

  it("o cerere ciornă (draft) sau cu alt vârf decât codul local (ramura nepublicată sau în urmă) nu trece", async () => {
    expectStopsAt(await run({ prs: [{ number: 12, headRefOid: HEAD, isDraft: true }] }), 4);
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
