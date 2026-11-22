"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { Input, Label, SaveBar, Section } from "@ecom/ui";
import { saveCompanySettings } from "@/app/(admin)/admin/setari/firma/actions";
import { UnsavedChangesProvider, useDirtyFlag } from "@/components/admin/products/unsaved-changes";
import { getMessages } from "@/messages";

const m = getMessages().admin.invoicing.company;

export interface CompanyValues {
  legalName: string;
  vatId: string;
  tradeRegisterNo: string;
  isVatPayer: boolean;
  phone: string;
  email: string;
  street: string;
  city: string;
  county: string;
  postalCode: string;
  country: string;
  iban: string;
  bankName: string;
  pickupHours: string;
  anpcUrl: string;
  salUrl: string;
  odrUrl: string;
}

type TextKey = Exclude<keyof CompanyValues, "isVatPayer">;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CompanyForm(props: {
  initial: CompanyValues;
  canSave: boolean;
  /** Cota standard de TVA în procente, doar pentru afișare (nu se schimbă de aici). */
  vatPercent: string;
}) {
  return (
    <UnsavedChangesProvider message={getMessages().admin.products.editor.unsavedConfirm}>
      <Form {...props} />
    </UnsavedChangesProvider>
  );
}

const normalize = (v: CompanyValues) => JSON.stringify(v);

function Form({
  initial,
  canSave,
  vatPercent,
}: {
  initial: CompanyValues;
  canSave: boolean;
  vatPercent: string;
}) {
  const router = useRouter();
  const base = useId();
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startSave] = useTransition();
  const [focusTick, setFocusTick] = useState(0);
  const [focusField, setFocusField] = useState<string | null>(null);

  const dirty = normalize(form) !== normalize(saved);
  useDirtyFlag("company-settings", dirty);
  useEffect(() => {
    if (focusTick > 0 && focusField) document.getElementById(`${base}-${focusField}`)?.focus();
  }, [focusTick, focusField, base]);

  const set = (patch: Partial<CompanyValues>) => {
    setStatus(null);
    setForm((previous) => ({ ...previous, ...patch }));
  };

  const errorText = (code: string): string =>
    m.errors[code as keyof typeof m.errors] ?? m.fixErrors;

  const failWith = (found: Record<string, string>) => {
    setErrors(found);
    setProblem(m.fixErrors);
    const first = Object.keys(found)[0];
    if (first) {
      setFocusField(first);
      setFocusTick((tick) => tick + 1);
    }
  };

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave || pending) return;
    setProblem(null);
    setStatus(null);
    const found: Record<string, string> = {};
    const email = form.email.trim();
    if (email !== "" && !EMAIL.test(email)) found["email"] = "email";
    if (!/^[A-Za-z]{2}$/.test(form.country.trim())) found["country"] = "country";
    const iban = form.iban.replace(/\s+/g, "");
    if (iban !== "" && !/^[A-Za-z]{2}[0-9A-Za-z]{13,32}$/.test(iban)) found["iban"] = "iban";
    if (!/^[0-9A-Za-z]{0,20}$/.test(form.vatId.replace(/\s+/g, ""))) found["vatId"] = "vatId";
    if (form.pickupHours.trim().length > 300 || /[<>]/.test(form.pickupHours))
      found["pickupHours"] = "pickupHours";
    for (const key of ["anpcUrl", "salUrl", "odrUrl"] as const) {
      const value = form[key].trim();
      if (value !== "" && !/^https:\/\/\S+$/.test(value)) found[key] = "url";
    }
    if (Object.keys(found).length > 0) {
      failWith(found);
      return;
    }
    setErrors({});
    startSave(async () => {
      try {
        const result = await saveCompanySettings(form);
        if (result.ok) {
          setSaved(form);
          setStatus(m.saved);
          router.refresh();
        } else {
          const fields = Object.fromEntries(
            Object.entries(result.errors).filter(([key]) => key !== "form"),
          );
          if (Object.keys(fields).length > 0) failWith(fields);
          else setProblem(m.saveFailed);
        }
      } catch {
        setProblem(m.saveFailed);
      }
    });
  };

  const text = (key: TextKey, label: string, help?: string, wide = false) => (
    <div className={wide ? "flex flex-col gap-1.5 md:col-span-2" : "flex flex-col gap-1.5"}>
      <Label htmlFor={`${base}-${key}`}>{label}</Label>
      <Input
        id={`${base}-${key}`}
        value={form[key]}
        disabled={!canSave}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `${base}-${key}-err` : undefined}
        onChange={(event) => set({ [key]: event.target.value } as Partial<CompanyValues>)}
      />
      {help ? <span className="text-label text-ink-secondary">{help}</span> : null}
      {errors[key] ? (
        <span id={`${base}-${key}-err`} className="text-label text-tone-problem-fg">
          {errorText(errors[key] as string)}
        </span>
      ) : null}
    </div>
  );

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-6" data-company-form>
      <Section id="company-identity" title={m.sections.identity}>
        <div className="grid gap-4 md:grid-cols-2">
          {text("legalName", m.legalName)}
          {text("vatId", m.vatId, m.vatIdHelp)}
          {text("tradeRegisterNo", m.tradeRegisterNo)}
          <div className="flex flex-col gap-1">
            <label className="flex min-h-11 items-center gap-2 text-body md:min-h-0">
              <input
                type="checkbox"
                className="size-4 accent-brand"
                checked={form.isVatPayer}
                disabled={!canSave}
                onChange={(event) => set({ isVatPayer: event.target.checked })}
              />
              {m.isVatPayer}
            </label>
          </div>
        </div>
      </Section>
      <Section id="company-contact" title={m.sections.contact}>
        <div className="grid gap-4 md:grid-cols-2">
          {text("phone", m.phone)}
          {text("email", m.email)}
        </div>
      </Section>
      <Section id="company-address" title={m.sections.address}>
        <p className="text-body text-ink-secondary">{m.addressHelp}</p>
        <div className="grid gap-4 md:grid-cols-2">
          {text("street", m.street, undefined, true)}
          {text("city", m.city)}
          {text("county", m.county)}
          {text("postalCode", m.postalCode)}
          {text("country", m.country)}
        </div>
      </Section>
      <Section id="company-bank" title={m.sections.bank}>
        <div className="grid gap-4 md:grid-cols-2">
          {text("iban", m.iban)}
          {text("bankName", m.bankName)}
        </div>
      </Section>
      <Section id="company-pickup" title={m.sections.pickup}>
        <div className="grid gap-4">
          {text("pickupHours", m.pickupHours, m.pickupHoursHelp, true)}
        </div>
      </Section>
      <Section id="company-legal" title={m.sections.legal}>
        <div className="grid gap-4 md:grid-cols-2">
          {text("anpcUrl", m.anpcUrl)}
          {text("salUrl", m.salUrl)}
          {text("odrUrl", m.odrUrl)}
        </div>
      </Section>
      <Section id="company-vat" title={m.sections.vat}>
        <p className="text-body" data-vat-rate>
          {m.vatRate}: <strong>{m.vatRateValue(vatPercent)}</strong>
        </p>
        <p className="text-label text-ink-secondary">{m.vatRateHelp}</p>
      </Section>
      <SaveBar
        pending={pending}
        canSave={canSave}
        dirty={dirty}
        status={status}
        problem={problem}
        labels={{ save: m.save, saving: m.saving, unsavedMark: m.unsaved }}
      />
    </form>
  );
}
