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
import { EmailRequestForm } from "@/components/auth/email-request-form";
import type { SearchParams } from "@/lib/auth-page";
import { getMessages } from "@/messages";

const m = getMessages().auth.verify;

export const metadata: Metadata = { title: m.metaTitle, robots: { index: false } };

/**
 * Destinația linkului din emailul de verificare. Better Auth redirecționează aici, cu `?error=…`
 * dacă tokenul e invalid sau expirat, și fără parametri dacă verificarea a reușit.
 */
export default async function VerifyEmailPage({ searchParams }: { searchParams: SearchParams }) {
  const hasError = Boolean((await searchParams)["error"]);
  if (!hasError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle as="h1">{m.successTitle}</CardTitle>
          <CardDescription>{m.success}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/autentificare" className={buttonVariants({ className: "w-full" })}>
            {getMessages().auth.login.submit}
          </Link>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">{m.errorTitle}</CardTitle>
        <CardDescription>{m.error}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-muted-foreground">{m.resendDescription}</p>
        <EmailRequestForm
          endpoint="/api/auth/send-verification-email"
          body={{ callbackURL: "/verificare-email" }}
          context="verify"
          submitLabel={m.resend}
          successMessage={m.sent}
          idPrefix="verify"
        />
      </CardContent>
    </Card>
  );
}
