import type { Metadata } from "next";
import { can } from "@ecom/core";
import { SmtpForm } from "@/components/admin/email/smtp-form";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { loadSmtpState } from "@/lib/email-admin";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.email.smtp;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

/**
 * Serverul SMTP. Cere `email.configure` (doar Owner): cine nu are dreptul nu vede nici câmpurile, nici ce e salvat. Pagina nu
 * primește niciodată parola: doar «salvat / nesalvat».
 */
export default async function EmailSettingsPage() {
  const subject = await requireAdmin({ permission: "email.configure" });
  const [state, email] = await Promise.all([loadSmtpState(), getSettings().getGroup("email")]);
  const canWrite = can(subject, "email.configure");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={m.title}
        description={m.description}
        notes={canWrite ? [] : [m.readOnly]}
      />
      <SmtpForm
        canWrite={canWrite}
        initial={{
          host: state.host,
          port: state.port,
          secure: state.secure,
          user: state.user,
          isActive: state.isActive,
          passwordSaved: state.passwordSaved,
          exists: state.exists,
          fromName: email.fromName,
          fromAddress: email.fromAddress,
          replyTo: email.replyTo,
          internalRecipients: email.internalRecipients.join("\n"),
        }}
      />
    </div>
  );
}
