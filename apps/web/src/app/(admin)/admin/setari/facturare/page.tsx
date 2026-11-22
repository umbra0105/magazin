import type { Metadata } from "next";
import { INVOICING_PROVIDERS, can } from "@ecom/core";
import { Section } from "@ecom/ui";
import { PageHeader } from "@/components/admin/page-header";
import {
  InvoicingCard,
  InvoicingChoice,
  type InvoicingCardDto,
} from "@/components/admin/invoicing/invoicing-settings";
import { InvoicingTextsForm } from "@/components/admin/invoicing/invoicing-texts-form";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { getInvoicingConfig } from "@/lib/invoicing";
import { formatUnitNames } from "@/lib/invoicing-texts";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.invoicing.settings;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

/**
 * Configurarea facturării. Cere `invoices.configure` (doar Owner): cine nu are dreptul NU vede nici câmpurile, nici ce e salvat.
 * Pagina nu primește niciodată credențiale: doar «salvat / nesalvat» pentru fiecare câmp secret și valorile câmpurilor ne-secrete
 * (seria, CIF-ul, numele cotei).
 */
export default async function InvoicingSettingsPage() {
  const subject = await requireAdmin({ permission: "invoices.configure" });
  const config = getInvoicingConfig();
  const [states, invoicing, regional] = await Promise.all([
    config.list(),
    getSettings().getGroup("invoicing"),
    getSettings().getGroup("regional"),
  ]);
  const canWrite = can(subject, "invoices.configure");

  const cards: InvoicingCardDto[] = states.map((state) => ({
    code: state.code,
    label: state.label,
    real: state.real,
    fields: INVOICING_PROVIDERS[state.code].fields.map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required,
      secret: field.secret,
      hint: field.hint ?? null,
    })),
    saved: state.saved,
    values: state.values,
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
      <Section id="invoicing-choice" title={m.selectedTitle}>
        <InvoicingChoice initial={invoicing.provider} options={options} canWrite={canWrite} />
      </Section>
      <div className="flex flex-col gap-4">
        {cards.map((card) => (
          <InvoicingCard key={card.code} carrier={card} canWrite={canWrite} />
        ))}
      </div>
      <Section id="invoicing-texts" title={m.texts.title}>
        <InvoicingTextsForm
          canWrite={canWrite}
          initial={{
            shippingLabel: invoicing.shippingLabel,
            codFeeLabel: invoicing.codFeeLabel,
            serviceUnit: invoicing.serviceUnit,
            unitNames: formatUnitNames(invoicing.unitNames),
            sendEmailByProvider: invoicing.sendEmailByProvider,
          }}
        />
      </Section>
    </div>
  );
}
