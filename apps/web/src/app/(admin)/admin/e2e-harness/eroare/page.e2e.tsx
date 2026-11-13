import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin-page";

/**
 * HARNESS DOAR PENTRU TESTE (E2E). Nu e o pagină livrată: extensia `.e2e.tsx` e inclusă în `pageExtensions` doar când
 * `E2E_HARNESS=1` (setat de Playwright). A doua barieră: în producție fără variabilă, 404. Cu `?arunca=1` aruncă o eroare, ca
 * testele să vadă starea de eroare din `error.tsx` a adminului.
 */
export default async function ErrorHarnessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound();
  await requireAdmin({ permission: "admin.access" });
  const params = await searchParams;
  if (params["arunca"] === "1") throw new Error("Eroare de probă (harness)");
  return <h1 className="text-title">Fără eroare</h1>;
}
