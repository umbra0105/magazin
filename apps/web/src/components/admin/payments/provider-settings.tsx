"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Badge, Button, Dialog, Input, Label, Select, Textarea } from "@ecom/ui";
import {
  saveCardProviderChoice,
  saveProviderConfig,
  testProviderConnection,
} from "@/app/(admin)/admin/setari/plati/actions";
import { getMessages } from "@/messages";

const m = getMessages().admin.paymentSettings;

export interface ProviderFieldDto {
  key: string;
  label: string;
  required: boolean;
  multiline: boolean;
  hint: string | null;
}

export interface ProviderCardDto {
  code: "netopia" | "euplatesc" | "demo";
  label: string;
  real: boolean;
  fields: ProviderFieldDto[];
  saved: Record<string, boolean>;
  configured: boolean;
  isActive: boolean;
  mode: "test" | "live";
  /** Text deja formatat (data din fusul magazinului) sau `null`. */
  verifiedAtText: string | null;
}

/** Alegerea furnizorului pentru butonul «Card online» (`payment.cardProvider`). */
export function CardProviderChoice({
  initial,
  options,
  canWrite,
}: {
  initial: string;
  options: Array<{ code: string; label: string; usable: boolean }>;
  canWrite: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const selected = options.find((option) => option.code === value);
  const unusable = value !== "" && selected !== undefined && !selected.usable;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite || pending) return;
    setStatus(null);
    setProblem(null);
    start(async () => {
      const result = await saveCardProviderChoice({ provider: value });
      if (result.ok) {
        setStatus(m.cardProvider.saved);
        router.refresh();
      } else {
        setProblem(m.provider.errors[result.code] ?? m.provider.saveFailed);
      }
    });
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-body text-ink-secondary">{m.cardProvider.help}</p>
      <div className="flex max-w-md flex-col gap-1.5">
        <Label htmlFor={`${id}-provider`}>{m.cardProvider.label}</Label>
        <Select
          id={`${id}-provider`}
          value={value}
          disabled={!canWrite || pending}
          onChange={(event) => {
            setStatus(null);
            setValue(event.target.value);
          }}
        >
          <option value="">{m.cardProvider.none}</option>
          {options.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      {unusable && (
        <p role="note" className="rounded-lg bg-tone-warning-bg p-3 text-body text-tone-warning-fg">
          {m.cardProvider.unavailable}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" disabled={!canWrite || pending}>
          {m.cardProvider.save}
        </Button>
        <span role="status" aria-live="polite" className="text-body text-ink-secondary">
          {status}
        </span>
      </div>
      {problem && (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {problem}
        </p>
      )}
    </form>
  );
}

/** Configurarea unui furnizor: câmpuri de credențiale (niciodată pre-completate), mod, activare, test, trecere în LIVE. */
export function ProviderCard({
  provider,
  canWrite,
}: {
  provider: ProviderCardDto;
  canWrite: boolean;
}) {
  const router = useRouter();
  const base = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [active, setActive] = useState(provider.isActive);
  const [demoRefund, setDemoRefund] = useState("confirmed");
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [liveOpen, setLiveOpen] = useState(false);
  const [pending, start] = useTransition();
  const [testing, startTest] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});

  const payload = (extra: Record<string, unknown> = {}) => ({
    provider: provider.code,
    credentials: Object.fromEntries(
      Object.entries(values).filter(([, value]) => value.trim() !== ""),
    ),
    isActive: active,
    ...(provider.code === "demo" ? { demoRefund } : {}),
    ...extra,
  });

  const run = (extra: Record<string, unknown> = {}, onDone?: () => void) => {
    setStatus(null);
    setProblem(null);
    setErrors({});
    start(async () => {
      const result = await saveProviderConfig(payload(extra));
      if (result.ok) {
        setValues({});
        setStatus(result.revertedToTest ? m.provider.revertedToTest : m.provider.savedOk);
        onDone?.();
        router.refresh();
      } else {
        setProblem(m.provider.errors[result.code] ?? m.provider.saveFailed);
        if (result.code === "PAYMENT_CREDENTIALS_INVALID") setErrors({ form: "x" });
        onDone?.();
      }
    });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite || pending) return;
    // câmpurile obligatorii: dacă nu sunt salvate și nu sunt completate acum, activarea nu e posibilă
    if (provider.real && active) {
      const missing = provider.fields.find(
        (field) =>
          field.required && !provider.saved[field.key] && !(values[field.key] ?? "").trim(),
      );
      if (missing) {
        setProblem(m.provider.errors["PAYMENT_NOT_CONFIGURED"] ?? m.provider.fixErrors);
        setErrors({ [missing.key]: "required" });
        document.getElementById(`${base}-${missing.key}`)?.focus();
        return;
      }
    }
    run();
  };

  const check = () => {
    setTest(null);
    startTest(async () => {
      setTest(await testProviderConnection({ provider: provider.code }));
    });
  };

  const isLive = provider.mode === "live";

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-labelledby={`${base}-title`}
      className="flex flex-col gap-4 rounded-lg bg-surface-subtle p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${base}-title`} className="text-heading">
          {provider.label}
        </h3>
        <Badge variant={provider.configured ? "success" : "neutral"} dot>
          {provider.configured ? m.provider.configured : m.provider.notConfigured}
        </Badge>
        <Badge variant={provider.isActive ? "info" : "neutral"}>
          {provider.isActive ? m.provider.active : m.provider.inactive}
        </Badge>
        {provider.real && (
          <Badge variant={isLive ? "warning" : "neutral"}>
            {isLive ? m.provider.modeLive : m.provider.modeTest}
          </Badge>
        )}
      </div>

      {provider.real ? (
        <>
          <p className="text-body text-ink-secondary">
            {provider.verifiedAtText
              ? m.provider.verifiedAt(provider.verifiedAtText)
              : m.provider.notVerified}
          </p>
          <p className="text-body text-ink-secondary">{m.provider.unconfirmed}</p>
          <div className="grid gap-4 md:grid-cols-2">
            {provider.fields.map((field) => {
              const fieldId = `${base}-${field.key}`;
              const saved = provider.saved[field.key] === true;
              return (
                <div
                  key={field.key}
                  className={
                    field.multiline
                      ? "flex flex-col gap-1.5 md:col-span-2"
                      : "flex flex-col gap-1.5"
                  }
                >
                  <Label htmlFor={fieldId}>
                    {field.label}
                    {field.required ? ` (${m.provider.required})` : ""}
                  </Label>
                  {field.multiline ? (
                    <Textarea
                      id={fieldId}
                      rows={4}
                      value={values[field.key] ?? ""}
                      placeholder={saved ? m.provider.savedPlaceholder : ""}
                      aria-invalid={errors[field.key] ? true : undefined}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={!canWrite}
                      onChange={(event) =>
                        setValues({ ...values, [field.key]: event.target.value })
                      }
                    />
                  ) : (
                    <Input
                      id={fieldId}
                      type="password"
                      value={values[field.key] ?? ""}
                      placeholder={saved ? m.provider.savedPlaceholder : ""}
                      aria-invalid={errors[field.key] ? true : undefined}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={!canWrite}
                      onChange={(event) =>
                        setValues({ ...values, [field.key]: event.target.value })
                      }
                    />
                  )}
                  <span className="flex items-center gap-2 text-label text-ink-secondary">
                    {saved && <Badge variant="success">{m.provider.saved}</Badge>}
                    {field.hint}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <p className="text-body text-ink-secondary">{m.provider.demoNote}</p>
          <div className="flex max-w-xs flex-col gap-1.5">
            <Label htmlFor={`${base}-demo-refund`}>{m.provider.demoRefund}</Label>
            <Select
              id={`${base}-demo-refund`}
              value={demoRefund}
              disabled={!canWrite}
              onChange={(event) => setDemoRefund(event.target.value)}
            >
              <option value="confirmed">confirmat</option>
              <option value="pending">în așteptare</option>
              <option value="failed">refuzat</option>
              <option value="manual_required">manual necesar</option>
            </Select>
          </div>
        </>
      )}

      <div className="flex flex-col gap-1">
        <label className="flex min-h-11 items-center gap-2 text-body md:min-h-0">
          <input
            type="checkbox"
            className="size-4 accent-brand"
            checked={active}
            disabled={!canWrite}
            onChange={(event) => setActive(event.target.checked)}
          />
          {m.provider.activeLabel}
        </label>
        <span className="text-label text-ink-secondary">{m.provider.activeHelp}</span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!canWrite || pending}>
          {pending ? m.provider.saving : m.provider.save}
        </Button>
        <Button type="button" variant="outline" onClick={check} disabled={!canWrite || testing}>
          {testing ? m.provider.testing : m.provider.testConnection}
        </Button>
        {provider.real &&
          (isLive ? (
            <Button
              type="button"
              variant="outline"
              disabled={!canWrite || pending}
              onClick={() => run({ mode: "test" })}
            >
              {m.provider.backToTest}
            </Button>
          ) : (
            <Button
              type="button"
              variant="destructive"
              disabled={!canWrite || pending}
              onClick={() => setLiveOpen(true)}
            >
              {m.provider.goLive}
            </Button>
          ))}
        <span role="status" aria-live="polite" className="text-body text-ink-secondary">
          {status}
        </span>
      </div>

      {test && (
        <p
          role="status"
          className={
            "rounded-lg p-3 text-body " +
            (test.ok
              ? "bg-tone-success-bg text-tone-success-fg"
              : "bg-tone-problem-bg text-tone-problem-fg")
          }
        >
          {test.message}
        </p>
      )}
      {problem && (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {problem}
        </p>
      )}

      <Dialog
        open={liveOpen}
        onClose={() => setLiveOpen(false)}
        title={m.provider.liveTitle}
        description={m.provider.liveBody}
        closeLabel={m.provider.cancel}
        className="max-w-lg"
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setLiveOpen(false)}>
            {m.provider.cancel}
          </Button>
          <Button
            type="button"
            onClick={() => run({ mode: "live", confirmLive: true }, () => setLiveOpen(false))}
            disabled={pending}
          >
            {m.provider.liveConfirm}
          </Button>
        </div>
      </Dialog>
    </form>
  );
}
