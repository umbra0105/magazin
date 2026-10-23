/**
 * Adresele de admin mutate sub «Produse» (blocul 8b). Fișier fără importuri: îl citește și `next.config.ts`.
 * Adresele vechi redirecționează permanent (308) la cele noi; Next păstrează parametrii din adresă și restul căii
 * (`/admin/stoc/<id>?x=1` → `/admin/produse/stoc/<id>?x=1`).
 */
export const LEGACY_ADMIN_ROUTES: readonly { from: string; to: string }[] = [
  { from: "/admin/categorii", to: "/admin/produse/categorii" },
  { from: "/admin/branduri", to: "/admin/produse/branduri" },
  { from: "/admin/atribute", to: "/admin/produse/atribute" },
  { from: "/admin/unitati-de-masura", to: "/admin/produse/unitati-de-masura" },
  { from: "/admin/fise-explodate", to: "/admin/produse/fise-explodate" },
  { from: "/admin/stoc", to: "/admin/produse/stoc" },
];

export function legacyAdminRedirects(): { source: string; destination: string; permanent: true }[] {
  return LEGACY_ADMIN_ROUTES.map(({ from, to }) => ({
    source: `${from}/:path*`,
    destination: `${to}/:path*`,
    permanent: true as const,
  }));
}
