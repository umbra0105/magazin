import { unstable_cache } from "next/cache";
import { adminCounters, type AdminCounters } from "@ecom/core";
import { getDb } from "@ecom/db";

/**
 * Contoarele din meniul de admin, cu cache scurt (10 secunde): interogările sunt indexate, dar meniul se desenează la fiecare
 * pagină. Contorul arată «aproape acum»; adevărul e lista pe care o deschide. În testele E2E (`E2E_HARNESS=1`) cache-ul e oprit,
 * ca un test să vadă imediat ce a făcut.
 */
const cached = unstable_cache(() => adminCounters(getDb(), new Date()), ["admin-counters"], {
  revalidate: 10,
});

export async function getAdminCounters(): Promise<AdminCounters> {
  if (process.env["E2E_HARNESS"] === "1") return adminCounters(getDb(), new Date());
  return cached();
}
