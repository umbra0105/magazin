"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Button, Input, Label, Textarea } from "@ecom/ui";
import { saveInvoicingTexts } from "@/app/(admin)/admin/setari/facturare/actions";
import { parseUnitNames } from "@/lib/invoicing-texts";
import { getMessages } from "@/messages";

const m = getMessages().admin.invoicing.settings.texts;

export interface InvoicingTextsValues {
  shippingLabel: string;
  codFeeLabel: string;
  pointsDiscountLabel: string;
  serviceUnit: string;
  unitNames: string;
  sendEmailByProvider: boolean;
}

/** Textele și unitățile de pe factură (denumirea transportului și a taxei de ramburs, numele unităților din contul furnizorului). */
export function InvoicingTextsForm({
  initial,
  canWrite,
}: {
  initial: InvoicingTextsValues;
  canWrite: boolean;
}) {
  const router = useRouter();
  const base = useId();
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const set = (patch: Partial<InvoicingTextsValues>) => {
    setStatus(null);
    setForm((previous) => ({ ...previous, ...patch }));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite || pending) return;
    const found: Record<string, string> = {};
    for (const key of [
      "shippingLabel",
      "codFeeLabel",
      "pointsDiscountLabel",
      "serviceUnit",
    ] as const) {
      const value = form[key].trim();
      if (value === "" || value.length > (key === "serviceUnit" ? 40 : 80))
        found[key] = m.invalidText;
    }
    if (parseUnitNames(form.unitNames) === null) found["unitNames"] = m.invalidUnits;
    setErrors(found);
    setProblem(null);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(`${base}-${first}`)?.focus();
      return;
    }
    start(async () => {
      const result = await saveInvoicingTexts(form);
      if (result.ok) {
        setStatus(m.saved);
        router.refresh();
      } else {
        setErrors(
          Object.fromEntries(
            Object.keys(result.errors).map((key) => [
              key,
              key === "unitNames" ? m.invalidUnits : m.invalidText,
            ]),
          ),
        );
        setProblem(getMessages().admin.invoicing.settings.saveFailed);
      }
    });
  };

  const field = (
    key: "shippingLabel" | "codFeeLabel" | "pointsDiscountLabel" | "serviceUnit",
    label: string,
    help?: string,
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${base}-${key}`}>{label}</Label>
      <Input
        id={`${base}-${key}`}
        value={form[key]}
        disabled={!canWrite}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `${base}-${key}-err` : undefined}
        onChange={(event) => set({ [key]: event.target.value })}
      />
      {help ? <span className="text-label text-ink-secondary">{help}</span> : null}
      {errors[key] ? (
        <span id={`${base}-${key}-err`} className="text-label text-tone-problem-fg">
          {errors[key]}
        </span>
      ) : null}
    </div>
  );

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4" data-invoicing-texts>
      <p className="text-body text-ink-secondary">{m.description}</p>
      <div className="grid gap-4 md:grid-cols-2">
        {field("shippingLabel", m.shippingLabel)}
        {field("codFeeLabel", m.codFeeLabel)}
        {field("pointsDiscountLabel", m.pointsDiscountLabel, m.pointsDiscountHelp)}
        {field("serviceUnit", m.serviceUnit, m.serviceUnitHelp)}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${base}-unitNames`}>{m.unitNames}</Label>
        <Textarea
          id={`${base}-unitNames`}
          rows={4}
          value={form.unitNames}
          disabled={!canWrite}
          aria-invalid={errors["unitNames"] ? true : undefined}
          onChange={(event) => set({ unitNames: event.target.value })}
        />
        <span className="text-label text-ink-secondary">{m.unitNamesHelp}</span>
        {errors["unitNames"] ? (
          <span className="text-label text-tone-problem-fg">{errors["unitNames"]}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex min-h-11 items-center gap-2 text-body md:min-h-0">
          <input
            type="checkbox"
            className="size-4 accent-brand"
            checked={form.sendEmailByProvider}
            disabled={!canWrite}
            onChange={(event) => set({ sendEmailByProvider: event.target.checked })}
          />
          {m.sendEmail}
        </label>
        <span className="text-label text-ink-secondary">{m.sendEmailHelp}</span>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!canWrite || pending}>
          {m.save}
        </Button>
        <span role="status" aria-live="polite" className="text-body text-ink-secondary">
          {status}
        </span>
      </div>
      {problem ? (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {problem}
        </p>
      ) : null}
    </form>
  );
}
