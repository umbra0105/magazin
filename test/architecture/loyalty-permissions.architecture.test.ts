import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Permisiunile ecranelor, acțiunilor și rutei punctelor de loialitate (Faza 15b), pe sursa reală: fiecare cere EXACT permisiunea
 * lui și flag-ul `loyalty`. Verificarea de comportament e în testele de integrare ale serviciului și în `e2e/loyalty.spec.ts`;
 * aici se prinde o permisiune schimbată sau scoasă din greșeală. `findProblems` e pură și testată cu mutanți.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8");

interface Guard {
  path: string;
  /** Fiecare tipar trebuie să existe în fișier. */
  needs: readonly RegExp[];
}

const page = (path: string, permission: string): Guard => ({
  path: `apps/web/src/app/(admin)/admin/${path}/page.tsx`,
  needs: [new RegExp(`requireAdmin\\(\\{ permission: "${permission}", feature: "loyalty" \\}\\)`)],
});
const action = (path: string, name: string, permission: string): Guard => ({
  path: `apps/web/src/app/(admin)/admin/${path}/actions.ts`,
  needs: [
    new RegExp(`export const ${name} = withPermission\\(\\s*"${permission}"`),
    /isEnabled\("loyalty"\)/,
  ],
});

const GUARDS: readonly Guard[] = [
  page("clienti/puncte", "loyalty.view"),
  page("clienti/puncte/[id]", "loyalty.view"),
  page("clienti/puncte/datorie", "loyalty.view"),
  page("setari/puncte", "loyalty.configure"),
  action("clienti/puncte", "adjustLoyaltyPoints", "loyalty.adjust"),
  action("setari/puncte", "saveLoyaltySettings", "loyalty.configure"),
  {
    path: "apps/web/src/app/api/admin/loyalty/debt/route.ts",
    needs: [/!subject \|\| !can\(subject, "loyalty\.view"\)/, /isEnabled\("loyalty"\)/],
  },
  {
    path: "apps/web/src/app/(storefront)/cont/puncte/page.tsx",
    needs: [/requireFeature\("loyalty"\)/, /requireCustomer\(/],
  },
];

export function findProblems(guard: Guard, content: string): string[] {
  return guard.needs
    .filter((pattern) => !pattern.test(content))
    .map((pattern) => `${guard.path}: lipsește ${pattern.source}`);
}

describe("permisiunile punctelor de loialitate", () => {
  for (const guard of GUARDS) {
    it(`${guard.path} cere permisiunea și flag-ul lui`, () => {
      expect(findProblems(guard, read(guard.path))).toEqual([]);
    });

    it(`mutant: permisiunea sau flag-ul schimbate în ${guard.path} sunt prinse`, () => {
      const original = read(guard.path);
      for (const mutate of [
        (s: string) => s.replace(/loyalty\.(view|adjust|configure)/g, "admin.access"),
        (s: string) => s.replace(/(isEnabled|requireFeature|feature: )\(?"loyalty"/g, '$1"blog"'),
      ]) {
        const mutated = mutate(original);
        if (mutated !== original) expect(findProblems(guard, mutated)).not.toEqual([]);
      }
    });
  }
});
