import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ecom/ui";
import { navEntryForPath } from "@/lib/admin-nav";
import { requireAdmin } from "@/lib/admin-page";
import { getMessages } from "@/messages";

const m = getMessages().admin;

export const metadata: Metadata = { title: m.comingSoon.title };

/**
 * Secțiunile din meniu care nu au încă o pagină proprie. Respectă aceleași condiții ca meniul:
 * cale necunoscută → 404; flag oprit → 404; fără permisiune → „acces interzis”. Fiecare secțiune
 * reală, când se construiește, își ia propria pagină și își cere `requireAdmin({ permission })`.
 */
export default async function AdminSectionPlaceholder({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const entry = navEntryForPath(`/admin/${slug.join("/")}`);
  if (!entry || entry.href === "/admin") notFound();
  await requireAdmin({
    ...(entry.permission && { permission: entry.permission }),
    ...(entry.feature && { feature: entry.feature }),
  });
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{m.nav[entry.id]}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{m.comingSoon.title}</CardTitle>
          <CardDescription>{m.comingSoon.description}</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </div>
  );
}
