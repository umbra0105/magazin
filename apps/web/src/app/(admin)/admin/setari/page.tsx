import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin-page";

/** «Setări» e un grup de meniu: adresa grupului duce la primul ecran (Aspect). Cere `settings.read`, ca ecranele lui. */
export default async function SettingsIndexPage() {
  await requireAdmin({ permission: "settings.read" });
  redirect("/admin/setari/aspect");
}
