"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Button, Input, Label, Textarea } from "@ecom/ui";
import {
  saveSmtpAction,
  sendSmtpTestEmailAction,
  testSmtpConnectionAction,
} from "@/app/(admin)/admin/setari/email/actions";
import { getMessages } from "@/messages";

const t = getMessages().admin.email.smtp;

export interface SmtpFormProps {
  canWrite: boolean;
  initial: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    isActive: boolean;
    passwordSaved: boolean;
    fromName: string;
    fromAddress: string;
    replyTo: string;
    internalRecipients: string;
    exists: boolean;
  };
}

/**
 * Formularul serverului SMTP: parola nu se afișează niciodată (doar «Salvat»), se trimite doar când o scrii; testul conexiunii și
 * emailul de test rulează pe serverul aplicației și întorc doar reușit sau eșuat. Validarea e a noastră (`noValidate`), în română.
 */
export function SmtpForm({ canWrite, initial }: SmtpFormProps) {
  const router = useRouter();
  const id = useId();
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState(String(initial.port));
  const [secure, setSecure] = useState(initial.secure);
  const [user, setUser] = useState(initial.user);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [isActive, setIsActive] = useState(initial.isActive);
  const [fromName, setFromName] = useState(initial.fromName);
  const [fromAddress, setFromAddress] = useState(initial.fromAddress);
  const [replyTo, setReplyTo] = useState(initial.replyTo);
  const [recipients, setRecipients] = useState(initial.internalRecipients);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");
  const [testStatus, setTestStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const focus = (name: string) => document.getElementById(`${id}-${name}`)?.focus();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || pending) return;
    setStatus(null);
    setProblem(null);
    const found: Record<string, string> = {};
    const portNumber = Number(port);
    if (host.trim() === "") found["host"] = t.invalidHost;
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535)
      found["port"] = t.invalidPort;
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (fromAddress.trim() !== "" && !email.test(fromAddress.trim()))
      found["fromAddress"] = t.invalidFrom;
    if (isActive && fromAddress.trim() === "") found["fromAddress"] = t.invalidFrom;
    if (replyTo.trim() !== "" && !email.test(replyTo.trim())) found["replyTo"] = t.invalidReplyTo;
    const list = recipients
      .split(/[\n,;]+/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (list.length > 20 || !list.every((address) => email.test(address)))
      found["internalRecipients"] = t.invalidRecipients;
    setErrors(found);
    const firstKey = ["host", "port", "fromAddress", "replyTo", "internalRecipients"].find(
      (key) => found[key],
    );
    if (firstKey) return focus(firstKey);
    start(async () => {
      const result = await saveSmtpAction({
        host,
        port: portNumber,
        secure,
        user,
        password,
        clearPassword,
        isActive,
        fromName,
        fromAddress,
        replyTo,
        internalRecipients: recipients,
      });
      if (result.ok) {
        setPassword("");
        setClearPassword(false);
        setStatus(t.saved);
        router.refresh();
        return;
      }
      const next: Record<string, string> = {};
      if (result.errors.host) next["host"] = t.invalidHost;
      if (result.errors.port) next["port"] = t.invalidPort;
      if (result.errors.fromAddress) next["fromAddress"] = t.invalidFrom;
      if (result.errors.replyTo) next["replyTo"] = t.invalidReplyTo;
      if (result.errors.internalRecipients) next["internalRecipients"] = t.invalidRecipients;
      setErrors(next);
      if (Object.keys(next).length === 0) setProblem(t.failed);
    });
  };

  const field = (
    name: string,
    label: string,
    value: string,
    set: (v: string) => void,
    extra?: {
      inputMode?: "numeric";
      help?: string;
      type?: "text" | "password";
      autoComplete?: string;
    },
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-${name}`}>{label}</Label>
      <Input
        id={`${id}-${name}`}
        type={extra?.type ?? "text"}
        inputMode={extra?.inputMode}
        autoComplete={extra?.autoComplete ?? "off"}
        value={value}
        disabled={!canWrite}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={
          errors[name] ? `${id}-${name}-error` : extra?.help ? `${id}-${name}-help` : undefined
        }
        onChange={(event) => set(event.target.value)}
      />
      {extra?.help && !errors[name] && (
        <span id={`${id}-${name}-help`} className="text-label text-ink-secondary">
          {extra.help}
        </span>
      )}
      {errors[name] && (
        <p id={`${id}-${name}-error`} className="text-label text-tone-problem-fg">
          {errors[name]}
        </p>
      )}
    </div>
  );

  const testConnection = () =>
    start(async () => {
      setTestStatus(null);
      const result = await testSmtpConnectionAction({});
      setTestStatus(
        result.ok
          ? { ok: true, text: t.testConnectionOk }
          : {
              ok: false,
              text: result.code === "notConfigured" ? t.testNeedsSave : t.testConnectionFailed,
            },
      );
    });

  const testEmail = () =>
    start(async () => {
      setTestStatus(null);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testTo.trim())) {
        setTestStatus({ ok: false, text: t.invalidTo });
        return focus("test-to");
      }
      const result = await sendSmtpTestEmailAction({ to: testTo });
      setTestStatus(
        result.ok
          ? { ok: true, text: t.testEmailOk(result.to) }
          : {
              ok: false,
              text:
                result.code === "email"
                  ? t.invalidTo
                  : result.code === "notConfigured"
                    ? t.testNeedsSave
                    : t.testEmailFailed,
            },
      );
    });

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <form noValidate onSubmit={submit} className="flex flex-col gap-6" data-smtp-form>
        <fieldset className="flex flex-col gap-4" disabled={!canWrite}>
          <legend className="text-section">{t.title}</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">{field("host", t.host, host, setHost)}</div>
            {field("port", t.port, port, setPort, { inputMode: "numeric" })}
          </div>
          <label className="flex items-start gap-2 text-body">
            <input
              type="checkbox"
              className="mt-1 size-4 accent-brand"
              checked={secure}
              onChange={(event) => setSecure(event.target.checked)}
            />
            <span>
              {t.secure}
              <span className="block text-label text-ink-secondary">{t.secureHelp}</span>
            </span>
          </label>
          {field("user", t.user, user, setUser)}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-password`}>{t.password}</Label>
            <Input
              id={`${id}-password`}
              type="password"
              autoComplete="new-password"
              value={password}
              disabled={!canWrite}
              placeholder={initial.passwordSaved ? "••••••••" : ""}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby={`${id}-password-help`}
            />
            <span id={`${id}-password-help`} className="text-label text-ink-secondary">
              {initial.passwordSaved ? (
                <strong data-password-saved>{t.passwordSaved}. </strong>
              ) : null}
              {t.passwordHelp}
            </span>
            {initial.passwordSaved && (
              <label className="flex items-center gap-2 text-label">
                <input
                  type="checkbox"
                  className="size-4 accent-brand"
                  checked={clearPassword}
                  onChange={(event) => setClearPassword(event.target.checked)}
                />
                {t.clearPassword}
              </label>
            )}
          </div>
          <label className="flex items-center gap-2 text-body">
            <input
              type="checkbox"
              className="size-4 accent-brand"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
            />
            {t.active}
          </label>
        </fieldset>

        <fieldset className="flex flex-col gap-4" disabled={!canWrite}>
          <legend className="text-section">{t.sender}</legend>
          {field("fromName", t.fromName, fromName, setFromName)}
          {field("fromAddress", t.fromAddress, fromAddress, setFromAddress)}
          {field("replyTo", t.replyTo, replyTo, setReplyTo)}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-internalRecipients`}>{t.internalRecipients}</Label>
            <Textarea
              id={`${id}-internalRecipients`}
              rows={3}
              value={recipients}
              disabled={!canWrite}
              aria-invalid={errors["internalRecipients"] ? true : undefined}
              onChange={(event) => setRecipients(event.target.value)}
            />
            <span
              className={
                errors["internalRecipients"]
                  ? "text-label text-tone-problem-fg"
                  : "text-label text-ink-secondary"
              }
            >
              {errors["internalRecipients"] ?? t.internalHelp}
            </span>
          </div>
        </fieldset>

        {canWrite && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending}>
              {t.save}
            </Button>
            <span role="status" aria-live="polite" className="text-body text-ink-secondary">
              {status}
            </span>
          </div>
        )}
        {problem && (
          <p
            role="alert"
            className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
          >
            {problem}
          </p>
        )}
      </form>

      {canWrite && (
        <section
          aria-labelledby={`${id}-test-title`}
          className="flex flex-col gap-3 border-t border-line-subtle pt-6"
        >
          <h2 id={`${id}-test-title`} className="text-section">
            {t.testConnection}
          </h2>
          <div className="flex flex-wrap items-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={testConnection}
              disabled={pending || !initial.exists}
            >
              {t.testConnection}
            </Button>
            <div className="flex min-w-60 flex-1 flex-col gap-1.5">
              <Label htmlFor={`${id}-test-to`}>{t.testEmailTo}</Label>
              <Input
                id={`${id}-test-to`}
                autoComplete="off"
                value={testTo}
                onChange={(event) => setTestTo(event.target.value)}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={testEmail}
              disabled={pending || !initial.exists}
            >
              {t.testEmail}
            </Button>
          </div>
          <p
            role={testStatus && !testStatus.ok ? "alert" : "status"}
            aria-live="polite"
            className={
              testStatus && !testStatus.ok
                ? "text-body text-tone-problem-fg"
                : "text-body text-ink-secondary"
            }
            data-smtp-test-result
          >
            {testStatus?.text}
          </p>
        </section>
      )}
    </div>
  );
}
