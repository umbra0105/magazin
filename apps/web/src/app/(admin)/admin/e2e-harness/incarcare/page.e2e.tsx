import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { requireAdmin } from "@/lib/admin-page";

/**
 * HARNESS DOAR PENTRU TESTE (E2E). Nu e o pagină livrată: extensia `.e2e.tsx` e inclusă în `pageExtensions` doar când
 * `E2E_HARNESS=1` (setat de Playwright). A doua barieră: în producție fără variabilă, 404. Partea lentă a paginii (4 secunde) stă
 * într-un `<Suspense>` cu `PageSkeleton`, ca testele să vadă starea de încărcare.
 */
async function SlowPart() {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  return <h1 className="text-title">Pagină încărcată</h1>;
}

export default async function LoadingHarnessPage() {
  if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound();
  await requireAdmin({ permission: "admin.access" });
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SlowPart />
    </Suspense>
  );
}
