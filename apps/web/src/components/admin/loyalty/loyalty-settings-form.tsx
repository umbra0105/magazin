"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { Input, Label, SaveBar, Section, Select } from "@ecom/ui";
import { saveLoyaltySettings } from "@/app/(admin)/admin/setari/puncte/actions";
import { UnsavedChangesProvider, useDirtyFlag } from "@/components/admin/products/unsaved-changes";
import { parseMoneyInput } from "@/lib/money-input";
import { getMessages } from "@/messages";

const m = getMessages().admin.loyalty.settings;

export interface LoyaltySettingsValues {
  enabled: boolean;
  vatMode: "" | "base_reduced";
  earnRate: string;
  earnOnDiscountedItems: boolean;
  pointValue: string;
  minRedeemPoints: string;
  maxRedeemPercent: string;
  minCashAmount: string;
  expiryMonths: string;
  expiryWarningDays: string;
  releasedGraceDays: string;
}

type TextField = Exclude<
  keyof LoyaltySettingsValues,
  "enabled" | "vatMode" | "earnOnDiscountedItems"
>;

const MONEY: readonly TextField[] = ["earnRate", "pointValue", "minCashAmount"];
/** Limitele numerelor întregi, aceleași cu schema din registrul de setări (serverul o aplică din nou). */
const RANGES: Partial<Record<TextField, readonly [number, number]>> = {
  minRedeemPoints: [1, 1_000_000],
  maxRedeemPercent: [1, 100],
  expiryMonths: [1, 120],
  expiryWarningDays: [1, 365],
  releasedGraceDays: [0, 365],
};

function problemOf(name: TextField, text: string): string | null {
  const value = text.trim();
  if (MONEY.includes(name)) {
    const minor = parseMoneyInput(value);
    return minor === null || minor < 1 ? m.moneyInvalid : null;
  }
  const [min, max] = RANGES[name] ?? [0, 0];
  if (name === "maxRedeemPercent" && value === "") return null;
  const number = /^\d{1,9}$/.test(value) ? Number(value) : Number.NaN;
  return number >= min && number <= max ? null : m.intInvalid(min, max);
}

export function LoyaltySettingsForm(props: { initial: LoyaltySettingsValues; currency: string }) {
  return (
    <UnsavedChangesProvider message={getMessages().admin.products.editor.unsavedConfirm}>
      <Form {...props} />
    </UnsavedChangesProvider>
  );
}

function Form({ initial, currency }: { initial: LoyaltySettingsValues; currency: string }) {
  const router = useRouter();
  const base = useId();
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startSave] = useTransition();
  const [focus, setFocus] = useState<{ field: string; tick: number } | null>(null);

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  useDirtyFlag("loyalty-settings", dirty);
  useEffect(() => {
    if (focus) document.getElementById(`${base}-${focus.field}`)?.focus();
  }, [focus, base]);

  const set = (patch: Partial<LoyaltySettingsValues>) => {
    setStatus(null);
    setForm((previous) => ({ ...previous, ...patch }));
  };
  const failWith = (found: Record<string, string>) => {
    setErrors(found);
    setProblem(m.fixErrors);
    const first = Object.keys(found)[0];
    if (first) setFocus((previous) => ({ field: first, tick: (previous?.tick ?? 0) + 1 }));
  };
  const textFields: readonly TextField[] = [
    "earnRate",
    "pointValue",
    "minRedeemPoints",
    "maxRedeemPercent",
    "minCashAmount",
    "expiryMonths",
    "expiryWarningDays",
    "releasedGraceDays",
  ];

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setProblem(null);
    setStatus(null);
    const found: Record<string, string> = {};
    for (const name of textFields) {
      const message = problemOf(name, form[name]);
      if (message) found[name] = message;
    }
    if (Object.keys(found).length > 0) {
      failWith(found);
      return;
    }
    setErrors({});
    startSave(async () => {
      try {
        const result = await saveLoyaltySettings(form);
        if (result.ok) {
          setSaved(form);
          setStatus(m.saved);
          router.refresh();
        } else {
          const mapped: Record<string, string> = {};
          for (const key of Object.keys(result.errors)) {
            mapped[key] = textFields.includes(key as TextField)
              ? (problemOf(key as TextField, form[key as TextField]) ?? m.fixErrors)
              : m.fixErrors;
          }
          failWith(mapped);
        }
      } catch {
        setProblem(m.saveFailed);
      }
    });
  };

  const text = (name: TextField, label: string, help?: string) => {
    const describedBy = [
      help ? `${base}-${name}-help` : null,
      errors[name] ? `${base}-${name}-error` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${base}-${name}`}>
          {label}
          {MONEY.includes(name) ? ` (${currency})` : ""}
        </Label>
        <Input
          id={`${base}-${name}`}
          name={name}
          inputMode={MONEY.includes(name) ? "decimal" : "numeric"}
          autoComplete="off"
          value={form[name]}
          aria-invalid={errors[name] ? true : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => set({ [name]: event.target.value })}
          className="max-w-48"
        />
        {help ? (
          <p id={`${base}-${name}-help`} className="text-label text-ink-secondary">
            {help}
          </p>
        ) : null}
        {errors[name] ? (
          <p id={`${base}-${name}-error`} role="alert" className="text-label text-tone-problem-fg">
            {errors[name]}
          </p>
        ) : null}
      </div>
    );
  };
  const toggle = (name: "enabled" | "earnOnDiscountedItems", label: string) => (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        name={name}
        checked={form[name]}
        onChange={(event) => set({ [name]: event.target.checked })}
        className="size-4"
      />
      <span>{label}</span>
    </label>
  );

  return (
    <form noValidate onSubmit={onSubmit} className="flex max-w-3xl flex-col gap-8">
      <Section id="loyalty-program" title={m.sections.program}>
        {toggle("enabled", m.enabled)}
        <p className="text-label text-ink-secondary">{m.enabledHelp}</p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-vatMode`}>{m.vatMode}</Label>
          <Select
            id={`${base}-vatMode`}
            name="vatMode"
            value={form.vatMode}
            aria-describedby={`${base}-vatMode-warning`}
            onChange={(event) =>
              set({ vatMode: event.target.value === "base_reduced" ? "base_reduced" : "" })
            }
            className="max-w-md"
          >
            <option value="">{m.vatModeNone}</option>
            <option value="base_reduced">{m.vatModeReduced}</option>
          </Select>
          <p
            id={`${base}-vatMode-warning`}
            role="note"
            className="rounded-lg bg-tone-warning-bg p-3 text-body text-tone-warning-fg"
            data-vat-warning
          >
            {m.vatModeWarning}
          </p>
        </div>
      </Section>

      <Section id="loyalty-earn" title={m.sections.earn}>
        {text("earnRate", m.earnRate, m.earnRateHelp)}
        {toggle("earnOnDiscountedItems", m.earnOnDiscounted)}
      </Section>

      <Section id="loyalty-redeem" title={m.sections.redeem}>
        {text("pointValue", m.pointValue, m.pointValueHelp)}
        {text("minRedeemPoints", m.minRedeem)}
        {text("maxRedeemPercent", m.maxPercent, m.maxPercentHelp)}
        {text("minCashAmount", m.minCash, m.minCashHelp)}
      </Section>

      <Section id="loyalty-expiry" title={m.sections.expiry}>
        {text("expiryMonths", m.expiryMonths)}
        {text("expiryWarningDays", m.warningDays)}
        {text("releasedGraceDays", m.graceDays, m.graceDaysHelp)}
      </Section>

      <SaveBar
        pending={pending}
        canSave
        dirty={dirty}
        status={status}
        problem={problem}
        labels={{ save: m.save, saving: m.saving, unsavedMark: m.unsaved }}
      />
    </form>
  );
}
