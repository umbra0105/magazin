import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ecom/ui";
import { EmailRequestForm } from "@/components/auth/email-request-form";
import { getMessages } from "@/messages";

const m = getMessages().auth.forgot;

export const metadata: Metadata = { title: m.metaTitle, robots: { index: false } };

export default function ForgotPasswordPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1">{m.title}</CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <EmailRequestForm
          endpoint="/api/auth/request-password-reset"
          body={{ redirectTo: "/resetare-parola" }}
          context="forgot"
          submitLabel={m.submit}
          successMessage={m.sent}
          idPrefix="forgot"
        />
      </CardContent>
    </Card>
  );
}
