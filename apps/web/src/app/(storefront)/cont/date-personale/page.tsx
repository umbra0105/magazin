import type { Metadata } from "next";
import { getProfile } from "@ecom/core";
import { getDb } from "@ecom/db";
import {
  CommunicationPanel,
  DeletePanel,
  ExportPanel,
  PasswordPanel,
  ProfilePanel,
} from "@/components/storefront/account/profile-panels";
import { requireCustomer } from "@/lib/account";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().account;

export const metadata: Metadata = { title: m.profile.title };
export const dynamic = "force-dynamic";

/** Datele personale: profil, parolă, preferințe de comunicare, export GDPR și ștergerea contului (anonimizare). */
export default async function AccountProfilePage() {
  const { user } = await requireCustomer("/cont/date-personale");
  const [profile, auth] = await Promise.all([
    getProfile(getDb(), user.id),
    getSettings().getGroup("auth"),
  ]);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="heading-display text-3xl sm:text-4xl">{m.profile.title}</h1>
        <p className="max-w-prose text-ink-secondary">{m.profile.lede}</p>
      </header>
      <ProfilePanel
        name={profile.name}
        email={profile.email}
        emailVerified={profile.emailVerified}
        phone={profile.phone ?? ""}
      />
      <PasswordPanel minLength={auth.minPasswordLength} />
      <CommunicationPanel marketingOptIn={profile.marketingOptIn} />
      <ExportPanel />
      <DeletePanel />
    </div>
  );
}
