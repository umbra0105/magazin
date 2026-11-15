import { notFound } from "next/navigation";

/**
 * HARNESS DOAR PENTRU TESTE (E2E) al vitrinei. Extensia `.e2e.tsx` e inclusă în `pageExtensions` doar în dezvoltare sau cu
 * `E2E_HARNESS=1`; a doua barieră: în producție fără variabilă, 404. Cu `?arunca=1` aruncă o eroare, ca testele să vadă starea de
 * eroare din `(storefront)/error.tsx` (cadrul rămâne).
 */
export default async function StorefrontErrorHarness({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound();
  const params = await searchParams;
  if (params["arunca"] === "1") throw new Error("Eroare de probă (harness vitrină)");
  return <h1>Fără eroare</h1>;
}
