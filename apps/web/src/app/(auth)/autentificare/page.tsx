import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ecom/ui";
import { SESSION_EXPIRED_PARAM } from "@/lib/admin-access";
import { LoginForm } from "@/components/auth/login-form";
import { readNextPath, redirectIfSignedIn, withNext, type SearchParams } from "@/lib/auth-page";
import { getMessages } from "@/messages";

const m = getMessages().auth.login;

export const metadata: Metadata = { title: m.metaTitle, robots: { index: false } };

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const nextPath = await readNextPath(searchParams);
  await redirectIfSignedIn(nextPath);
  // Doar o valoare fixă: textul mesajului nu vine niciodată din URL.
  const sessionExpired = (await searchParams)["sesiune"] === SESSION_EXPIRED_PARAM;
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">{m.title}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm
          nextPath={nextPath}
          sessionExpired={sessionExpired}
          registerHref={withNext("/inregistrare", nextPath)}
        />
      </CardContent>
    </Card>
  );
}
