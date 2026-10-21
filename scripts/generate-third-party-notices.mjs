// Generează THIRD-PARTY-NOTICES.md: pachetele de PRODUCȚIE din workspace, cu licență și textul licenței.
// Rulare (din rădăcina repo-ului, după `pnpm install`):  node scripts/generate-third-party-notices.mjs
// Fișierul se regenerează la fiecare schimbare de dependențe de producție.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

/** Numele pachetelor din workspace (apps/* și packages/*). */
function workspaceNames() {
  const names = [];
  for (const base of ["apps", "packages"]) {
    if (!existsSync(join(root, base))) continue;
    for (const dir of readdirSync(join(root, base))) {
      const file = join(root, base, dir, "package.json");
      if (existsSync(file)) names.push(JSON.parse(readFileSync(file, "utf8")).name);
    }
  }
  return names;
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const packages = new Map();
for (const name of workspaceNames()) {
  const out = execFileSync(pnpm, ["licenses", "list", "--prod", "--json", "--filter", name], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const byLicense = JSON.parse(out || "{}");
  for (const [license, list] of Object.entries(byLicense)) {
    for (const entry of list) {
      for (const [index, version] of entry.versions.entries()) {
        const key = `${entry.name}@${version}`;
        if (packages.has(key)) continue;
        packages.set(key, {
          name: entry.name,
          version,
          license,
          homepage: entry.homepage ?? "",
          path: entry.paths[index] ?? entry.paths[0],
        });
      }
    }
  }
}

const LICENSE_FILE = /^(licen[sc]e|licen[sc]ing|copying|notice)(\.[a-z]+)?$/i;
const read = (pkg) => {
  const texts = [];
  if (!pkg.path || !existsSync(pkg.path)) return texts;
  for (const file of readdirSync(pkg.path)) {
    if (LICENSE_FILE.test(file)) {
      texts.push({ file, text: readFileSync(join(pkg.path, file), "utf8").trim() });
    }
  }
  return texts;
};

const sorted = [...packages.values()].sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
);
const counts = new Map();
for (const pkg of sorted) counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1);

const lines = [];
lines.push("# Note despre componentele terțe (THIRD-PARTY NOTICES)", "");
lines.push(
  "Acest fișier este GENERAT (`node scripts/generate-third-party-notices.mjs`) din pachetele de producție ale workspace-ului și se regenerează la fiecare schimbare de dependențe. Nu este un aviz juridic.",
  "",
  "> **De arătat unui avocat înainte de vânzare.** Produsul se distribuie către clienți; cerințele de atribuire și de licență de mai jos (în special LGPL, CC-BY și FSL) trebuie validate juridic și livrate împreună cu produsul.",
  "",
);
lines.push("## Licențe care cer atenție", "");
lines.push(
  "- **LGPL-3.0-or-later — `libvips` (în binarele `@img/sharp-*`, dependență a lui `sharp`).** Pachetele `@img/sharp-<platformă>` poartă licența `Apache-2.0 AND LGPL-3.0-or-later` (biblioteca nativă libvips e LGPL). Se instalează din npm pe serverul clientului, ca bibliotecă dinamică separată, nemodificată de noi; trebuie păstrate nota de licență și posibilitatea înlocuirii bibliotecii. Setul exact de pachete `@img/*` depinde de platforma pe care se instalează (această listă a fost generată pe " +
    process.platform +
    ").",
  "- **CC-BY-4.0 — `caniuse-lite`.** Date, cu cerință de atribuire (autor: Ben Briggs / proiectul Browserslist, https://github.com/browserslist/caniuse-lite); textul licenței este mai jos.",
  "- **FSL-1.1-Apache-2.0 (Functional Source License) — pachetul `sentry` (Sentry CLI).** NU este SDK-ul `@sentry/nextjs` (MIT). Este instrumentul în linie de comandă adus de `@sentry/bundler-plugins`, folosit la build pentru încărcarea de source maps (neutilizat aici: nu se configurează `authToken`). Licența FSL este „source-available”: permite orice utilizare în afară de oferirea unui produs concurent cu Sentry și se convertește în Apache-2.0 după 2 ani de la publicarea fiecărei versiuni. Magazinul nu concurează cu Sentry, dar acesta este un termen de licență care trebuie validat juridic, iar pachetul poate fi exclus din instalarea de producție dacă nu se folosește încărcarea de source maps.",
  "- **MPL-2.0 — `lightningcss`, `axe-core` (doar dezvoltare/test, nu se livrează în producție).**",
  "- **MIT-0 — `nodemailer`; BlueOak-1.0.0 — `glob`, `lru-cache`, `minimatch`, `minipass`, `path-scurry`; 0BSD — `tslib`.**",
  "",
);
// Binare native opționale (alte platforme decât cea pe care s-a rulat scriptul): din lockfile
const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
const optional = [
  ...new Set(
    [...lock.matchAll(/^ {2}'?(@img\/sharp-[a-z0-9-]+)@([0-9][^':\s]*)'?:/gm)].map(
      (m) => `${m[1]}@${m[2]}`,
    ),
  ),
].sort();
lines.push("## Binare native opționale ale lui sharp (din lockfile)", "");
lines.push(
  "Pachetele `@img/sharp-<platformă>` (și `@img/sharp-libvips-<platformă>`) se instalează doar pe platforma potrivită. Conform documentației `sharp`, `@img/sharp-*` sunt `Apache-2.0 AND LGPL-3.0-or-later`, iar `@img/sharp-libvips-*` sunt `LGPL-3.0-or-later`. Licența a fost verificată direct în `package.json` doar pentru pachetul instalat pe mașina de generare; pentru celelalte platforme se bazează pe documentația `sharp` (de reverificat la livrare).",
  "",
);
for (const name of optional) lines.push(`- ${name}`);
lines.push("");
lines.push("## Rezumat pe licențe", "", "| Licență | Pachete |", "|---|---|");
for (const [license, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`| ${license} | ${count} |`);
}
lines.push("", `Total: ${sorted.length} de pachete (nume și versiune unice).`, "");
lines.push("## Pachete și texte de licență", "");
const seen = new Map();
for (const pkg of sorted) {
  lines.push(`### ${pkg.name}@${pkg.version}`, "");
  lines.push(`- Licență: ${pkg.license}`);
  if (pkg.homepage) lines.push(`- Pagina: ${pkg.homepage}`);
  const texts = read(pkg);
  if (texts.length === 0)
    lines.push(
      "- Text de licență: nu există un fișier de licență în pachet (licența declarată mai sus).",
    );
  for (const { file, text } of texts) {
    const prior = seen.get(text);
    if (prior) {
      lines.push(`- ${file}: identic cu al pachetului ${prior}.`);
    } else {
      seen.set(text, `${pkg.name}@${pkg.version}`);
      lines.push(
        "",
        `<details><summary>${file}</summary>`,
        "",
        "```text",
        text,
        "```",
        "",
        "</details>",
      );
    }
  }
  lines.push("");
}

writeFileSync(join(root, "THIRD-PARTY-NOTICES.md"), lines.join("\n"));
console.log(
  `THIRD-PARTY-NOTICES.md: ${sorted.length} pachete, ${seen.size} texte de licență distincte`,
);
