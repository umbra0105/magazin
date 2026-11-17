import { notFound } from "next/navigation";

/**
 * HARNESS DOAR PENTRU TESTE (E2E) al vitrinei: o pagină care răspunde după o întârziere, ca testele să vadă scheletul din
 * `loading.e2e.tsx` al segmentului (vitrina nu are schelet la nivel de grup, vezi acel fișier). Aceleași bariere ca la celelalte harness-uri (extensia `.e2e.tsx` + producție fără `E2E_HARNESS=1` → 404).
 */
// dinamică: altfel (cadrul vitrinei e în cache, fără force-dynamic) s-ar randa static la build și scheletul n-ar apărea
export const dynamic = "force-dynamic";

export default async function StorefrontLoadingHarness() {
  if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return <h1>Pagina s-a încărcat</h1>;
}
