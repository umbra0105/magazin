import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getEmailOverride } from "@ecom/core";
import { getDb } from "@ecom/db";
import { renderTemplateEmail, sampleContext, templateDefinition } from "@ecom/jobs";
import { Badge, Section } from "@ecom/ui";
import { OverrideForm, TestSendForm } from "@/components/admin/email/template-forms";
import { requireAdmin } from "@/lib/admin-page";
import { currentTheme } from "@/lib/email-admin";
import { getMessages } from "@/messages";

const m = getMessages().admin.email;

export const metadata: Metadata = { title: m.title };
export const dynamic = "force-dynamic";

/**
 * Un șablon: variabilele permise, textul propriu (subiect și început), previzualizarea cu date de probă (marcate clar) și emailul
 * de test. Cere `email.read`; salvarea, revenirea la implicit și testul cer `email.write`. Previzualizarea folosește textul SALVAT.
 */
export default async function EmailTemplatePage({ params }: { params: Promise<{ key: string }> }) {
  const subject = await requireAdmin({ permission: "email.read" });
  const { key } = await params;
  const definition = templateDefinition(key);
  if (!definition) notFound();
  const canWrite = can(subject, "email.write");
  const override = await getEmailOverride(getDb(), definition.key);
  const rendered = await renderTemplateEmail(
    await currentTheme(),
    definition.key,
    sampleContext(definition),
    {
      override: override ? { subject: override.subject, intro: override.intro } : null,
      sample: true,
    },
  );

  return (
    <div className="flex max-w-5xl flex-col gap-6" data-email-template={definition.key}>
      <div className="flex flex-col gap-2">
        <Link
          href="/admin/comenzi/sabloane-email"
          className="text-body text-link underline-offset-2 hover:underline"
        >
          {m.back}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-title">{m.detail.title(definition.label)}</h1>
          <Badge variant={definition.wired ? "success" : "neutral"} dot>
            {definition.wired ? m.wired : m.notWired}
          </Badge>
          <Badge variant="neutral">{m.audience[definition.audience]}</Badge>
        </div>
        <p className="text-body text-ink-secondary">{definition.description}</p>
        {definition.phaseNote && (
          <p role="note" className="rounded-lg bg-surface-subtle p-3 text-body">
            {m.notWiredHelp(definition.phaseNote)}
          </p>
        )}
        {!canWrite && (
          <p role="note" className="rounded-lg bg-surface-subtle p-3 text-body">
            {m.readOnly}
          </p>
        )}
      </div>

      <Section id="variables" title={m.detail.variables} description={m.detail.variablesHelp}>
        <dl className="grid gap-x-6 gap-y-2 md:grid-cols-2">
          {definition.variables.map((variable) => (
            <div key={variable.name} className="flex flex-col">
              <dt>
                <code className="rounded-sm bg-surface-subtle px-1.5 py-0.5">{`{{${variable.name}}}`}</code>
              </dt>
              <dd className="text-label text-ink-secondary">
                {variable.description} ({m.detail.sampleValue(variable.sample)})
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="override" title={m.detail.overrideTitle}>
        <OverrideForm
          template={definition.key}
          canWrite={canWrite}
          defaults={{ subject: definition.defaultSubject, intro: definition.defaultIntro }}
          initial={override ? { subject: override.subject, intro: override.intro } : null}
        />
      </Section>

      <Section id="preview" title={m.detail.previewTitle} description={m.detail.previewHelp}>
        <p data-preview-subject>
          <strong>{m.detail.previewSubject}:</strong> {rendered.subject}
        </p>
        <iframe
          title={m.detail.previewTitle}
          srcDoc={rendered.html}
          sandbox=""
          className="h-144 w-full rounded-lg border border-line-control bg-surface-page"
          data-email-preview
        />
        <details>
          <summary className="cursor-pointer text-body">{m.detail.textTab}</summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-surface-subtle p-3 text-compact">
            {rendered.text}
          </pre>
        </details>
      </Section>

      {canWrite && (
        <Section id="test" title={m.detail.testSend}>
          <TestSendForm template={definition.key} />
        </Section>
      )}
    </div>
  );
}
