import type { Metadata } from "next";
import { DELIVERY_PROVIDERS, can } from "@ecom/core";
import { Section } from "@ecom/ui";
import {
  DeliveryCard,
  DeliverySettingsForm,
  type DeliveryCardDto,
} from "@/components/admin/digital/delivery-settings";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { getDeliveryConfig, readDigitalGroup } from "@/lib/digital";
import { formatDateTime } from "@/lib/format-date";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().digitalAdmin.delivery;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

/**
 * Livrarea conținutului digital (Faza 14b): setările (furnizorii aleși, valabilitatea linkurilor, pragurile de alertă, păstrarea
 * IP-ului, textul bifei legale) se văd cu `settings.read` și se salvează cu `settings.write`; cheile furnizorilor cu cont (Bunny
 * Stream, S3), testul, confirmarea «am testat cu un cont real» și activarea sunt DOAR pentru Owner (`digital.configure`) și nu se
 * întorc niciodată spre interfață (doar «salvat / nesalvat»). Bunny și S3 sunt netestate cu un cont real: fără confirmarea lui Owner
 * rămân blocate pe server.
 */
export default async function DeliverySettingsPage() {
  const subject = await requireAdmin({ permission: "settings.read" });
  const [digital, regional] = await Promise.all([
    readDigitalGroup(),
    getSettings().getGroup("regional"),
  ]);
  const canConfigure = can(subject, "digital.configure");
  const states = canConfigure ? await getDeliveryConfig().list() : [];
  const cards: DeliveryCardDto[] = states.map((state) => ({
    code: state.code,
    label: state.label,
    fields: DELIVERY_PROVIDERS[state.code].fields.map((field) => ({
      key: field.key,
      label: field.label,
      secret: field.secret,
      required: field.required,
      hint: field.hint ?? null,
    })),
    saved: state.saved,
    values: state.values,
    configured: state.configured,
    isActive: state.isActive,
    verifiedAtText: state.verifiedInSandboxAt
      ? formatDateTime(state.verifiedInSandboxAt, regional.locale, regional.timezone)
      : null,
    notes: [...state.notes],
  }));
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <PageHeader title={m.title} description={m.lede} />
      <Section id="delivery-settings" title={m.selectionTitle}>
        <DeliverySettingsForm
          canWrite={can(subject, "settings.write")}
          initial={{
            videoProvider: digital.videoProvider,
            fileProvider: digital.fileProvider,
            linkSeconds: digital.linkSeconds,
            maxUploadMb: digital.maxUploadMb,
            maxIpsPerEntitlement: digital.maxIpsPerEntitlement,
            ipWindowHours: digital.ipWindowHours,
            accessLogRetentionDays: digital.accessLogRetentionDays,
            consentText: digital.consentText,
          }}
        />
      </Section>
      <Section id="delivery-providers" title={m.providersTitle}>
        {canConfigure ? (
          <div className="flex flex-col gap-6">
            {cards.map((card) => (
              <DeliveryCard key={card.code} card={card} />
            ))}
          </div>
        ) : (
          <p className="text-ink-secondary">{m.ownerOnly}</p>
        )}
      </Section>
    </div>
  );
}
