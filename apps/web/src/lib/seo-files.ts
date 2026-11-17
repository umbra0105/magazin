/**
 * Fișierele de SEO ale vitrinei (docs/19 §1): `sitemap.xml` (cu `lastmod` real și imaginea principală, fără `priority` și
 * `changefreq`, pe care Google le ignoră), `robots.txt` și `llms.txt`. Funcții pure: primesc date, întorc text. Orice valoare din
 * baza de date trece prin `escapeXml`.
 */

export interface SitemapEntry {
  loc: string;
  lastmod?: Date;
  image?: { loc: string; title?: string };
}

/** Limita unui fișier sitemap (protocolul): 50.000 de adrese. */
export const SITEMAP_MAX_URLS = 50_000;

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const absolute = (base: string, path: string): string => `${base.replace(/\/+$/, "")}${path}`;

export function renderSitemap(entries: readonly SitemapEntry[]): string {
  const urls = entries.slice(0, SITEMAP_MAX_URLS).map((entry) => {
    const parts = [`    <loc>${escapeXml(entry.loc)}</loc>`];
    if (entry.lastmod) parts.push(`    <lastmod>${entry.lastmod.toISOString()}</lastmod>`);
    if (entry.image) {
      parts.push(
        `    <image:image>\n      <image:loc>${escapeXml(entry.image.loc)}</image:loc>${
          entry.image.title
            ? `\n      <image:title>${escapeXml(entry.image.title)}</image:title>`
            : ""
        }\n    </image:image>`,
      );
    }
    return `  <url>\n${parts.join("\n")}\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls.join("\n")}\n</urlset>\n`;
}

/** Zonele private sau fără valoare pentru căutători: cont, coș, comandă, autentificare, administrare, API și căutarea internă. */
export const ROBOTS_DISALLOWED = [
  "/admin",
  "/api",
  "/cont",
  "/cos",
  "/checkout",
  "/comanda",
  "/autentificare",
  "/inregistrare",
  "/recuperare-parola",
  "/resetare-parola",
  "/verificare-email",
  "/cautare",
  "/descarca",
] as const;

export function renderRobots(base: string): string {
  const lines = ["User-agent: *", ...ROBOTS_DISALLOWED.map((path) => `Disallow: ${path}`)];
  lines.push("", `Sitemap: ${absolute(base, "/sitemap.xml")}`, "");
  return lines.join("\n");
}

export interface LlmsInput {
  base: string;
  storeName: string;
  tagline: string;
  categories: { name: string; path: string }[];
  brands: { name: string; slug: string }[];
}

/** `/llms.txt` (markdown pentru asistenți AI), generat DOAR din date reale: numele magazinului, categoriile și mărcile cu produse. */
export function renderLlmsTxt(input: LlmsInput): string {
  const lines = [`# ${input.storeName}`, ""];
  if (input.tagline) lines.push(`> ${input.tagline}`, "");
  lines.push("## Catalog", `- [Toate produsele](${absolute(input.base, "/magazin")})`);
  for (const category of input.categories) {
    lines.push(`- [${category.name}](${absolute(input.base, `/categorie/${category.path}`)})`);
  }
  if (input.brands.length > 0) {
    lines.push("", "## Mărci");
    for (const brand of input.brands) {
      lines.push(`- [${brand.name}](${absolute(input.base, `/brand/${brand.slug}`)})`);
    }
  }
  lines.push("", "## Sitemap", `- ${absolute(input.base, "/sitemap.xml")}`, "");
  return lines.join("\n");
}
