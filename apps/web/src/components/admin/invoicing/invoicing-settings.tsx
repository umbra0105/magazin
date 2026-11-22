"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Badge, Button, Dialog, Input, Label, Select } from "@ecom/ui";
import {
  confirmInvoicingVerified,
  saveInvoicingChoice,
  saveInvoicingConfig,
  testInvoicingConnection,
} from "@/app/(admin)/admin/setari/facturare/actions";
import { getMessages } from "@/messages";

const m = getMessages().admin.invoicing.settings;

export interface InvoicingFieldDto {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  hint: string | null;
}

export interface InvoicingCardDto {
  code: "smartbill" | "demo";
  label: string;
  real: boolean;
  fields: InvoicingFieldDto[];
  saved: Record<string, boolean>;
  /** Valorile câmpurilor ne-secrete (seria, CIF-ul, numele cotei): se afișează în formular. */
  values: Record<string, string>;
  configured: boolean;
  isActive: boolean;
  mode: "test" | "live";
  /** Text deja formatat (data din fusul magazinului) sau `null`. */
  verifiedAtText: string | null;
  notes: string[];
}

/** Alegerea curierului folosit de magazin (`shipping.carrier`). */
export function InvoicingChoice({
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
      const result = await saveInvoicingChoice({ provider: value });
      if (result.ok) {
        setStatus(m.selectedSaved);
        router.refresh();
      } else {
        setProblem(m.errors[result.code] ?? m.saveFailed);
      }
    });
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-body text-ink-secondary">{m.selectedHelp}</p>
      <div className="flex max-w-md flex-col gap-1.5">
        <Label htmlFor={`${id}-provider`}>{m.selectedLabel}</Label>
        <Select
          id={`${id}-provider`}
          value={value}
          disabled={!canWrite || pending}
          onChange={(event) => {
            setStatus(null);
            setValue(event.target.value);
          }}
        >
          <option value="">{m.selectedNone}</option>
          {options.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      {unusable && (
        <p role="note" className="rounded-lg bg-tone-warning-bg p-3 text-body text-tone-warning-fg">
          {m.selectedUnavailable}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" disabled={!canWrite || pending}>
          {m.selectedSave}
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

/** Configurarea unui curier: câmpuri de credențiale (niciodată pre-completate), mod, activare, test, confirmarea testului real, LIVE. */
export function InvoicingCard({
  carrier,
  canWrite,
}: {
  carrier: InvoicingCardDto;
  canWrite: boolean;
}) {
  const router = useRouter();
  const base = useId();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      carrier.fields
        .filter((field) => !field.secret)
        .map((field) => [field.key, carrier.values[field.key] ?? ""]),
    ),
  );
  const [active, setActive] = useState(carrier.isActive);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [liveOpen, setLiveOpen] = useState(false);
  const [pending, start] = useTransition();
  const [testing, startTest] = useTransition();
  const [confirming, startConfirm] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});

  const payload = (extra: Record<string, unknown> = {}) => ({
    provider: carrier.code,
    // se trimit doar valorile completate și, la câmpurile ne-secrete, doar cele schimbate față de ce e salvat
    credentials: Object.fromEntries(
      Object.entries(values).filter(
        ([key, value]) =>
          value.trim() !== "" &&
          (carrier.fields.find((field) => field.key === key)?.secret === true ||
            value.trim() !== (carrier.values[key] ?? "")),
      ),
    ),
    isActive: active,
    ...extra,
  });

  const run = (extra: Record<string, unknown> = {}, onDone?: () => void) => {
    setStatus(null);
    setProblem(null);
    setErrors({});
    start(async () => {
      const result = await saveInvoicingConfig(payload(extra));
      if (result.ok) {
        setValues((previous) =>
          Object.fromEntries(
            Object.entries(previous).map(([key, value]) => [
              key,
              carrier.fields.find((field) => field.key === key)?.secret ? "" : value,
            ]),
          ),
        );
        setStatus(result.revertedToTest ? m.revertedToTest : m.savedOk);
        onDone?.();
        router.refresh();
      } else {
        setProblem(m.errors[result.code] ?? m.saveFailed);
        onDone?.();
      }
    });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite || pending) return;
    if (carrier.real && active) {
      const missing = carrier.fields.find(
        (field) => field.required && !carrier.saved[field.key] && !(values[field.key] ?? "").trim(),
      );
      if (missing) {
        setProblem(m.errors["INVOICING_NOT_CONFIGURED"] ?? m.fixErrors);
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
      setTest(await testInvoicingConnection({ provider: carrier.code }));
    });
  };

  const confirmVerified = () => {
    setTest(null);
    startConfirm(async () => {
      const result = await confirmInvoicingVerified({ provider: carrier.code });
      setTest(result);
      if (result.ok) router.refresh();
    });
  };

  const isLive = carrier.mode === "live";

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-labelledby={`${base}-title`}
      data-invoicing-provider={carrier.code}
      className="flex flex-col gap-4 rounded-lg bg-surface-subtle p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${base}-title`} className="text-heading">
          {carrier.label}
        </h3>
        <Badge variant={carrier.configured ? "success" : "neutral"} dot>
          {carrier.configured ? m.configured : m.notConfigured}
        </Badge>
        <Badge variant={carrier.isActive ? "info" : "neutral"}>
          {carrier.isActive ? m.active : m.inactive}
        </Badge>
        {carrier.real && (
          <Badge variant={isLive ? "warning" : "neutral"}>{isLive ? m.modeLive : m.modeTest}</Badge>
        )}
        {carrier.real && !carrier.verifiedAtText && (
          <Badge variant="warning">{m.unconfirmed}</Badge>
        )}
      </div>

      {carrier.real ? (
        <>
          <p className="text-body text-ink-secondary">
            {carrier.verifiedAtText ? m.verifiedAt(carrier.verifiedAtText) : m.notVerified}
          </p>
          <p
            role="note"
            className="rounded-lg bg-tone-warning-bg p-3 text-body text-tone-warning-fg"
          >
            {m.testWarning}
          </p>
          {carrier.notes.length > 0 && (
            <div className="flex flex-col gap-1 text-body text-ink-secondary">
              <p className="text-label font-medium">{m.notes}</p>
              <ul className="list-disc pl-5">
                {carrier.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            {carrier.fields.map((field) => {
              const fieldId = `${base}-${field.key}`;
              const saved = carrier.saved[field.key] === true;
              return (
                <div key={field.key} className="flex flex-col gap-1.5">
                  <Label htmlFor={fieldId}>
                    {field.label}
                    {field.required ? ` (${m.required})` : ""}
                  </Label>
                  <Input
                    id={fieldId}
                    type={field.secret ? "password" : "text"}
                    value={values[field.key] ?? ""}
                    placeholder={saved ? m.savedPlaceholder : ""}
                    aria-invalid={errors[field.key] ? true : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={!canWrite}
                    onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                  />
                  <span className="flex items-center gap-2 text-label text-ink-secondary">
                    {saved && <Badge variant="success">{m.saved}</Badge>}
                    {field.hint}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <p className="text-body text-ink-secondary">{m.demoNote}</p>
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
          {m.activeLabel}
        </label>
        <span className="text-label text-ink-secondary">{m.activeHelp}</span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!canWrite || pending}>
          {pending ? m.saving : m.save}
        </Button>
        <Button type="button" variant="outline" onClick={check} disabled={!canWrite || testing}>
          {testing ? m.testing : m.testConnection}
        </Button>
        {carrier.real && !isLive && !carrier.verifiedAtText && (
          <Button
            type="button"
            variant="outline"
            onClick={confirmVerified}
            disabled={!canWrite || confirming}
          >
            {m.confirmVerified}
          </Button>
        )}
        {carrier.real &&
          (isLive ? (
            <Button
              type="button"
              variant="outline"
              disabled={!canWrite || pending}
              onClick={() => run({ mode: "test" })}
            >
              {m.backToTest}
            </Button>
          ) : (
            <Button
              type="button"
              variant="destructive"
              disabled={!canWrite || pending}
              onClick={() => setLiveOpen(true)}
            >
              {m.goLive}
            </Button>
          ))}
        <span role="status" aria-live="polite" className="text-body text-ink-secondary">
          {status}
        </span>
      </div>
      {carrier.real && !isLive && !carrier.verifiedAtText && (
        <p className="text-label text-ink-secondary">{m.confirmVerifiedHelp}</p>
      )}

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
        title={m.liveTitle}
        description={m.liveBody}
        closeLabel={m.cancel}
        className="max-w-lg"
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setLiveOpen(false)}>
            {m.cancel}
          </Button>
          <Button
            type="button"
            onClick={() => run({ mode: "live", confirmLive: true }, () => setLiveOpen(false))}
            disabled={pending}
          >
            {m.liveConfirm}
          </Button>
        </div>
      </Dialog>
    </form>
  );
}
