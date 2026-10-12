import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ecom/ui";
import { RegisterForm } from "@/components/auth/register-form";
import { readNextPath, redirectIfSignedIn, withNext, type SearchParams } from "@/lib/auth-page";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().auth.register;

export const metadata: Metadata = { title: m.metaTitle, robots: { index: false } };

export default async function RegisterPage({ searchParams }: { searchParams: SearchParams }) {
  const nextPath = await readNextPath(searchParams);
  await redirectIfSignedIn(nextPath);
  const auth = await getSettings().getGroup("auth");
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">{m.title}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <RegisterForm
          nextPath={nextPath}
          minPasswordLength={auth.minPasswordLength}
          requireEmailVerification={auth.requireEmailVerification}
          loginHref={withNext("/autentificare", nextPath)}
        />
      </CardContent>
    </Card>
  );
}
