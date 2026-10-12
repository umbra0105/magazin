import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@ecom/ui";
import { getMessages } from "@/messages";

const m = getMessages().auth.reset;

export const metadata: Metadata = { title: m.metaTitle, robots: { index: false } };

/** Fără token în adresă: nu are ce reseta. Trimite spre pagina de recuperare. */
export default function ResetPasswordWithoutTokenPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">{m.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p role="alert" className="text-sm text-danger">
          {m.missingToken}
        </p>
        <Link
          href="/recuperare-parola"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          {m.requestNew}
        </Link>
      </CardContent>
    </Card>
  );
}
