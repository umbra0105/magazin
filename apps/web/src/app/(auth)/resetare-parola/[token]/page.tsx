import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ecom/ui";
import { ResetForm } from "@/components/auth/reset-form";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().auth.reset;

// Tokenul e în URL: nu se trimite mai departe în antetul Referer și pagina nu se indexează.
export const metadata: Metadata = {
  title: m.metaTitle,
  robots: { index: false },
  referrer: "no-referrer",
};

export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const { minPasswordLength } = await getSettings().getGroup("auth");
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">{m.title}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <ResetForm token={token} minPasswordLength={minPasswordLength} />
      </CardContent>
    </Card>
  );
}
