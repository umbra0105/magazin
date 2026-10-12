import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ecom/ui";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { getCurrentResolution } from "@/lib/session";
import { getMessages } from "@/messages";

const m = getMessages().auth.account;

export const metadata: Metadata = { title: m.metaTitle, robots: { index: false } };

/**
 * Pagina contului: deocamdată doar confirmă sesiunea și permite deconectarea. Conținutul real al
 * contului de client (comenzi, adrese) vine în Faza 14. Verificarea sesiunii e pe server, nu doar
 * în middleware (care vede doar existența cookie-ului).
 */
export default async function AccountPage() {
  const resolution = await getCurrentResolution();
  if (resolution.status !== "ok") redirect("/autentificare?next=%2Fcont");
  const { subject } = resolution;
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-8">
      <main className="w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle as="h1">{m.title(subject.email)}</CardTitle>
            <CardDescription>{m.description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm">
              <span className="text-muted-foreground">{m.email}: </span>
              {subject.email}
            </p>
            <SignOutButton />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
