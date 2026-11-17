"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Input, Label, SaveBar, Section } from "@ecom/ui";
import { saveCartSettings } from "@/app/(admin)/admin/setari/cos/actions";
import { UnsavedChangesProvider, useDirtyFlag } from "@/components/admin/products/unsaved-changes";
import { parseMoneyInput } from "@/lib/money-input";
import { getMessages } from "@/messages";

const m = getMessages().admin.cartSettings;

export interface CartSettingsValues {
  threshold: string;
}

export function CartSettingsForm(props: {
  initial: CartSettingsValues;
  canSave: boolean;
  currency: string;
}) {
  return (
    <UnsavedChangesProvider message={getMessages().admin.products.editor.unsavedConfirm}>
      <Form {...props} />
    </UnsavedChangesProvider>
  );
}

function Form({
  initial,
  canSave,
  currency,
}: {
  initial: CartSettingsValues;
  canSave: boolean;
  currency: string;
}) {
  const router = useRouter();
  const base = useId();
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startSave] = useTransition();
  const [focusTick, setFocusTick] = useState(0);
  const thresholdRef = useRef<HTMLInputElement>(null);

  const dirty = form.threshold.trim() !== saved.threshold.trim();
  useDirtyFlag("cart-settings", dirty);
  useEffect(() => {
    if (focusTick > 0) thresholdRef.current?.focus();
  }, [focusTick]);

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave || pending) return;
    setProblem(null);
    setStatus(null);
    const text = form.threshold.trim();
    const minor = text === "" ? null : parseMoneyInput(text);
    if (text !== "" && (minor === null || minor < 1)) {
      setError(m.thresholdInvalid);
      setProblem(m.fixErrors);
      setFocusTick((tick) => tick + 1);
      return;
    }
    setError(null);
    startSave(async () => {
      try {
        const result = await saveCartSettings({ threshold: text });
        if (result.ok) {
          const next = { threshold: text };
          setSaved(next);
          setForm(next);
          setStatus(m.saved);
          router.refresh();
        } else {
          setError(m.thresholdInvalid);
          setProblem(m.fixErrors);
          setFocusTick((tick) => tick + 1);
        }
      } catch {
        setProblem(m.saveFailed);
      }
    });
  };

  const savedText = saved.threshold.trim();
  return (
    <form noValidate onSubmit={onSubmit} className="flex max-w-3xl flex-col gap-8">
      <Section id="free-shipping" title={m.title}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-threshold`}>
            {m.threshold} ({currency})
          </Label>
          <Input
            id={`${base}-threshold`}
            ref={thresholdRef}
            inputMode="decimal"
            autoComplete="off"
            value={form.threshold}
            disabled={!canSave}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${base}-threshold-help${error ? ` ${base}-threshold-error` : ""}`}
            onChange={(event) => {
              setStatus(null);
              setForm({ threshold: event.target.value });
            }}
            className="max-w-48"
          />
          <p id={`${base}-threshold-help`} className="text-label text-ink-secondary">
            {m.thresholdHelp}
          </p>
          {error ? (
            <p
              id={`${base}-threshold-error`}
              role="alert"
              className="text-label text-tone-problem-fg"
            >
              {error}
            </p>
          ) : null}
        </div>
        <p role="status" data-threshold-state className="text-body text-ink-secondary">
          {savedText === "" ? m.thresholdOff : m.thresholdOn(`${savedText} ${currency}`)}
        </p>
        <p className="text-label text-ink-secondary">{m.delayNote}</p>
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
