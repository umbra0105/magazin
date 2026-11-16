"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Label, SaveBar, Section, Textarea } from "@ecom/ui";
import { saveMaintenance } from "@/app/(admin)/admin/setari/mentenanta/actions";
import { UnsavedChangesProvider, useDirtyFlag } from "@/components/admin/products/unsaved-changes";
import { getMessages } from "@/messages";

const m = getMessages().admin.maintenance;

export interface MaintenanceValues {
  enabled: boolean;
  message: string;
}

export function MaintenanceForm(props: {
  initial: MaintenanceValues;
  canSave: boolean;
  maxLength: number;
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
  maxLength,
}: {
  initial: MaintenanceValues;
  canSave: boolean;
  maxLength: number;
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
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const dirty = form.enabled !== saved.enabled || form.message.trim() !== saved.message.trim();
  useDirtyFlag("maintenance", dirty);
  useEffect(() => {
    if (focusTick > 0) messageRef.current?.focus();
  }, [focusTick]);

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave || pending) return;
    setProblem(null);
    setStatus(null);
    startSave(async () => {
      try {
        const result = await saveMaintenance({ enabled: form.enabled, message: form.message });
        if (result.ok) {
          setError(null);
          const next = { enabled: form.enabled, message: form.message.trim() };
          setSaved(next);
          setForm(next);
          setStatus(m.saved);
          router.refresh();
        } else {
          setError(result.errors["message"] ? m.messageInvalid : null);
          setProblem(m.fixErrors);
          setFocusTick((tick) => tick + 1);
        }
      } catch {
        setProblem(m.saveFailed);
      }
    });
  };

  return (
    <form noValidate onSubmit={onSubmit} className="flex max-w-3xl flex-col gap-8">
      <Section id="maintenance" title={m.title}>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={!canSave}
            onChange={(event) => {
              setStatus(null);
              setForm({ ...form, enabled: event.target.checked });
            }}
            className="size-4"
          />
          <span>{m.enabled}</span>
        </label>
        <p role="status" data-maintenance-state className="text-body text-ink-secondary">
          {saved.enabled ? m.enabledOn : m.enabledOff}
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-message`}>{m.message}</Label>
          <Textarea
            id={`${base}-message`}
            ref={messageRef}
            rows={4}
            value={form.message}
            disabled={!canSave}
            maxLength={maxLength}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${base}-message-error` : undefined}
            onChange={(event) => {
              setStatus(null);
              setForm({ ...form, message: event.target.value });
            }}
          />
          <p className="text-label text-ink-secondary">
            {m.messageHelp} {m.messageHint(form.message.length, maxLength)}
          </p>
          {error ? (
            <p
              id={`${base}-message-error`}
              role="alert"
              className="text-label text-tone-problem-fg"
            >
              {error}
            </p>
          ) : null}
        </div>
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
