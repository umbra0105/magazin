import type { Metadata } from "next";
import Link from "next/link";
import { PROVIDERS, can, paymentCounters } from "@ecom/core";
import { getDb } from "@ecom/db";
import { Section } from "@ecom/ui";
import { PageHeader } from "@/components/admin/page-header";
import {
  CardProviderChoice,
  ProviderCard,
  type ProviderCardDto,
} from "@/components/admin/payments/provider-settings";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { getPaymentConfig } from "@/lib/payments";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.paymentSettings;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

/**
 * Configurarea plăților cu card. Cere `payments.configure` (doar Owner): cine nu are dreptul NU vede nici câmpurile, nici ce e
 * salvat. Pagina nu primește niciodată credențiale: doar «salvat / nesalvat» pentru fiecare câmp.
 */
export default async function PaymentSettingsPage() {
  const subject = await requireAdmin({ permission: "payments.configure" });
  const config = getPaymentConfig();
  const [states, counters, payment, regional] = await Promise.all([
    config.list(),
    paymentCounters(getDb(), new Date()),
    getSettings().getGroup("payment"),
    getSettings().getGroup("regional"),
  ]);
  const canWrite = can(subject, "payments.configure");

  const cards: ProviderCardDto[] = states.map((state) => ({
    code: state.code,
    label: state.label,
    real: state.real,
    fields: PROVIDERS[state.code].fields.map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required,
      multiline: field.multiline === true,
      hint: field.hint ?? null,
    })),
    saved: state.saved,
    configured: state.configured,
    isActive: state.isActive,
    mode: state.mode,
    verifiedAtText: state.verifiedInSandboxAt
      ? formatDateTime(state.verifiedInSandboxAt, regional.locale, regional.timezone)
      : null,
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

      <section aria-label={m.health.ok} className="flex flex-col gap-2">
        {counters.rejectedLast24h > 0 ? (
          <div role="alert" className="rounded-lg bg-tone-warning-bg p-3 text-tone-warning-fg">
            <p className="font-medium">{m.health.rejected(counters.rejectedLast24h)}</p>
            <p className="text-body">{m.health.rejectedHelp}</p>
          </div>
        ) : (
          <p className="rounded-lg bg-surface-subtle p-3 text-body text-ink-secondary">
            {m.health.ok}
          </p>
        )}
        {counters.attention > 0 && (
          <p className="rounded-lg bg-tone-warning-bg p-3 text-body text-tone-warning-fg">
            {m.health.attention(counters.attention)}{" "}
            <Link className="underline" href="/admin/plati?vedere=atentie">
              {m.health.attentionLink}
            </Link>
          </p>
        )}
        {counters.stuckEvents > 0 && (
          <div className="rounded-lg bg-tone-problem-bg p-3 text-tone-problem-fg">
            <p className="font-medium">{m.health.stuck(counters.stuckEvents)}</p>
            <p className="text-body">{m.health.stuckHelp}</p>
          </div>
        )}
      </section>

      <Section id="card-provider" title={m.cardProvider.title}>
        <CardProviderChoice initial={payment.cardProvider} options={options} canWrite={canWrite} />
      </Section>

      <div className="flex flex-col gap-4">
        {cards.map((card) => (
          <ProviderCard key={card.code} provider={card} canWrite={canWrite} />
        ))}
      </div>
    </div>
  );
}
