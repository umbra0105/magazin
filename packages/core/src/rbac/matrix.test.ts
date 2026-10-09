import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROLES } from "./catalog";
import { RBAC_MATRIX_END, RBAC_MATRIX_START, renderRoleMatrix } from "./matrix";

const DOC = fileURLToPath(new URL("../../../../docs/04-backend-admin.md", import.meta.url));

describe("matricea rol × permisiune", () => {
  it("cele 7 roluri de sistem au admin.access", () => {
    expect(DEFAULT_ROLES).toHaveLength(7);
    for (const role of DEFAULT_ROLES) {
      expect(role.permissions, role.key).toContain("admin.access");
    }
  });

  it("tabelul din docs/04 §6 este identic cu cel generat din catalog", () => {
    const doc = readFileSync(DOC, "utf8").replace(/\r\n/g, "\n");
    const start = doc.indexOf(RBAC_MATRIX_START);
    const end = doc.indexOf(RBAC_MATRIX_END);
    expect(start, "marcajul de început lipsește din docs/04").toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const inDoc = doc.slice(start + RBAC_MATRIX_START.length, end).trim();
    // Dacă pică: înlocuiește conținutul dintre marcaje cu valoarea de mai jos ("received").
    expect(inDoc).toBe(renderRoleMatrix());
  });
});
