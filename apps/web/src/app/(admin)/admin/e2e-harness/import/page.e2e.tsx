import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin-page";
import { ImportHarness } from "./harness.e2e";

/**
 * HARNESS DOAR PENTRU TESTE (E2E). Nu e o pagină livrată: extensia `.e2e.tsx` e inclusă în `pageExtensions` doar când
 * `E2E_HARNESS=1` (setat de Playwright), deci într-un build normal acest fișier nici nu devine rută. A doua barieră: în producție
 * fără variabilă, 404. Randează părțile importului WooCommerce și ale imaginilor cu date FIXE (fără fișier și fără rețea).
 * `?ecran=woo|raport|imagini` și `&stare=` (woo: normal, descrieri, fara-drept, fara-domenii; imagini: curs, oprit, gata).
 */
type SearchParams = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? "";

export default async function ImportHarnessPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound();
  await requireAdmin({ permission: "products.write" });
  const params = await searchParams;
  return <ImportHarness ecran={one(params["ecran"]) || "woo"} stare={one(params["stare"])} />;
}
