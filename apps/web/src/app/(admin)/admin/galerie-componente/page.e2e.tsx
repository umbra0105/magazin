import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin-page";
import { Gallery } from "./gallery.e2e";

export const metadata: Metadata = { title: "Galerie de componente" };

/**
 * PAGINA DE EXEMPLU A COMPONENTELOR (docs/17 §7), doar pentru dezvoltare: toate componentele din `@ecom/ui` în toate stările, cu
 * text românesc real. Extensia `.e2e.tsx` e inclusă în `pageExtensions` doar în dezvoltare sau cu `E2E_HARNESS=1` (vezi
 * `lib/page-extensions.ts`), deci într-un build de producție obișnuit fișierul nici nu devine rută, nici nu se compilează; a
 * doua barieră: fără dezvoltare sau variabilă, 404. Nu intră în pachetul instalabil (Faza 21).
 */
export default async function GalleryPage() {
  if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound();
  await requireAdmin();
  return <Gallery />;
}
