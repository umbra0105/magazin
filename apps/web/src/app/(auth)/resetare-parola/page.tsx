import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ecom/ui";
import { ResetPanel } from "@/components/auth/reset-panel";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().auth.reset;

// Fără token în cale (e în fragment, citit în browser); pagina nu se indexează.
export const metadata: Metadata = {
  title: m.metaTitle,
  robots: { index: false },
  referrer: "no-referrer",
};

export default async function ResetPasswordPage() {
  const { minPasswordLength } = await getSettings().getGroup("auth");
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">{m.title}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <ResetPanel minPasswordLength={minPasswordLength} />
      </CardContent>
    </Card>
  );
}
