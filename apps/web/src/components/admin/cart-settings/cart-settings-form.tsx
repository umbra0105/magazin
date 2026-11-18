"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Input, Label, SaveBar, Section, Textarea } from "@ecom/ui";
import { saveCartSettings } from "@/app/(admin)/admin/setari/cos/actions";
import { UnsavedChangesProvider, useDirtyFlag } from "@/components/admin/products/unsaved-changes";
import { parseMoneyInput } from "@/lib/money-input";
import { getMessages } from "@/messages";

const m = getMessages().admin.cartSettings;

type ShippingClassKey = "standard" | "oversized" | "pallet";
const CLASS_KEYS: readonly ShippingClassKey[] = ["standard", "oversized", "pallet"];

export interface CartSettingsValues {
  threshold: string;
  classes: ShippingClassKey[];
  pickupEnabled: boolean;
  groundNotice: string;
  codIndividual: string;
  codCompany: string;
  orderPrefix: string;
  orderDigits: string;
  nonWorkingDates: string;
}

export function CartSettingsForm(props: {
  initial: CartSettingsValues;
  canSave: boolean;
  currency: string;
  /** Zona produselor excluse (acțiuni proprii, cu salvare imediată). */
  extra?: React.ReactNode;
}) {
  return (
    <UnsavedChangesProvider message={getMessages().admin.products.editor.unsavedConfirm}>
      <Form {...props} />
    </UnsavedChangesProvider>
  );
}

const normalize = (v: CartSettingsValues) =>
  JSON.stringify({
    ...v,
    threshold: v.threshold.trim(),
    groundNotice: v.groundNotice.trim(),
    codIndividual: v.codIndividual.trim(),
    codCompany: v.codCompany.trim(),
    orderPrefix: v.orderPrefix.trim(),
    orderDigits: v.orderDigits.trim(),
    nonWorkingDates: v.nonWorkingDates
      .split(/[\n,;]+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort(),
    classes: [...v.classes].sort(),
  });

function Form({
  initial,
  canSave,
  currency,
  extra,
}: {
  initial: CartSettingsValues;
  canSave: boolean;
  currency: string;
  extra?: React.ReactNode;
}) {
  const router = useRouter();
  const base = useId();
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startSave] = useTransition();
  const [focusField, setFocusField] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const thresholdRef = useRef<HTMLInputElement>(null);

  const dirty = normalize(form) !== normalize(saved);
  useDirtyFlag("cart-settings", dirty);
  useEffect(() => {
    if (focusTick > 0 && focusField) document.getElementById(`${base}-${focusField}`)?.focus();
  }, [focusTick, focusField, base]);

  const set = (patch: Partial<CartSettingsValues>) => {
    setStatus(null);
    setForm((previous) => ({ ...previous, ...patch }));
  };

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
    const thresholdText = form.threshold.trim();
    if (thresholdText !== "") {
      const minor = parseMoneyInput(thresholdText);
      if (minor === null || minor < 1) found["threshold"] = m.thresholdInvalid;
    }
    if (parseMoneyInput(form.codIndividual.trim()) === null) found["codIndividual"] = m.codInvalid;
    if (parseMoneyInput(form.codCompany.trim()) === null) found["codCompany"] = m.codInvalid;
    if (!/^[A-Za-z0-9-]{0,10}$/.test(form.orderPrefix.trim()))
      found["orderPrefix"] = m.orderPrefixInvalid;
    const digits = Number(form.orderDigits);
    if (!Number.isInteger(digits) || digits < 1 || digits > 12)
      found["orderDigits"] = m.orderDigitsInvalid;
    if (form.groundNotice.trim().length > 500) found["groundNotice"] = m.groundNoticeInvalid;
    if (Object.keys(found).length > 0) {
      failWith(found);
      return;
    }
    setErrors({});
    startSave(async () => {
      try {
        const result = await saveCartSettings({
          threshold: thresholdText,
          classes: form.classes,
          pickupEnabled: form.pickupEnabled,
          groundNotice: form.groundNotice,
          codIndividual: form.codIndividual,
          codCompany: form.codCompany,
          orderPrefix: form.orderPrefix,
          orderDigits: digits,
          nonWorkingDates: form.nonWorkingDates,
        });
        if (result.ok) {
          setSaved(form);
          setStatus(m.saved);
          router.refresh();
        } else {
          const messages: Record<string, string> = {
            threshold: m.thresholdInvalid,
            codIndividual: m.codInvalid,
            codCompany: m.codInvalid,
            orderPrefix: m.orderPrefixInvalid,
            orderDigits: m.orderDigitsInvalid,
            groundNotice: m.groundNoticeInvalid,
            nonWorkingDates: m.nonWorkingDatesInvalid,
          };
          const mapped: Record<string, string> = {};
          for (const key of Object.keys(result.errors))
            mapped[key] = messages[key] ?? m.saveFailedField;
          failWith(mapped);
        }
      } catch {
        setProblem(m.saveFailed);
      }
    });
  };

  const field = (name: string) => ({
    id: `${base}-${name}`,
    "aria-invalid": errors[name] ? (true as const) : undefined,
    "aria-describedby": errors[name] ? `${base}-${name}-error` : `${base}-${name}-help`,
  });
  const errorFor = (name: string) =>
    errors[name] ? (
      <p id={`${base}-${name}-error`} role="alert" className="text-label text-tone-problem-fg">
        {errors[name]}
      </p>
    ) : null;

  const savedThreshold = saved.threshold.trim();
  return (
    <form noValidate onSubmit={onSubmit} className="flex max-w-3xl flex-col gap-8">
      <Section id="free-shipping" title={m.sections.freeShipping}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-threshold`}>
            {m.threshold} ({currency})
          </Label>
          <Input
            {...field("threshold")}
            ref={thresholdRef}
            inputMode="decimal"
            autoComplete="off"
            value={form.threshold}
            disabled={!canSave}
            onChange={(event) => set({ threshold: event.target.value })}
            className="max-w-48"
          />
          <p id={`${base}-threshold-help`} className="text-label text-ink-secondary">
            {m.thresholdHelp}
          </p>
          {errorFor("threshold")}
        </div>
        <p role="status" data-threshold-state className="text-body text-ink-secondary">
          {savedThreshold === "" ? m.thresholdOff : m.thresholdOn(`${savedThreshold} ${currency}`)}
        </p>
        <fieldset className="flex flex-col gap-2" data-free-shipping-classes>
          <legend className="text-label font-medium">{m.classesTitle}</legend>
          {CLASS_KEYS.map((key) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.classes.includes(key)}
                disabled={!canSave}
                onChange={(event) =>
                  set({
                    classes: event.target.checked
                      ? [...form.classes, key]
                      : form.classes.filter((candidate) => candidate !== key),
                  })
                }
                className="size-4"
              />
              <span>{m.classes[key]}</span>
            </label>
          ))}
          <p className="text-label text-ink-secondary">{m.classesHelp}</p>
        </fieldset>
        {extra}
        <p className="text-label text-ink-secondary">{m.delayNote}</p>
      </Section>

      <Section id="shipping" title={m.sections.shipping}>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.pickupEnabled}
            disabled={!canSave}
            onChange={(event) => set({ pickupEnabled: event.target.checked })}
            className="size-4"
          />
          <span>{m.pickup}</span>
        </label>
        <p className="text-label text-ink-secondary">{m.pickupHelp}</p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-groundNotice`}>{m.groundNotice}</Label>
          <Textarea
            {...field("groundNotice")}
            rows={3}
            maxLength={500}
            value={form.groundNotice}
            disabled={!canSave}
            onChange={(event) => set({ groundNotice: event.target.value })}
          />
          <p id={`${base}-groundNotice-help`} className="text-label text-ink-secondary">
            {m.groundNoticeHelp}
          </p>
          {errorFor("groundNotice")}
        </div>
      </Section>

      <Section id="payment" title={m.sections.payment}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-codIndividual`}>
              {m.codIndividual} ({currency})
            </Label>
            <Input
              {...field("codIndividual")}
              inputMode="decimal"
              autoComplete="off"
              value={form.codIndividual}
              disabled={!canSave}
              onChange={(event) => set({ codIndividual: event.target.value })}
            />
            {errorFor("codIndividual")}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-codCompany`}>
              {m.codCompany} ({currency})
            </Label>
            <Input
              {...field("codCompany")}
              inputMode="decimal"
              autoComplete="off"
              value={form.codCompany}
              disabled={!canSave}
              onChange={(event) => set({ codCompany: event.target.value })}
            />
            {errorFor("codCompany")}
          </div>
        </div>
        <p id={`${base}-codIndividual-help`} className="text-label text-ink-secondary">
          {m.codHelp}
        </p>
      </Section>

      <Section id="orders" title={m.sections.orders}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-orderPrefix`}>{m.orderPrefix}</Label>
            <Input
              {...field("orderPrefix")}
              autoComplete="off"
              maxLength={10}
              value={form.orderPrefix}
              disabled={!canSave}
              onChange={(event) => set({ orderPrefix: event.target.value })}
            />
            <p id={`${base}-orderPrefix-help`} className="text-label text-ink-secondary">
              {m.orderPrefixHelp}
            </p>
            {errorFor("orderPrefix")}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-orderDigits`}>{m.orderDigits}</Label>
            <Input
              {...field("orderDigits")}
              inputMode="numeric"
              autoComplete="off"
              value={form.orderDigits}
              disabled={!canSave}
              onChange={(event) => set({ orderDigits: event.target.value })}
              className="max-w-32"
            />
            <p id={`${base}-orderDigits-help`} className="text-label text-ink-secondary">
              {m.orderDigitsHelp}
            </p>
            {errorFor("orderDigits")}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-nonWorkingDates`}>{m.nonWorkingDates}</Label>
          <Textarea
            {...field("nonWorkingDates")}
            rows={5}
            value={form.nonWorkingDates}
            disabled={!canSave}
            onChange={(event) => set({ nonWorkingDates: event.target.value })}
          />
          <p id={`${base}-nonWorkingDates-help`} className="text-label text-ink-secondary">
            {m.nonWorkingDatesHelp}
          </p>
          {errorFor("nonWorkingDates")}
        </div>
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
