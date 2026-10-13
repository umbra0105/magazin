import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin-page";
import { PickerHarness } from "./harness.e2e";

/**
 * HARNESS DOAR PENTRU TESTE (E2E). Nu e o pagină livrată: extensia `.e2e.tsx` e inclusă în
 * `pageExtensions` doar când `E2E_HARNESS=1` (setat de Playwright), deci într-un build normal acest
 * fișier nici nu devine rută, nici nu se compilează. A doua barieră: fără variabila, 404.
 */
export default async function MediaPickerHarnessPage() {
  if (process.env["E2E_HARNESS"] !== "1") notFound();
  await requireAdmin({ permission: "media.read" });
  return <PickerHarness />;
}
