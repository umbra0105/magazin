"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Badge, Button, Input, Select, Textarea } from "@ecom/ui";
import {
  confirmDeliveryAction,
  saveDeliveryKeysAction,
  saveDeliverySettingsAction,
  setDeliveryActiveAction,
  testDeliveryAction,
} from "@/app/(admin)/admin/setari/livrare-digitala/actions";
import { getMessages } from "@/messages";
import { Field } from "../products/editor-ui";

const m = getMessages().digitalAdmin;
const t = m.delivery;

const errorText = (code: unknown): string =>
  (typeof code === "string" && m.errors[code]) || (m.errors["failed"] ?? "");

export interface DeliverySettingsValues {
  videoProvider: "local" | "bunny";
  fileProvider: "local" | "s3";
  linkSeconds: number;
  maxUploadMb: number;
  maxIpsPerEntitlement: number;
  ipWindowHours: number;
  accessLogRetentionDays: number;
  consentText: string;
}

/** Setările livrării conținutului digital (cer `settings.write`; serverul validează fiecare valoare cu schema din registru). */
export function DeliverySettingsForm({
  initial,
  canWrite,
}: {
  initial: DeliverySettingsValues;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [values, setValues] = useState({
    ...initial,
    linkSeconds: String(initial.linkSeconds),
    maxUploadMb: String(initial.maxUploadMb),
    maxIpsPerEntitlement: String(initial.maxIpsPerEntitlement),
    ipWindowHours: String(initial.ipWindowHours),
    accessLogRetentionDays: String(initial.accessLogRetentionDays),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setStatus(null);
    const numbers = {
      linkSeconds: Number(values.linkSeconds),
      maxUploadMb: Number(values.maxUploadMb),
      maxIpsPerEntitlement: Number(values.maxIpsPerEntitlement),
      ipWindowHours: Number(values.ipWindowHours),
      accessLogRetentionDays: Number(values.accessLogRetentionDays),
    };
    const found: Record<string, string> = {};
    for (const [key, value] of Object.entries(numbers)) {
      if (!Number.isInteger(value)) found[key] = errorText("DIGITAL_INPUT_INVALID");
    }
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    const result = await saveDeliverySettingsAction({
      videoProvider: values.videoProvider,
      fileProvider: values.fileProvider,
      consentText: values.consentText,
      ...numbers,
    });
    if (result.ok) {
      setErrors({});
      setStatus(t.saved);
      startTransition(() => router.refresh());
    } else {
      setErrors(
        Object.fromEntries(
          Object.entries(result.errors).map(([key]) => [key, errorText("DIGITAL_INPUT_INVALID")]),
        ),
      );
    }
  }

  const numeric = (key: keyof typeof values, id: string, label: string, help?: string) => (
    <Field id={id} label={label} help={help} error={errors[key]}>
      {(control) => (
        <Input
          {...control}
          inputMode="numeric"
          value={String(values[key])}
          disabled={!canWrite}
          onChange={(event) => set(key, event.target.value as never)}
        />
      )}
    </Field>
  );

  return (
    <form noValidate onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="dd-video" label={t.videoProvider}>
          {(control) => (
            <Select
              {...control}
              value={values.videoProvider}
              disabled={!canWrite}
              onChange={(event) => set("videoProvider", event.target.value as "local" | "bunny")}
            >
              <option value="local">{t.providerLocal}</option>
              <option value="bunny">{t.providerBunny}</option>
            </Select>
          )}
        </Field>
        <Field id="dd-file" label={t.fileProvider}>
          {(control) => (
            <Select
              {...control}
              value={values.fileProvider}
              disabled={!canWrite}
              onChange={(event) => set("fileProvider", event.target.value as "local" | "s3")}
            >
              <option value="local">{t.providerLocal}</option>
              <option value="s3">{t.providerS3}</option>
            </Select>
          )}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {numeric("linkSeconds", "dd-link", t.linkSeconds)}
        {numeric("maxUploadMb", "dd-upload", t.maxUploadMb)}
        {numeric("maxIpsPerEntitlement", "dd-ips", t.maxIps)}
        {numeric("ipWindowHours", "dd-window", t.ipWindow)}
      </div>
      {numeric("accessLogRetentionDays", "dd-retention", t.retention, t.retentionHelp)}
      <Field
        id="dd-consent"
        label={t.consentText}
        help={t.consentHelp}
        error={errors["consentText"]}
      >
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            value={values.consentText}
            disabled={!canWrite}
            onChange={(event) => set("consentText", event.target.value)}
          />
        )}
      </Field>
      <div aria-live="polite" className="min-h-6 text-tone-success-fg">
        {status}
      </div>
      {canWrite ? (
        <div>
          <Button type="submit">{t.save}</Button>
        </div>
      ) : null}
    </form>
  );
}

export interface DeliveryCardDto {
  code: string;
  label: string;
  fields: Array<{
    key: string;
    label: string;
    secret: boolean;
    required: boolean;
    hint: string | null;
  }>;
  saved: Record<string, boolean>;
  values: Record<string, string>;
  configured: boolean;
  isActive: boolean;
  verifiedAtText: string | null;
  notes: string[];
}

/** Un furnizor cu cont (Bunny Stream, S3): chei (doar Owner), test de conexiune, «am testat cu un cont real», activare. */
export function DeliveryCard({ card }: { card: DeliveryCardDto }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const refresh = () => startTransition(() => router.refresh());

  const ok = (message: string) => {
    setProblem(null);
    setStatus(message);
    refresh();
  };
  const fail = (code: unknown) => {
    setStatus(null);
    setProblem(errorText(code));
  };

  async function onSaveKeys(event: FormEvent) {
    event.preventDefault();
    const credentials = Object.fromEntries(
      Object.entries(inputs).filter(([, value]) => value.trim() !== ""),
    );
    const result = await saveDeliveryKeysAction({ provider: card.code, credentials });
    if (result.ok) {
      setInputs({});
      ok(result.cleared ? t.cleared : t.done);
    } else fail(result.code);
  }

  async function onTest() {
    const result = await testDeliveryAction({ provider: card.code });
    if (result.ok) {
      setProblem(result.okConnection ? null : result.message);
      setStatus(result.okConnection ? result.message : null);
    } else fail(result.code);
  }

  async function onConfirm() {
    const result = await confirmDeliveryAction({ provider: card.code, confirmed: true });
    if (result.ok) {
      setConfirmed(false);
      ok(t.done);
    } else fail(result.code);
  }

  async function onActive(active: boolean) {
    const result = await setDeliveryActiveAction({ provider: card.code, active });
    if (result.ok) ok(t.done);
    else fail(result.code);
  }

  return (
    <section
      aria-labelledby={`dd-card-${card.code}`}
      className="flex max-w-2xl flex-col gap-4 rounded-lg bg-surface-subtle p-4"
      data-delivery-card={card.code}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`dd-card-${card.code}`} className="text-heading font-semibold">
          {card.label}
        </h3>
        <Badge variant={card.isActive ? "success" : "neutral"}>
          {card.isActive ? t.active : t.inactive}
        </Badge>
        <Badge variant={card.configured ? "info" : "warning"}>
          {card.configured ? t.configured : t.missing}
        </Badge>
        <Badge variant={card.verifiedAtText ? "success" : "warning"}>
          {card.verifiedAtText ? t.verifiedAt(card.verifiedAtText) : t.notVerified}
        </Badge>
      </div>
      <ul className="list-disc pl-5 text-label text-ink-secondary">
        {card.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <form noValidate onSubmit={onSaveKeys} className="flex flex-col gap-3">
        {card.fields.map((field) => (
          <Field
            key={field.key}
            id={`dd-${card.code}-${field.key}`}
            label={`${field.label}${field.required ? " *" : ""}`}
            help={
              card.saved[field.key] ? `${t.savedField}. ${t.keysKept}` : (field.hint ?? undefined)
            }
          >
            {(control) => (
              <Input
                {...control}
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                placeholder={field.secret ? "" : (card.values[field.key] ?? "")}
                value={inputs[field.key] ?? ""}
                onChange={(event) =>
                  setInputs((current) => ({ ...current, [field.key]: event.target.value }))
                }
              />
            )}
          </Field>
        ))}
        <div>
          <Button type="submit" variant="outline">
            {t.saveKeys}
          </Button>
        </div>
      </form>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => void onTest()}>
          {t.test}
        </Button>
        {card.isActive ? (
          <Button type="button" variant="outline" onClick={() => void onActive(false)}>
            {t.deactivate}
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => void onActive(true)}
            disabled={!card.configured || !card.verifiedAtText}
          >
            {t.activate}
          </Button>
        )}
      </div>
      {card.configured && !card.verifiedAtText ? (
        <div className="flex flex-col gap-2">
          <label className="flex items-start gap-2 text-label">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5 size-4 accent-brand"
            />
            <span>
              {t.confirm}
              <span className="block text-ink-secondary">{t.confirmHelp}</span>
            </span>
          </label>
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={!confirmed}
              onClick={() => void onConfirm()}
            >
              {t.confirm}
            </Button>
          </div>
        </div>
      ) : null}
      <div aria-live="polite" className="min-h-6">
        {status ? <p className="text-tone-success-fg">{status}</p> : null}
        {problem ? (
          <p role="alert" className="text-tone-problem-fg">
            {problem}
          </p>
        ) : null}
      </div>
    </section>
  );
}
