import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isApproved } from "../../scripts/autonom/aprobari";
import { blockingEntries, parseFinisaje } from "../../scripts/autonom/finisaje";
import { PHASE_MODES } from "../../scripts/autonom/phases";

/** Șabloanele modului autonom (docs/20 §8) se citesc cu aceleași funcții ca poarta: un șablon pe care poarta nu-l poate citi pică aici. */
const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");

describe("fișierele de lucru ale modului autonom există", () => {
  it("docs/AUTONOM-LOG.md, docs/FINISAJE.md, docs/AUTONOM-APROBARI.md", () => {
    for (const file of ["docs/AUTONOM-LOG.md", "docs/FINISAJE.md", "docs/AUTONOM-APROBARI.md"]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
  });
});

describe("docs/FINISAJE.md", () => {
  it("șablonul nu are nicio intrare deschisă care să blocheze poarta (exemplele sunt în bloc de cod)", () => {
    expect(blockingEntries(parseFinisaje(read("docs/FINISAJE.md")))).toEqual([]);
  });

  it("explică formatul pe care îl citește poarta: «- [ ] S3 | ecran | problemă | captură»", () => {
    const text = read("docs/FINISAJE.md");
    expect(text).toContain("- [ ] S3 | ");
    expect(text).toMatch(/S1|S2/);
    expect(text).toContain("docs/20");
  });
});

/**
 * Liniile de stare `- Faza N: <stare>` din afara blocurilor de cod (exemplele din blocuri nu contează, ca în `isApproved`).
 * Structura fișierului se verifică pe fișierul real; STAREA fiecărei faze (în așteptare, aprobat, retras) NU: aprobarea o
 * scrie utilizatorul pe `main`, deci fișierul real nu are voie să fie presupus «fără aprobări».
 */
const STATUS_LINE = /^\s*[-*]\s*Faza\s+(\S+?)\s*:\s*(.*)$/i;
const KNOWN_STATE = /^(aprobat|în așteptare|neaprobat|retras)(?![\p{L}\p{N}])/iu;

function statusLines(markdown: string): Array<{ phase: string; rest: string }> {
  const found: Array<{ phase: string; rest: string }> = [];
  let inFence = false;
  for (const raw of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    const match = inFence ? null : STATUS_LINE.exec(raw);
    if (match) found.push({ phase: (match[1] ?? "").toLowerCase(), rest: (match[2] ?? "").trim() });
  }
  return found;
}

describe("docs/AUTONOM-APROBARI.md: structura (nu starea)", () => {
  const text = read("docs/AUTONOM-APROBARI.md");
  const lines = statusLines(text);

  it("fiecare fază de modul B sau C apare cel puțin o dată ca «- Faza N: …», iar fazele de modul A nu apar", () => {
    for (const [phase, mode] of Object.entries(PHASE_MODES)) {
      const count = lines.filter((line) => line.phase === phase.toLowerCase()).length;
      if (mode === "A") expect(count, `faza ${phase} (A)`).toBe(0);
      else expect(count, `faza ${phase} (${mode})`).toBeGreaterThanOrEqual(1);
    }
  });

  it("fiecare linie «- Faza N:» are un format valid: starea e un cuvânt recunoscut (aprobat, în așteptare, neaprobat, retras)", () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(KNOWN_STATE.test(line.rest), `Faza ${line.phase}: ${line.rest}`).toBe(true);
    }
  });

  it("nicio linie de stare nu e pentru o fază necunoscută (poarta nu trece o fază care nu e în tabel)", () => {
    const known = new Set(Object.keys(PHASE_MODES).map((phase) => phase.toLowerCase()));
    for (const line of lines) expect(known.has(line.phase), `Faza ${line.phase}`).toBe(true);
  });

  it("spune că aprobarea o scrie utilizatorul, nu Claude Code, și arată formatul", () => {
    expect(text).toContain("Claude Code nu scrie și nu schimbă aprobările");
    expect(text).toContain("- Faza 9: aprobat");
    expect(text).toContain("docs/20");
  });
});

describe("isApproved pe texte-exemplu (nu pe fișierul real, a cărui stare o schimbă utilizatorul)", () => {
  it("«în așteptare», «neaprobat» și «retras» nu aprobă faza", () => {
    for (const state of ["în așteptare", "neaprobat", "retras, 2026-12-02, o problemă la TVA"]) {
      expect(isApproved(`- Faza 6: ${state}`, "6"), state).toBe(false);
    }
  });

  it("«aprobat» pe prima poziție după două puncte aprobă faza (cu dată și notă după el)", () => {
    expect(isApproved("- Faza 6: aprobat", "6")).toBe(true);
    expect(isApproved("- Faza 6: aprobat, 2026-11-16, vitrina verificată", "6")).toBe(true);
    // «aprobat» în altă poziție nu aprobă
    expect(isApproved("- Faza 6: nu e aprobat", "6")).toBe(false);
  });

  it("aprobarea unei faze nu aprobă alta, iar celelalte faze din fișier rămân în așteptare", () => {
    const text = "- Faza 6: aprobat, 2026-11-16\n- Faza 7: în așteptare\n- Faza 18: în așteptare";
    expect(isApproved(text, "6")).toBe(true);
    expect(isApproved(text, "7")).toBe(false);
    expect(isApproved(text, "18")).toBe(false);
  });

  it("ultima linie a fazei decide (exemplul din docs/AUTONOM-APROBARI.md: aprobat, apoi retras)", () => {
    const example = [
      "- Faza 9: aprobat, 2026-12-01, verificat comanda cu ramburs",
      "- Faza 9: retras, 2026-12-02, am găsit o problemă la TVA",
    ].join("\n");
    expect(isApproved(example, "9")).toBe(false);
    expect(isApproved(`${example}\n- Faza 9: aprobat, 2026-12-03, rezolvat`, "9")).toBe(true);
  });

  it("exemplele din blocurile de cod nu aprobă nimic", () => {
    expect(isApproved("```\n- Faza 9: aprobat, 2026-12-01\n```", "9")).toBe(false);
  });

  it("structura se verifică și pe un fișier aprobat: B și C apar, liniile au format valid", () => {
    const approved = [
      "Modul C:",
      "",
      "- Faza 6: aprobat, 2026-11-16, vitrina verificată",
      "- Faza 7: în așteptare",
    ].join("\n");
    const lines = statusLines(approved);
    expect(lines.map((line) => line.phase)).toEqual(["6", "7"]);
    for (const line of lines) expect(KNOWN_STATE.test(line.rest)).toBe(true);
    expect(KNOWN_STATE.test("a fost aprobat")).toBe(false);
    expect(KNOWN_STATE.test("aprobatul")).toBe(false);
  });
});

describe("docs/AUTONOM-LOG.md", () => {
  const text = read("docs/AUTONOM-LOG.md");

  it("are antetul tabelului cu o linie per pas și arată exemplul", () => {
    // antetul apare de două ori: la «Format» și la «Jurnal» (unde se adaugă liniile)
    expect(text.split("| data | faza | pas | commit | verificare | S3 notate |").length - 1).toBe(
      2,
    );
    expect(text).toContain("docs/20");
  });

  it("cere notarea copiei bazei (calea se notează la începutul fiecărei faze)", () => {
    expect(text).toContain("**copie bază**");
  });
});
