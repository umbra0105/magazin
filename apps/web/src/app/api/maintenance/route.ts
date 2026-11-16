import { NextResponse } from "next/server";
import { getSettings } from "@/lib/services";

// Răspunsul depinde de setare: niciodată din cache (îl citește middleware-ul la fiecare câteva secunde).
export const dynamic = "force-dynamic";

/**
 * Steagul modului de mentenanță, pentru middleware (care rulează pe Edge și nu are acces la baza de date). Public și fără date
 * sensibile: doar `{ enabled }`. Dacă setarea nu se poate citi, răspunde «oprit» (magazinul rămâne deschis).
 */
export async function GET() {
  const enabled = await getSettings()
    .get("maintenance.enabled")
    .then((value) => value === true)
    .catch(() => false);
  return NextResponse.json({ enabled }, { headers: { "Cache-Control": "no-store" } });
}
