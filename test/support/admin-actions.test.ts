import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findAdminActionViolations } from "./admin-actions-check";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo", "dist", "coverage", "generated"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Fișierele de server actions din zona de admin: cele cu `"use server"` sau numite `*actions.ts(x)`. */
export function adminActionFiles(): string[] {
  return walk(join(REPO_ROOT, "apps", "web", "src"))
    .filter((file) => file.split(sep).includes("(admin)"))
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .filter(
      (file) =>
        /(^|[.-])actions\.tsx?$/.test(file.split(sep).pop() ?? "") ||
        /^\s*["']use server["']/m.test(readFileSync(file, "utf8")),
    );
}

const IMPORT = `import { withPermission } from "@/lib/session";\n`;

describe("acțiunile de admin sunt toate împachetate cu withPermission", () => {
  it("fișierele reale de actions din (admin) respectă regula", () => {
    const problems = adminActionFiles().flatMap((file) =>
      findAdminActionViolations(file, readFileSync(file, "utf8")).map(
        (v) => `${relative(REPO_ROOT, file)}:${v.line} ${v.message}`,
      ),
    );
    expect(problems).toEqual([]);
  });

  describe("verificatorul (pe fișiere de probă)", () => {
    const check = (src: string) => findAdminActionViolations("actions.ts", src);

    it("acceptă acțiuni împachetate și tipuri exportate", () => {
      const src =
        `"use server";\n${IMPORT}` +
        `export const saveTax = withPermission("settings.write", async (input: number) => input);\n` +
        `export const archive = withPermission("products.archive", async () => 1);\n` +
        `export type Result = { ok: boolean };\n` +
        `const helper = () => 1;\nfunction internal() {}\n`;
      expect(check(src)).toEqual([]);
    });

    it("pică pe o funcție exportată direct", () => {
      const src = `"use server";\n${IMPORT}export async function deleteProduct(id: string) {}\n`;
      expect(check(src)).toHaveLength(1);
    });

    it("pică pe o constantă exportată fără withPermission", () => {
      const src = `"use server";\n${IMPORT}export const deleteProduct = async (id: string) => {};\n`;
      expect(check(src).map((v) => v.message)).toEqual([
        expect.stringContaining('"deleteProduct" nu este împachetat'),
      ]);
    });

    it("pică pe export default și pe re-exporturi de valori", () => {
      expect(
        check(
          `${IMPORT}const a = withPermission("orders.read", async () => 1);\nexport default a;\n`,
        ),
      ).toHaveLength(1);
      expect(
        check(`${IMPORT}const a = withPermission("orders.read", async () => 1);\nexport { a };\n`),
      ).toHaveLength(1);
      expect(check(`${IMPORT}export * from "./other";\n`)).toHaveLength(1);
    });

    it("acceptă re-exportul doar de tipuri", () => {
      expect(check(`${IMPORT}export type { Foo } from "./other";\n`)).toEqual([]);
    });

    it("pică dacă withPermission e definit local (un wrapper fals)", () => {
      const src =
        `const withPermission = (_p: string, h: () => unknown) => h;\n` +
        `export const wipe = withPermission("system.update", () => 1);\n`;
      expect(check(src).map((v) => v.message)).toContainEqual(
        expect.stringContaining("importat din"),
      );
    });

    it("pică dacă withPermission lipsește din import", () => {
      const src = `export const wipe = withPermission("system.update", async () => 1);\n`;
      expect(check(src).map((v) => v.message)).toContainEqual(
        expect.stringContaining("importat din"),
      );
    });

    it("pică pe o constantă care doar sună a withPermission (apel pe alt obiect)", () => {
      const src = `${IMPORT}export const x = other.withPermission("orders.read", async () => 1);\n`;
      expect(check(src)).not.toEqual([]);
    });
  });
});
