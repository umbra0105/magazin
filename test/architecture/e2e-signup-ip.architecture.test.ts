import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Testele E2E nu au voie să se înregistreze toate de la ACELAȘI IP.
 *
 * În suita E2E, `auth.trustedProxyHops = 1` și Next completează `X-Forwarded-For` cu IP-ul socketului când lipsește,
 * deci toate conturile create fără antet ajung în același coș de limitare `register-ip:::1`. Limita e 100 pe oră (maximul
 * permis de registru), iar o rulare curată creează exact 100 de conturi: zero rezervă. Orice reîncercare (CI are 2) sau
 * test nou depășește 100 și următoarea înregistrare primește 429 `AUTH_RATE_LIMITED`, cu eșecuri în lanț, intermitente
 * (incidentul de la `488d2ea`, reprodus local). De aceea fiecare înregistrare din E2E trimite propriul `X-Forwarded-For`
 * (`uniqueClientIp()`), ca limita pe IP să se aplice per cont, nu per suită.
 *
 * Citește sursa ca text; `findSignUpViolations` e pură și testată pe fișiere sintetice.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

const SIGN_UP = "/api/auth/sign-up/email";

/** Textul apelului care începe la `start` (până la `});` care îl încheie, cu o limită de siguranță). */
function callText(content: string, start: number): string {
  const end = content.indexOf("});", start);
  return content.slice(start, end < 0 ? start + 600 : Math.min(end + 3, start + 800));
}

export function findSignUpViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    let from = 0;
    for (;;) {
      const at = file.content.indexOf(SIGN_UP, from);
      if (at < 0) break;
      from = at + SIGN_UP.length;
      const call = callText(file.content, at);
      const line = file.content.slice(0, at).split("\n").length;
      if (!/["']x-forwarded-for["']\s*:\s*uniqueClientIp\(\)/i.test(call)) {
        problems.push(
          `${file.path}:${line}: înregistrarea nu trimite \`"x-forwarded-for": uniqueClientIp()\` (toate conturile ar împărți același IP)`,
        );
      }
    }
  }
  return problems;
}

const file = (path: string, content: string): SourceFile => ({ path, content });

describe("înregistrările din E2E au IP propriu (cazuri sintetice)", () => {
  it("prinde o înregistrare fără antetul X-Forwarded-For", () => {
    const code = [
      "const response = await request.post(`${baseURL}/api/auth/sign-up/email`, {",
      "  headers: { origin: baseURL },",
      '  data: { name: "Cont E2E", email, password },',
      "});",
    ].join("\n");
    expect(findSignUpViolations([file("e2e/x.spec.ts", code)])).toHaveLength(1);
  });

  it("prinde un antet cu valoare fixă (același IP pentru toate)", () => {
    const code =
      'await request.post(`${b}/api/auth/sign-up/email`, { headers: { origin: b, "x-forwarded-for": "10.0.0.1" }, data: {} });';
    expect(findSignUpViolations([file("e2e/x.spec.ts", code)])).toHaveLength(1);
  });

  it("acceptă antetul cu IP unic, în orice ordine a cheilor", () => {
    const a =
      'await request.post(`${b}/api/auth/sign-up/email`, { headers: { origin: b, "x-forwarded-for": uniqueClientIp() }, data: {} });';
    const b2 =
      'await request.post(`${b}/api/auth/sign-up/email`, { data: {}, headers: { "x-forwarded-for": uniqueClientIp(), origin: b } });';
    expect(findSignUpViolations([file("e2e/a.spec.ts", a), file("e2e/b.spec.ts", b2)])).toEqual([]);
  });

  it("numără fiecare înregistrare dintr-un fișier", () => {
    const bad =
      "x(`/api/auth/sign-up/email`, { headers: {} });\nx(`/api/auth/sign-up/email`, { headers: {} });";
    expect(findSignUpViolations([file("e2e/x.spec.ts", bad)])).toHaveLength(2);
  });
});

describe("înregistrările din E2E au IP propriu (sursa reală)", () => {
  const dir = join(root, "e2e");
  const specs = readdirSync(dir)
    .filter((name) => name.endsWith(".spec.ts"))
    .map((name) => file(`e2e/${name}`, readFileSync(join(dir, name), "utf8")));

  it("scanează specurile reale și găsește înregistrări", () => {
    expect(specs.length).toBeGreaterThan(10);
    const total = specs.reduce((n, f) => n + f.content.split(SIGN_UP).length - 1, 0);
    expect(total).toBeGreaterThan(10);
  });

  it("fiecare înregistrare din e2e/ trimite un X-Forwarded-For unic", () => {
    expect(findSignUpViolations(specs)).toEqual([]);
  });
});
