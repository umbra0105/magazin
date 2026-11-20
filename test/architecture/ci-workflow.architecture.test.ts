import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Structura CI-ului (`.github/workflows/ci.yml`, mini-fazele `ci-joburi` și `ci-e2e-paralel`): jobul unic `check` e împărțit în
 * joburi paralele (`lint-unit`, `integration`, iar E2E în trei: `e2e-chromium` pe shard-uri, `e2e-isolated` cu proiectele de stare
 * globală și `e2e-s3`), iar `check` rămâne numele verificării de stare cerute de rulesetul de pe `main` (job final de agregare).
 * Testul citește fișierul TEXTUAL, fără o bibliotecă YAML (nu avem una ca dependență directă), pe structura pe care o are
 * fișierul: chei la 0, 2 și 4 spații, pași la 6.
 *
 * Ce păzește:
 *  - fiecare pas de lucru din vechiul `check` apare în continuare, fără pași în plus (pașii de pregătire E2E, în fiecare job E2E);
 *  - jobul `check` agregă TOATE celelalte joburi (`needs` + `if: always()`) și pică dacă oricare nu e `success`;
 *  - niciun job și niciun pas nu poate fi SĂRIT (`if`, `paths`, `continue-on-error`): un job sărit nu e «verde» pentru poartă
 *    (docs/20 §5, condiția 4); singura excepție e raportul Playwright, `if: failure()`, în joburile E2E; matricea (`strategy`)
 *    e permisă DOAR în `e2e-chromium`, cu `fail-fast: false`;
 *  - ACOPERIREA E2E: shard-urile + proiectele izolate + S3 dau exact aceleași teste ca rularea locală (`playwright test --list`),
 *    fără test pierdut sau dublat;
 *  - triggerele, concurența, versiunile fixate și valorile de mediu «doar CI» sunt neschimbate.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const raw = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8").replace(/\r\n/g, "\n");
/** Fără rândurile de comentariu: un cuvânt dintr-un comentariu nu trebuie să conteze ca structură. */
const lines = raw.split("\n").filter((line) => !/^\s*#/.test(line));
const text = lines.join("\n");

interface Step {
  /** `name` dacă există, altfel `uses`/`run` (pașii vechi fără nume). */
  readonly id: string;
  readonly name: string | null;
  readonly uses: string | null;
  readonly run: string | null;
  readonly condition: string | null;
  readonly body: string;
}

interface Job {
  readonly id: string;
  readonly body: string;
  readonly steps: readonly Step[];
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Liniile secțiunii `jobs:` (până la următoarea cheie de la început de rând). */
function jobsSection(): string[] {
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && indentOf(line) === 0) break;
    out.push(line);
  }
  return out;
}

function fieldOf(stepLines: readonly string[], key: string): string | null {
  for (const line of stepLines) {
    const match = new RegExp(`^\\s*(?:- )?${key}:\\s*(.*)$`).exec(line);
    if (match && indentOf(line) <= 8) return (match[1] ?? "").trim();
  }
  return null;
}

function parseSteps(bodyLines: readonly string[]): Step[] {
  const start = bodyLines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  if (start < 0) return [];
  const steps: string[][] = [];
  for (const line of bodyLines.slice(start + 1)) {
    if (line.trim() !== "" && indentOf(line) <= 4) break;
    if (/^ {6}- /.test(line)) steps.push([line]);
    else steps.at(-1)?.push(line);
  }
  return steps.map((stepLines) => {
    const name = fieldOf(stepLines, "name");
    const uses = fieldOf(stepLines, "uses");
    const run = fieldOf(stepLines, "run");
    return {
      id: name ?? (uses ? `uses:${uses}` : `run:${run ?? ""}`),
      name,
      uses,
      run,
      condition: fieldOf(stepLines, "if"),
      body: stepLines.join("\n"),
    };
  });
}

function parseJobs(): Job[] {
  const groups: Array<{ id: string; lines: string[] }> = [];
  for (const line of jobsSection()) {
    const header = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (header) groups.push({ id: header[1] ?? "", lines: [] });
    else groups.at(-1)?.lines.push(line);
  }
  return groups.map((group) => ({
    id: group.id,
    body: group.lines.join("\n"),
    steps: parseSteps(group.lines),
  }));
}

const jobs = parseJobs();
const job = (id: string): Job => {
  const found = jobs.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Jobul «${id}» lipsește din .github/workflows/ci.yml`);
  return found;
};

/** Valoarea câmpului de job (indentare 4), ca text. */
function jobField(target: Job, key: string): string | null {
  for (const line of target.body.split("\n")) {
    if (indentOf(line) !== 4) continue;
    const match = new RegExp(`^ {4}${key}:\\s*(.*)$`).exec(line);
    if (match) return (match[1] ?? "").trim();
  }
  return null;
}

/** `needs`: listă inline `[a, b]` sau listă cu liniuță. */
function needsOf(target: Job): string[] {
  const inline = jobField(target, "needs");
  if (inline === null) return [];
  if (inline.startsWith("[")) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  if (inline !== "") return [inline];
  const out: string[] = [];
  let inList = false;
  for (const line of target.body.split("\n")) {
    if (/^ {4}needs:\s*$/.test(line)) inList = true;
    else if (inList && /^ {6}- /.test(line)) out.push(line.replace(/^ {6}- /, "").trim());
    else if (inList && line.trim() !== "") break;
  }
  return out;
}

/** Serviciile unui job (`services:` la 4, fiecare serviciu la 6). */
function servicesOf(target: Job): string[] {
  const bodyLines = target.body.split("\n");
  const start = bodyLines.findIndex((line) => /^ {4}services:\s*$/.test(line));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of bodyLines.slice(start + 1)) {
    if (line.trim() !== "" && indentOf(line) <= 4) break;
    const header = /^ {6}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (header) out.push(header[1] ?? "");
  }
  return out;
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** Pașii de pregătire: aceiași în fiecare job care rulează cod (nu în `check`). */
const SETUP = [
  "uses:actions/checkout@v7",
  "uses:pnpm/action-setup@v6",
  "uses:actions/setup-node@v7",
  "run:pnpm install --frozen-lockfile",
];

const MINIO = "Pornește MinIO (storage S3 de test)";

/**
 * Singurul pas NOU față de vechiul `check`, descoperit la prima rulare reală pe GitHub: serverul E2E (`webServer` din Playwright)
 * pre-randează aplicația pe `ecom_test` ÎNAINTE de `globalSetup`, iar în jobul unic baza exista deja pentru că testele de integrare
 * o creau mai devreme. Cu joburi paralele, `e2e` o creează și o migrează singur, cu aceeași funcție ca `globalSetup`-urile.
 */
const PREPARE_TEST_DB = "Pregătește baza de test E2E (ecom_test, creată și migrată)";

/** Numărul de shard-uri ale proiectului principal `chromium` (matricea din `e2e-chromium` și numitorul din `--shard`). */
const SHARDS = 3;
const E2E_JOBS = ["e2e-chromium", "e2e-isolated", "e2e-s3"];
const REPORT_STEP = "Raport Playwright (la eșec)";
const CHROMIUM_RUN = "Teste E2E (proiectul principal, shard)";
const ISOLATED_RUN = "Teste E2E (proiecte izolate, stare globală și comenzi)";
const S3_RUN = "Test E2E pe S3 (MinIO)";
const CHROMIUM_CMD = `pnpm test:e2e --project=chromium --shard=\${{ matrix.shard }}/${SHARDS}`;
const ISOLATED_CMD =
  "pnpm test:e2e --project=chromium-global-state --project=chromium-orders --no-deps";

/**
 * Pașii de pregătire comuni ai joburilor E2E: fiecare job are propriile servicii și PROPRIA bază de test (`prepareTestDatabase`:
 * serverul E2E se construiește pe `ecom_test` înaintea `globalSetup`), baza aplicației migrată (ca înainte) și propriul MinIO
 * (păstrat peste tot: specurile nu sunt dovedite fără el, iar costul e de câteva secunde).
 */
const E2E_PREPARE: ReadonlyArray<readonly [string, string]> = [
  ["Migrații DB (baza aplicației, pentru build și E2E)", "pnpm --filter @ecom/db db:deploy"],
  [PREPARE_TEST_DB, "prepareTestDatabase"],
  [MINIO, "docker run"],
];
const PLAYWRIGHT_INSTALL: readonly [string, string] = [
  "Instalează browserul Playwright",
  "pnpm exec playwright install --with-deps chromium",
];

/** Pașii de lucru ai vechiului `check`, în ordine, pe jobul căruia îi aparțin acum: [nume, comandă sau `uses`]. */
const WORK: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  "lint-unit": [
    ["Lint (pachete)", "pnpm lint"],
    ["Lint (fișiere din rădăcină și e2e)", "pnpm lint:root"],
    ["Format", "pnpm format:check"],
    ["Typecheck", "pnpm typecheck"],
    ["Teste unitare", "pnpm test"],
  ],
  integration: [
    [MINIO, "docker run"],
    ["Teste de integrare (Postgres + Redis + MinIO)", "pnpm test:integration"],
  ],
  "e2e-chromium": [
    ...E2E_PREPARE,
    PLAYWRIGHT_INSTALL,
    [CHROMIUM_RUN, CHROMIUM_CMD],
    [REPORT_STEP, "actions/upload-artifact@v7"],
  ],
  "e2e-isolated": [
    ...E2E_PREPARE,
    PLAYWRIGHT_INSTALL,
    [ISOLATED_RUN, ISOLATED_CMD],
    [REPORT_STEP, "actions/upload-artifact@v7"],
  ],
  // `pnpm build` (verificarea build-ului de producție, fără harness) rămâne într-un singur job, cel mai scurt.
  "e2e-s3": [
    ...E2E_PREPARE,
    ["Build", "pnpm build"],
    PLAYWRIGHT_INSTALL,
    [S3_RUN, "pnpm test:e2e:s3"],
    [REPORT_STEP, "actions/upload-artifact@v7"],
  ],
};

const WORKER_JOBS = ["lint-unit", "integration", ...E2E_JOBS];

describe("joburile din ci.yml", () => {
  it("există exact lint-unit, integration, e2e-chromium, e2e-isolated, e2e-s3 și check", () => {
    expect(jobs.map((candidate) => candidate.id).sort()).toEqual(["check", ...WORKER_JOBS].sort());
  });

  it("numele verificărilor de stare = id-ul jobului (fără `name:` care l-ar schimba); `check` rămâne exact `check`", () => {
    for (const candidate of jobs) {
      const name = jobField(candidate, "name");
      if (name !== null) expect(name, `jobul ${candidate.id}`).toBe(candidate.id);
    }
    expect(jobs.some((candidate) => candidate.id === "check")).toBe(true);
  });

  it("fiecare job are `runs-on: ubuntu-latest` și `timeout-minutes` între 1 și 35 (vechiul plafon)", () => {
    for (const candidate of jobs) {
      expect(jobField(candidate, "runs-on"), candidate.id).toBe("ubuntu-latest");
      const timeout = Number(jobField(candidate, "timeout-minutes"));
      expect(Number.isInteger(timeout), `${candidate.id}: timeout-minutes lipsește`).toBe(true);
      expect(timeout, candidate.id).toBeGreaterThanOrEqual(1);
      expect(timeout, candidate.id).toBeLessThanOrEqual(35);
    }
  });

  it("joburile de lucru rulează în paralel: niciunul nu are `needs`", () => {
    for (const id of WORKER_JOBS) expect(needsOf(job(id)), id).toEqual([]);
  });
});

describe("pașii vechiului `check`: fiecare apare exact o dată, nimic în plus", () => {
  for (const id of WORKER_JOBS) {
    it(`${id}: pașii de pregătire, apoi exact pașii lui, în ordinea de dinainte`, () => {
      const expected = [...SETUP, ...(WORK[id] ?? []).map(([name]) => name)];
      expect(job(id).steps.map((step) => step.id)).toEqual(expected);
    });
  }

  it("fiecare pas de lucru are comanda de dinainte (nu doar numele)", () => {
    for (const id of WORKER_JOBS) {
      for (const [name, command] of WORK[id] ?? []) {
        const step = job(id).steps.find((candidate) => candidate.name === name);
        expect(step, `${id}: ${name}`).toBeDefined();
        const shown = `${step?.run ?? ""}\n${step?.uses ?? ""}\n${step?.body ?? ""}`;
        expect(shown, `${id}: ${name}`).toContain(command);
      }
    }
  });

  it("pașii vechiului job `e2e` apar în continuare: pregătirea în fiecare job E2E, restul o singură dată", () => {
    const all = WORKER_JOBS.flatMap((id) => job(id).steps.map((step) => step.id));
    const times = (name: string) => all.filter((candidate) => candidate === name).length;
    // MinIO: integration + cele trei joburi E2E; pregătirea E2E și instalarea browserului: în fiecare job E2E.
    expect(times(MINIO)).toBe(1 + E2E_JOBS.length);
    for (const [name] of [...E2E_PREPARE.slice(0, 2), PLAYWRIGHT_INSTALL, [REPORT_STEP]]) {
      expect(times(name ?? ""), name).toBe(E2E_JOBS.length);
    }
    // Build-ul de producție, E2E-ul pe S3 și fiecare rulare Playwright: exact o dată.
    for (const name of ["Build", S3_RUN, CHROMIUM_RUN, ISOLATED_RUN])
      expect(times(name), name).toBe(1);
    // Pașii vechiului «Teste E2E» nu mai există sub acel nume: rulările sunt cele trei de mai sus.
    expect(times("Teste E2E")).toBe(0);
    for (const id of ["lint-unit", "integration"]) {
      for (const [name] of WORK[id] ?? [])
        expect(times(name), name).toBe(name === MINIO ? 1 + E2E_JOBS.length : 1);
    }
  });

  it("pașii de pregătire nu apar în `check` (nu are nimic de instalat)", () => {
    const ids = job("check").steps.map((step) => step.id);
    for (const setup of SETUP) expect(ids).not.toContain(setup);
  });

  it("MinIO: aceeași imagine fixată prin digest, în integration și în fiecare job E2E, nu în lint-unit", () => {
    const digest =
      "cgr.dev/chainguard/minio@sha256:59667194421209c2c1eacbe761e24787e047985c5dfa96b15da9b59fe9b55cd0";
    expect(count(text, digest)).toBe(1 + E2E_JOBS.length);
    expect(job("integration").body).toContain(digest);
    for (const id of E2E_JOBS) expect(job(id).body, id).toContain(digest);
    expect(job("lint-unit").body).not.toContain("minio");
  });
});

describe("serviciile", () => {
  it("lint-unit nu are servicii", () => {
    expect(servicesOf(job("lint-unit"))).toEqual([]);
  });

  it("integration: postgres și redis (testele de integrare nu trimit emailuri prin Mailpit: SMTP-ul lor e simulat)", () => {
    expect(servicesOf(job("integration")).sort()).toEqual(["postgres", "redis"]);
  });

  it("fiecare job E2E: propriile postgres, redis și mailpit (baze separate: shard-urile nu se văd între ele)", () => {
    for (const id of E2E_JOBS) {
      expect(servicesOf(job(id)).sort(), id).toEqual(["mailpit", "postgres", "redis"]);
    }
  });

  it("imaginile rămân fixate la aceleași versiuni, cu aceleași verificări de sănătate", () => {
    const withPostgres = 1 + E2E_JOBS.length;
    expect(count(text, "image: postgres:16.15")).toBe(withPostgres);
    expect(count(text, "image: redis:7.4.11")).toBe(withPostgres);
    expect(count(text, "image: axllent/mailpit:v1.31.4")).toBe(E2E_JOBS.length);
    expect(count(text, "POSTGRES_PASSWORD: ecom_ci")).toBe(withPostgres);
    expect(count(text, '--health-cmd "pg_isready -U ecom -d ecom"')).toBe(withPostgres);
    expect(count(text, '--health-cmd "redis-cli ping"')).toBe(withPostgres);
    expect(count(text, '--health-cmd "/mailpit readyz"')).toBe(E2E_JOBS.length);
    expect(count(text, "- 5432:5432")).toBe(withPostgres);
    expect(count(text, "- 6379:6379")).toBe(withPostgres);
    expect(count(text, "- 1025:1025")).toBe(E2E_JOBS.length);
    expect(count(text, "- 8025:8025")).toBe(E2E_JOBS.length);
  });
});

describe("jobul `check` (agregarea)", () => {
  const check = job("check");
  const script = check.steps.map((step) => step.body).join("\n");

  it("`needs` conține TOATE celelalte joburi, exact", () => {
    const others = jobs.map((candidate) => candidate.id).filter((id) => id !== "check");
    expect([...needsOf(check)].sort()).toEqual([...others].sort());
  });

  it("rulează ÎNTOTDEAUNA (`if: always()`), ca să raporteze și când un job a picat sau a fost anulat", () => {
    expect(jobField(check, "if")).toBe("always()");
  });

  it('pică dacă oricare job nu are rezultatul `success` (verifică rezultatul fiecăruia, cu `!= "success"`)', () => {
    for (const id of WORKER_JOBS) {
      expect(check.body, id).toContain(`needs.${id}.result`);
    }
    const variables = [
      ...check.body.matchAll(
        /^ {6}([A-Z][A-Z0-9_]*):\s*\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}\s*$/gm,
      ),
    ];
    expect(variables.map((match) => match[2]).sort()).toEqual([...WORKER_JOBS].sort());
    for (const match of variables) {
      expect(script, `${match[2]}`).toContain(`[ "$${match[1]}" != "success" ]`);
    }
    expect(script).toContain("exit 1");
  });
});

describe("YAML valid în punctele fragile (testul nu are parser YAML; Prettier din pre-commit și din CI rămâne verificarea completă)", () => {
  it("valorile simple (fără ghilimele) ale lui `name:` nu conțin «: » sau « #» (ar rupe YAML-ul sau l-ar trunchia)", () => {
    for (const line of lines) {
      const match = /^\s*(?:- )?name:\s*(.+)$/.exec(line);
      const value = (match?.[1] ?? "").trim();
      if (value === "" || /^["'|>]/.test(value)) continue;
      expect(value, line.trim()).not.toMatch(/: | #/);
    }
  });

  it("indentare doar cu spații (YAML nu acceptă tab-uri)", () => {
    expect(raw).not.toContain("\t");
  });
});

describe("nimic nu poate fi sărit (docs/20 §5, condiția 4: un job sărit nu e «verde»)", () => {
  it("niciun job în afară de `check` nu are `if` la nivel de job", () => {
    for (const id of WORKER_JOBS) expect(jobField(job(id), "if"), id).toBeNull();
  });

  it("niciun pas nu are `if`, în afară de raportul Playwright (`if: failure()`, în joburile E2E)", () => {
    for (const candidate of jobs) {
      for (const step of candidate.steps) {
        if (E2E_JOBS.includes(candidate.id) && step.name === REPORT_STEP) {
          expect(step.condition).toBe("failure()");
        } else expect(step.condition, `${candidate.id}: ${step.id}`).toBeNull();
      }
    }
  });

  it("fără `paths`, `paths-ignore`, `continue-on-error` în tot fișierul; `strategy` doar în `e2e-chromium`", () => {
    expect(text).not.toMatch(/^\s*paths(-ignore)?:/m);
    expect(text).not.toMatch(/continue-on-error:/);
    expect(text).not.toMatch(/^\s*branches-ignore:/m);
    expect(count(text, "strategy:")).toBe(1);
    for (const candidate of jobs) {
      if (candidate.id === "e2e-chromium") continue;
      expect(candidate.body, candidate.id).not.toMatch(/^\s*(strategy|matrix):/m);
    }
  });
});

describe("matricea de shard-uri din `e2e-chromium`", () => {
  const chromium = job("e2e-chromium");
  const strategy = chromium.body.match(/^ {4}strategy:\n((?: {6,}.*\n?)+)/m)?.[1] ?? "";

  it("`fail-fast: false` (toate shard-urile raportează) și shard-urile 1..N, cu N = numitorul din `--shard`", () => {
    expect(strategy).toMatch(/^ {6}fail-fast: false$/m);
    const list = /^ {8}shard: \[([^\]]*)\]$/m.exec(strategy)?.[1] ?? "";
    expect(list.split(",").map((item) => item.trim())).toEqual(
      Array.from({ length: SHARDS }, (_, index) => String(index + 1)),
    );
    expect(strategy).not.toMatch(/include:|exclude:|max-parallel:/);
  });

  it("rulează doar proiectul principal, cu `--shard=<k>/N`, fără `--no-deps` și fără alte proiecte", () => {
    const run = chromium.steps.find((step) => step.name === CHROMIUM_RUN)?.run ?? "";
    expect(run).toBe(CHROMIUM_CMD);
    expect(run).not.toContain("--no-deps");
  });
});

describe("artefactele Playwright: nume UNICE per job și per shard (upload-artifact v4+ refuză duplicatele)", () => {
  it("fiecare job E2E încarcă un artefact cu nume propriu; cel din matrice poartă numărul shard-ului", () => {
    const names: string[] = [];
    for (const id of E2E_JOBS) {
      const step = job(id).steps.find((candidate) => candidate.name === REPORT_STEP);
      const name = /^\s+name:\s*(\S.*)$/m.exec(
        step?.body.split("\n").slice(1).join("\n") ?? "",
      )?.[1];
      expect(name, id).toBeDefined();
      names.push((name ?? "").trim());
      if (id === "e2e-chromium") expect(name).toContain("${{ matrix.shard }}");
      else expect(name).not.toContain("${{");
    }
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("acoperirea E2E: nimic pierdut, nimic dublat față de rularea locală (`playwright test --list`)", () => {
  const run = promisify(execFile);
  const projectNames = [
    ...readFileSync(join(root, "playwright.config.ts"), "utf8").matchAll(
      /name: "(chromium[\w-]*)"/g,
    ),
  ].map((match) => match[1] ?? "");

  /** Testele (linii `[proiect] › fișier › titlu`) pe care le-ar rula `playwright test <args>`, doar listate: fără server și fără bază. */
  async function listed(args: string[], env: Record<string, string> = {}): Promise<string[]> {
    const { stdout } = await run(
      process.execPath,
      [join(root, "node_modules/@playwright/test/cli.js"), "test", "--list", ...args],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          // doar derivarea numelor bazelor de test (garda «test» din nume); `--list` nu se conectează nicăieri
          DATABASE_URL: "postgresql://ecom:ecom@localhost:5432/ecom",
          TEST_DATABASE_URL: "postgresql://ecom:ecom@localhost:5432/ecom_test",
          REDIS_URL: "redis://localhost:6379",
          TEST_REDIS_URL: "redis://localhost:6379/1",
          TEST_S3_BUCKET: "ecom-test",
          E2E_TARGET: "",
          ...env,
        },
      },
    );
    return stdout
      .split(/\r?\n/)
      .filter((line) => /^\s+\[chromium[\w-]*\] › /.test(line))
      .map((line) => line.trim());
  }

  /** Argumentele Playwright ale unui pas, luate din `ci.yml` (după `pnpm test:e2e`). */
  function argsOf(id: string, stepName: string): string[] {
    const run = job(id).steps.find((step) => step.name === stepName)?.run ?? "";
    return run
      .replace(/^pnpm test:e2e\s*/, "")
      .replace(/\$\{\{\s*matrix\.shard\s*\}\}/g, "${{matrix.shard}}")
      .split(/\s+/)
      .filter((arg) => arg !== "");
  }

  it("proiectele din playwright.config.ts: principal, stare globală, comenzi și S3 (nimic nou necuprins în CI)", () => {
    expect([...new Set(projectNames)].sort()).toEqual(
      ["chromium", "chromium-global-state", "chromium-orders", "chromium-s3"].sort(),
    );
  });

  it(
    "shard-urile + proiectele izolate = TOT ce rulează local (`npm run test:e2e`), fără test pierdut sau dublat; S3 rămâne în jobul S3",
    { timeout: 120_000 },
    async () => {
      const everything = await listed([]);
      const shardMatches = await Promise.all(
        Array.from({ length: SHARDS }, (_, index) =>
          listed(
            argsOf("e2e-chromium", CHROMIUM_RUN).map((arg) =>
              arg.replace("${{matrix.shard}}", String(index + 1)),
            ),
          ),
        ),
      );
      const isolated = await listed(argsOf("e2e-isolated", ISOLATED_RUN));
      const fromCi = [...shardMatches.flat(), ...isolated];

      expect(everything.length).toBeGreaterThan(0);
      expect(new Set(fromCi).size, "un test apare de două ori în joburile din CI").toBe(
        fromCi.length,
      );
      expect(fromCi.length).toBe(everything.length);
      expect([...fromCi].sort()).toEqual([...everything].sort());
      for (const shard of shardMatches) expect(shard.length).toBeGreaterThan(0);
      expect(isolated.length).toBeGreaterThan(0);
      expect(isolated.every((line) => /^\[chromium-(global-state|orders)\]/.test(line))).toBe(true);
      expect(shardMatches.flat().every((line) => line.startsWith("[chromium]"))).toBe(true);

      // S3: `pnpm test:e2e:s3` (E2E_TARGET=s3) rulează DOAR proiectul S3, care nu intră în rularea locală obișnuită.
      expect(job("e2e-s3").steps.find((step) => step.name === S3_RUN)?.run).toBe(
        "pnpm test:e2e:s3",
      );
      const s3 = await listed([], { E2E_TARGET: "s3" });
      expect(s3.length).toBeGreaterThan(0);
      expect(s3.every((line) => line.startsWith("[chromium-s3]"))).toBe(true);
      expect(everything.some((line) => line.startsWith("[chromium-s3]"))).toBe(false);
    },
  );
});

describe("neschimbat: triggere, concurență, mediu «doar CI»", () => {
  it("triggere: push pe main, faza-*, redesign-* și orice pull_request", () => {
    expect(text).toMatch(
      /^on:\n {2}push:\n {4}branches: \[main, "faza-\*", "redesign-\*"\]\n {2}pull_request:\n/m,
    );
  });

  it("grupul de concurență `ci-${{ github.ref }}` cu cancel-in-progress", () => {
    expect(text).toMatch(
      /^concurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true\n/m,
    );
  });

  it("valorile de mediu «doar CI» sunt aceleași, o singură dată, la nivel de workflow (toate joburile le văd ca înainte)", () => {
    const expected: Record<string, string> = {
      APP_URL: "http://localhost:3100",
      APP_KEY: "Y2ktb25seS1hcHAta2V5LTMyLWJ5dGVzLWxvbmctISE=",
      DATABASE_URL: "postgresql://ecom:ecom_ci@localhost:5432/ecom",
      REDIS_URL: "redis://localhost:6379",
      TEST_DATABASE_URL: "postgresql://ecom:ecom_ci@localhost:5432/ecom_test",
      TEST_REDIS_URL: "redis://localhost:6379/1",
      STORAGE_DRIVER: "local",
      S3_ENDPOINT: "http://localhost:9000",
      S3_REGION: "us-east-1",
      S3_BUCKET: "ecom",
      S3_ACCESS_KEY_ID: "ecom_minio",
      S3_SECRET_ACCESS_KEY: "ecom_minio_ci",
      S3_FORCE_PATH_STYLE: '"true"',
      TEST_S3_BUCKET: "ecom-test",
    };
    const start = lines.findIndex((line) => /^env:\s*$/.test(line));
    expect(start, "lipsește `env:` la nivel de workflow").toBeGreaterThanOrEqual(0);
    const actual: Record<string, string> = {};
    for (const line of lines.slice(start + 1)) {
      if (line.trim() !== "" && indentOf(line) === 0) break;
      const match = /^ {2}([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line);
      if (match) actual[match[1] ?? ""] = (match[2] ?? "").trim();
    }
    expect(actual).toEqual(expected);
    for (const id of WORKER_JOBS) {
      expect(
        jobField(job(id), "env"),
        `${id}: fără env propriu, ca valorile să nu difere`,
      ).toBeNull();
    }
  });

  it("versiunile acțiunilor sunt cele fixate", () => {
    const withCode = WORKER_JOBS.length;
    expect(count(text, "uses: actions/checkout@v7")).toBe(withCode);
    expect(count(text, "uses: pnpm/action-setup@v6")).toBe(withCode);
    expect(count(text, "uses: actions/setup-node@v7")).toBe(withCode);
    expect(count(text, "uses: actions/upload-artifact@v7")).toBe(E2E_JOBS.length);
    expect(count(text, 'node-version: ">=24.7.0 <25"')).toBe(withCode);
    expect(count(text, "cache: pnpm")).toBe(withCode);
  });
});
