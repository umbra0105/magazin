import type { Metadata } from "next";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  buttonVariants,
} from "@ecom/ui";
import { requireAdmin } from "@/lib/admin-page";
import { getMessages } from "@/messages";

const m = getMessages().admin.forbidden;

export const metadata: Metadata = { title: m.title };

/** Destinația când utilizatorul are acces în admin, dar nu și permisiunea unei secțiuni. */
export default async function ForbiddenPage() {
  await requireAdmin();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{m.title}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{m.noPermission}</CardTitle>
          <CardDescription />
        </CardHeader>
        <CardContent>
          <Link href="/admin" className={buttonVariants({ variant: "outline" })}>
            {m.backHome}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
