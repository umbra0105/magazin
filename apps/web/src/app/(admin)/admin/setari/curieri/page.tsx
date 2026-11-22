import type { Metadata } from "next";
import { CARRIERS, can } from "@ecom/core";
import { Section } from "@ecom/ui";
import { PageHeader } from "@/components/admin/page-header";
import {
  CarrierChoice,
  CarrierCard,
  type CarrierCardDto,
} from "@/components/admin/shipping/carrier-settings";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { getCarrierConfig } from "@/lib/shipping";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.shipping.carriers;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

/**
 * Configurarea curierilor. Cere `integrations.write` (doar Owner): cine nu are dreptul NU vede nici câmpurile, nici ce e salvat.
 * Pagina nu primește niciodată credențiale: doar «salvat / nesalvat» pentru fiecare câmp.
 */
export default async function CarrierSettingsPage() {
  const subject = await requireAdmin({ permission: "integrations.write" });
  const config = getCarrierConfig();
  const [states, shipping, regional] = await Promise.all([
    config.list(),
    getSettings().getGroup("shipping"),
    getSettings().getGroup("regional"),
  ]);
  const canWrite = can(subject, "integrations.write");

  const cards: CarrierCardDto[] = states.map((state) => ({
    code: state.code,
    label: state.label,
    real: state.real,
    fields: CARRIERS[state.code].fields.map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required,
      secret: field.secret,
      hint: field.hint ?? null,
    })),
    saved: state.saved,
    configured: state.configured,
    isActive: state.isActive,
    mode: state.mode,
    verifiedAtText: state.verifiedInSandboxAt
      ? formatDateTime(state.verifiedInSandboxAt, regional.locale, regional.timezone)
      : null,
    notes: [...state.notes],
  }));
  const options = states.map((state) => ({
    code: state.code,
    label: state.label,
    usable:
      state.isActive &&
      state.configured &&
      (state.mode === "test" || !state.real || state.verifiedInSandboxAt !== null),
  }));

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <PageHeader
        title={m.title}
        description={m.description}
        notes={canWrite ? [] : [m.readOnly]}
      />
      <Section id="carrier-choice" title={m.selectedTitle}>
        <CarrierChoice initial={shipping.carrier} options={options} canWrite={canWrite} />
      </Section>
      <div className="flex flex-col gap-4">
        {cards.map((card) => (
          <CarrierCard key={card.code} carrier={card} canWrite={canWrite} />
        ))}
      </div>
    </div>
  );
}
