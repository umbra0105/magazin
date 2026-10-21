import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Refuzurile de server actions scriu în `audit_log` (append-only). Fără limită, un anonim le poate umple (Blocul C, C-08):
 * `onDenied` din `withPermission` trebuie să treacă prin `DeniedAuditGate` ÎNAINTE de `recordDeniedAttempt`.
 * Citește sursa ca text; `findUngatedDeniedAudit` e pură.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export function findUngatedDeniedAudit(content: string): string[] {
  const start = content.indexOf("onDenied");
  if (start < 0) return ["session.ts nu definește onDenied"];
  const record = content.indexOf("recordDeniedAttempt(", start);
  if (record < 0) return ["onDenied nu înregistrează refuzurile"];
  const gate = content.indexOf(".decide(", start);
  if (gate < 0 || gate > record) return ["onDenied scrie în audit fără DeniedAuditGate.decide"];
  return [];
}

describe("refuzurile de acțiuni trec prin DeniedAuditGate", () => {
  it("detectează o scriere fără poartă sau cu poarta după scriere", () => {
    expect(findUngatedDeniedAudit("onDenied: (a) => recordDeniedAttempt(audit, a)")).toEqual([
      "onDenied scrie în audit fără DeniedAuditGate.decide",
    ]);
    expect(
      findUngatedDeniedAudit("onDenied: async (a) => { recordDeniedAttempt(x); gate.decide(y); }"),
    ).toHaveLength(1);
    expect(
      findUngatedDeniedAudit(
        "onDenied: async (a) => { if ((await gate.decide(y)) !== 'skip') recordDeniedAttempt(x); }",
      ),
    ).toEqual([]);
  });

  it("apps/web/src/lib/session.ts respectă regula", () => {
    const source = readFileSync(`${root}apps/web/src/lib/session.ts`, "utf8");
    expect(findUngatedDeniedAudit(source)).toEqual([]);
  });
});
