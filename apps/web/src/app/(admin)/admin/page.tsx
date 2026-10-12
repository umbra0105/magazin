import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ecom/ui";
import { requireAdmin } from "@/lib/admin-page";
import { getMessages } from "@/messages";

const m = getMessages().admin.dashboard;

export const metadata: Metadata = { title: m.title };

export default async function AdminHomePage() {
  await requireAdmin();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{m.title}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{m.description}</CardTitle>
          <CardDescription>{m.placeholder}</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </div>
  );
}
