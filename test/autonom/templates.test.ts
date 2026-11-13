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

describe("docs/AUTONOM-APROBARI.md", () => {
  const text = read("docs/AUTONOM-APROBARI.md");

  it("listează fiecare fază de modul B sau C, în așteptare, și nicio fază de modul A", () => {
    for (const [phase, mode] of Object.entries(PHASE_MODES)) {
      const line = new RegExp(`^- Faza ${phase}: în așteptare`, "m");
      if (mode === "A")
        expect(text, `faza ${phase} (A)`).not.toMatch(new RegExp(`^- Faza ${phase}:`, "m"));
      else expect(text, `faza ${phase} (${mode})`).toMatch(line);
    }
  });

  it("șablonul nu aprobă nicio fază (aprobarea o scrie utilizatorul)", () => {
    for (const phase of Object.keys(PHASE_MODES)) {
      expect(isApproved(text, phase), phase).toBe(false);
    }
  });

  it("spune că aprobarea o scrie utilizatorul, nu Claude Code, și arată formatul", () => {
    expect(text).toContain("Claude Code nu scrie și nu schimbă aprobările");
    expect(text).toContain("- Faza 9: aprobat");
    expect(text).toContain("docs/20");
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
