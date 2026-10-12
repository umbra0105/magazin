import type { Metadata } from "next";
import { Card, CardContent } from "@ecom/ui";
import { VerifyEmailPanel } from "@/components/auth/verify-email-panel";
import { getMessages } from "@/messages";

const m = getMessages().auth.verify;

// Tokenul e în fragment (citit în browser); pagina nu se indexează și nu trimite Referer.
export const metadata: Metadata = {
  title: m.metaTitle,
  robots: { index: false },
  referrer: "no-referrer",
};

export default function VerifyEmailPage() {
  return (
    <Card>
      <CardContent className="pt-6">
        <VerifyEmailPanel />
      </CardContent>
    </Card>
  );
}
