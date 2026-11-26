import type { Metadata } from "next";
import { INVOICING_PROVIDERS, can, listInvoiceQuantityWarnings } from "@ecom/core";
import { getDb } from "@ecom/db";
import { formatQuantity, quantityFromTicks } from "@ecom/shared";
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
  const warnings = await listInvoiceQuantityWarnings(getDb(), { limit: 30 });

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
      <Section id="invoicing-quantity" title={m.quantity.title}>
        <p className="text-body text-ink-secondary">{m.quantity.help}</p>
        {warnings.rows.length === 0 ? (
          <p className="text-body" data-quantity-ok>
            {m.quantity.none}
          </p>
        ) : (
          <ul className="list-disc pl-5 text-body" data-quantity-warnings>
            {warnings.rows.map((row) => (
              <li key={row.sku}>
                {m.quantity.row(
                  row.sku,
                  row.productTitle,
                  formatQuantity(quantityFromTicks(BigInt(row.stepTicks)), { maxDecimals: 4 }),
                )}
              </li>
            ))}
            {warnings.total > warnings.rows.length ? (
              <li>{m.quantity.more(warnings.total - warnings.rows.length)}</li>
            ) : null}
          </ul>
        )}
      </Section>
      <Section id="invoicing-texts" title={m.texts.title}>
        <InvoicingTextsForm
          canWrite={canWrite}
          initial={{
            shippingLabel: invoicing.shippingLabel,
            codFeeLabel: invoicing.codFeeLabel,
            pointsDiscountLabel: invoicing.pointsDiscountLabel,
            serviceUnit: invoicing.serviceUnit,
            unitNames: formatUnitNames(invoicing.unitNames),
            sendEmailByProvider: invoicing.sendEmailByProvider,
          }}
        />
      </Section>
    </div>
  );
}
