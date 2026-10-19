import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test de arhitectură pentru SSRF (punctul 15b): în folderele de import și de media, SINGURA cale către rețea e
 * `safeFetchImage` din `media/safe-fetch.ts`. Orice `fetch`, `http(s).request`, `net`, `tls`, `dns`, `axios`,
 * `undici`, WebSocket etc. în afara lui pică testul, ca nimeni să nu ocolească verificările (listă de domenii,
 * IP public, redirecturi, limite) cu o cerere „rapidă” făcută direct.
 *
 * Al doilea test: verificările nu au comutator. Fișierele care le conțin nu citesc `process.env` / `NODE_ENV`
 * și fabrica de producție leagă `safeFetchImage` fără parametri de dezactivare.
 *
 * Citește sursa ca text; `findNetworkViolations` e pură și testată pe fișiere sintetice, ca testul să nu poată
 * trece „în gol”.
 */

const root = fileURLToPath(new URL("../../../../", import.meta.url));

export interface SourceFile {
  path: string;
  content: string;
}

/** Folderele în care nicio cerere de rețea nu se face în afara fișierului permis. */
export const GUARDED_DIRS = [
  "packages/core/src/media",
  "packages/core/src/catalog/import",
] as const;

/** Singurul fișier care are voie să atingă rețeaua. */
export const ALLOWED_FILE = "packages/core/src/media/safe-fetch.ts";

const NODE_NETWORK =
  "(?:node:)?(?:https?|http2|net|tls|dgram|dns(?:/promises)?|child_process|cluster)";
const NETWORK_LIBS =
  "(?:axios|undici|got|node-fetch|cross-fetch|isomorphic-fetch|ofetch|ky|superagent|needle|request|socket\\.io-client|ws)";

const RULES: readonly { name: string; re: RegExp }[] = [
  { name: "apel fetch(...)", re: /(?<![\w.$])fetch\s*\(/ },
  { name: "globalThis.fetch / window.fetch", re: /\b(?:globalThis|window|self)\s*\.\s*fetch\b/ },
  { name: "import de modul de rețea din Node", re: new RegExp(`from\\s+["']${NODE_NETWORK}["']`) },
  {
    name: "require de modul de rețea din Node",
    re: new RegExp(`require\\(\\s*["']${NODE_NETWORK}["']\\s*\\)`),
  },
  {
    name: "import() de modul de rețea din Node",
    re: new RegExp(`import\\(\\s*["']${NODE_NETWORK}["']\\s*\\)`),
  },
  { name: "bibliotecă HTTP", re: new RegExp(`from\\s+["']${NETWORK_LIBS}["']`) },
  { name: "XMLHttpRequest", re: /\bXMLHttpRequest\b/ },
  { name: "WebSocket / EventSource", re: /\bnew\s+(?:WebSocket|EventSource)\b/ },
];

/** Elimină comentariile (pe rând și bloc), ca textul din documentație să nu declanșeze regulile. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * Singura importare permisă dintr-un modul de rețea: funcțiile PURE de clasificare a adreselor din `node:net`
 * (`isIP`, `isIPv4`, `isIPv6`); ele lucrează pe text, fără socket-uri sau conexiuni.
 */
const PURE_NET_IMPORT =
  /import\s*\{\s*(?:isIP|isIPv4|isIPv6)(?:\s*,\s*(?:isIP|isIPv4|isIPv6))*\s*,?\s*\}\s*from\s*["'](?:node:)?net["']\s*;?/g;

export function findNetworkViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (file.path === ALLOWED_FILE) continue;
    if (!GUARDED_DIRS.some((dir) => file.path.startsWith(`${dir}/`))) continue;
    if (/\.test\.tsx?$/.test(file.path)) continue;
    const code = stripComments(file.content).replace(PURE_NET_IMPORT, "");
    for (const rule of RULES) {
      if (rule.re.test(code)) problems.push(`${file.path}: ${rule.name}`);
    }
  }
  return problems;
}

/** Fișierele cu verificările SSRF nu au comutator de mediu. */
const SWITCH_FREE_FILES = [
  "packages/core/src/media/safe-fetch.ts",
  "packages/core/src/media/ip-guard.ts",
  "packages/core/src/media/image-url.ts",
  "packages/core/src/media/host.ts",
  "packages/core/src/catalog/import/woo/image-importer.ts",
  "packages/core/src/catalog/import/image-runtime.ts",
] as const;

const SWITCH_RE = /\bprocess\.env\b|\bNODE_ENV\b|\bimport\.meta\.env\b|\bloadEnv\s*\(/;

export function findSwitchViolations(files: readonly SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!(SWITCH_FREE_FILES as readonly string[]).includes(file.path)) continue;
    if (SWITCH_RE.test(stripComments(file.content))) {
      problems.push(
        `${file.path}: citește mediul (process.env / NODE_ENV): verificările SSRF nu au comutator`,
      );
    }
  }
  return problems;
}

/** Fabrica de producție leagă `safeFetchImage` FĂRĂ al treilea parametru (rezolvator / conector). */
export function findProductionWiringViolations(files: readonly SourceFile[]): string[] {
  const runtime = files.find((f) => f.path === "packages/core/src/catalog/import/image-runtime.ts");
  if (!runtime) return ["packages/core/src/catalog/import/image-runtime.ts lipsește"];
  const code = stripComments(runtime.content);
  const wired =
    /fetchImage:\s*\(\s*url\s*,\s*policy\s*\)\s*=>\s*safeFetchImage\(\s*url\s*,\s*policy\s*\)/;
  return wired.test(code)
    ? []
    : [
        `${runtime.path}: fetchImage trebuie legat exact ca (url, policy) => safeFetchImage(url, policy), fără rezolvator sau conector injectat`,
      ];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function realFiles(): SourceFile[] {
  return GUARDED_DIRS.flatMap((dir) => walk(join(root, dir))).map((full) => ({
    path: relative(root, full).split(sep).join("/"),
    content: readFileSync(full, "utf8"),
  }));
}

const file = (path: string, content: string): SourceFile => ({ path, content });

describe("regula: rețeaua doar prin safeFetchImage (cazuri sintetice)", () => {
  const dir = "packages/core/src/catalog/import";
  it.each([
    ["fetch direct", `const r = await fetch(url);`],
    ["globalThis.fetch", `await globalThis.fetch(url);`],
    ["node:https", `import https from "node:https";`],
    ["https fără prefix", `import { request } from "https";`],
    ["node:http", `import { get } from "node:http";`],
    ["require", `const h = require("node:https");`],
    ["import dinamic", `const h = await import("node:net");`],
    ["node:dns", `import { lookup } from "node:dns/promises";`],
    ["node:tls", `import tls from "node:tls";`],
    ["node:net cu socket", `import { connect } from "node:net";`],
    ["node:net implicit", `import net from "node:net";`],
    ["child_process", `import { exec } from "node:child_process";`],
    ["axios", `import axios from "axios";`],
    ["undici", `import { request } from "undici";`],
    ["node-fetch", `import fetch from "node-fetch";`],
    ["XMLHttpRequest", `const x = new XMLHttpRequest();`],
    ["WebSocket", `const s = new WebSocket(url);`],
  ])("prinde %s", (_name, code) => {
    expect(findNetworkViolations([file(`${dir}/woo/oricare.ts`, code)])).toHaveLength(1);
    expect(findNetworkViolations([file(`packages/core/src/media/oricare.ts`, code)])).toHaveLength(
      1,
    );
  });

  it("nu se plânge de comentarii, de fetchImage(...), de .fetch( ca metodă sau de fișierele de test", () => {
    const ok = [
      `// apelează fetch(url) doar prin safeFetchImage`,
      `/* import https from "node:https" nu e permis */ const a = 1;`,
      `await deps.fetchImage(url, policy);`,
      `const prefetch = prefetchData();`,
      `await client.fetch(x);`,
    ].join("\n");
    expect(findNetworkViolations([file(`${dir}/woo/ok.ts`, ok)])).toEqual([]);
    // clasificarea pură a adreselor din node:net nu e acces la rețea
    expect(
      findNetworkViolations([file(`${dir}/woo/ip.ts`, `import { isIP, isIPv6 } from "node:net";`)]),
    ).toEqual([]);
    expect(
      findNetworkViolations([file(`${dir}/woo/ceva.test.ts`, `await fetch("http://x");`)]),
    ).toEqual([]);
  });

  it("fișierul permis (safe-fetch.ts) și fișierele din afara folderelor păzite nu sunt verificate", () => {
    expect(findNetworkViolations([file(ALLOWED_FILE, `import https from "node:https";`)])).toEqual(
      [],
    );
    expect(
      findNetworkViolations([file("packages/core/src/email/x.ts", `await fetch("https://x");`)]),
    ).toEqual([]);
  });
});

describe("regula: rețeaua doar prin safeFetchImage (sursa reală)", () => {
  const files = realFiles();

  it("scanează fișiere reale, nu un set gol, și safe-fetch.ts chiar conține apelurile de rețea", () => {
    expect(files.length).toBeGreaterThan(40);
    const safe = files.find((f) => f.path === ALLOWED_FILE);
    expect(safe?.content).toMatch(/node:https/);
    expect(safe?.content).toMatch(/node:dns/);
  });

  it("niciun alt fișier din media/ sau catalog/import/ nu atinge rețeaua", () => {
    expect(findNetworkViolations(files)).toEqual([]);
  });
});

describe("regula: verificările SSRF nu au comutator", () => {
  it("cazuri sintetice", () => {
    const path = SWITCH_FREE_FILES[0];
    expect(findSwitchViolations([file(path, `if (process.env.SKIP_SSRF) return;`)])).toHaveLength(
      1,
    );
    expect(findSwitchViolations([file(path, `if (NODE_ENV === "test") return;`)])).toHaveLength(1);
    expect(findSwitchViolations([file(path, `// process.env se citește în altă parte`)])).toEqual(
      [],
    );
    expect(
      findSwitchViolations([file("packages/core/src/media/altceva.ts", `process.env.X`)]),
    ).toEqual([]);
  });

  it("sursa reală: nicio variabilă de mediu în fișierele cu verificări, iar fabrica de producție nu injectează nimic", () => {
    const files = realFiles();
    for (const path of SWITCH_FREE_FILES) {
      expect(
        files.some((f) => f.path === path),
        `${path} există`,
      ).toBe(true);
    }
    expect(findSwitchViolations(files)).toEqual([]);
    expect(findProductionWiringViolations(files)).toEqual([]);
  });

  it("legarea de producție greșită se prinde", () => {
    const wrong = file(
      "packages/core/src/catalog/import/image-runtime.ts",
      `fetchImage: (url, policy) => safeFetchImage(url, policy, { resolve: async () => [] }),`,
    );
    expect(findProductionWiringViolations([wrong])).toHaveLength(1);
  });
});
