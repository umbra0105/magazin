"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Button, Dialog, Input, Label, Textarea } from "@ecom/ui";
import {
  resendLogAction,
  resetOverrideAction,
  saveOverrideAction,
  sendTestAction,
} from "@/app/(admin)/admin/comenzi/sabloane-email/actions";
import { getMessages } from "@/messages";

const t = getMessages().admin.email;

/** Suprascrierea subiectului și a textului de început: validarea o repetă serverul, cu aceleași reguli. */
export function OverrideForm({
  template,
  canWrite,
  defaults,
  initial,
}: {
  template: string;
  canWrite: boolean;
  defaults: { subject: string; intro: string };
  initial: { subject: string; intro: string } | null;
}) {
  const router = useRouter();
  const id = useId();
  const [subject, setSubject] = useState(initial?.subject ?? defaults.subject);
  const [intro, setIntro] = useState(initial?.intro ?? defaults.intro);
  const [errors, setErrors] = useState<{ subject?: string; intro?: string }>({});
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [pending, start] = useTransition();

  const problemText = (code: string, names?: string[]): string => {
    const e = t.detail.errors;
    return code === "unknown_variable"
      ? e.unknown_variable(names ?? [])
      : (((e as Record<string, unknown>)[code] as string | undefined) ?? t.detail.failed);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || pending) return;
    setStatus(null);
    setProblem(null);
    const found: { subject?: string; intro?: string } = {};
    if (subject.trim() === "") found.subject = t.detail.errors.subject_empty;
    else if (subject.trim().length > 200) found.subject = t.detail.errors.subject_too_long;
    else if (/[\r\n]/.test(subject)) found.subject = t.detail.errors.subject_multiline;
    if (intro.trim() === "") found.intro = t.detail.errors.intro_empty;
    else if (intro.trim().length > 2000) found.intro = t.detail.errors.intro_too_long;
    setErrors(found);
    if (found.subject) return document.getElementById(`${id}-subject`)?.focus();
    if (found.intro) return document.getElementById(`${id}-intro`)?.focus();
    start(async () => {
      const result = await saveOverrideAction({ template, subject, intro });
      if (result.ok) {
        setStatus(t.detail.saved);
        router.refresh();
        return;
      }
      if (result.code === "invalid" && result.problems) {
        const next: { subject?: string; intro?: string } = {};
        for (const p of result.problems) {
          const text = problemText(p.code, p.names);
          if (p.code.startsWith("subject")) next.subject = text;
          else next.intro = text;
        }
        setErrors(next);
        const first = next.subject ? "subject" : "intro";
        document.getElementById(`${id}-${first}`)?.focus();
        return;
      }
      setProblem(t.detail.failed);
    });
  };

  const reset = () =>
    start(async () => {
      const result = await resetOverrideAction({ template });
      setResetOpen(false);
      if (result.ok) {
        setSubject(defaults.subject);
        setIntro(defaults.intro);
        setErrors({});
        setStatus(t.detail.resetDone);
        router.refresh();
      } else setProblem(t.detail.failed);
    });

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4" data-override-form>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-subject`}>{t.detail.subject}</Label>
        <Input
          id={`${id}-subject`}
          autoComplete="off"
          value={subject}
          disabled={!canWrite}
          aria-invalid={errors.subject ? true : undefined}
          aria-describedby={errors.subject ? `${id}-subject-error` : undefined}
          onChange={(event) => setSubject(event.target.value)}
        />
        {errors.subject && (
          <p id={`${id}-subject-error`} className="text-label text-tone-problem-fg">
            {errors.subject}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-intro`}>{t.detail.intro}</Label>
        <Textarea
          id={`${id}-intro`}
          rows={5}
          value={intro}
          disabled={!canWrite}
          aria-invalid={errors.intro ? true : undefined}
          aria-describedby={`${id}-intro-help`}
          onChange={(event) => setIntro(event.target.value)}
        />
        <span
          id={`${id}-intro-help`}
          className={
            errors.intro ? "text-label text-tone-problem-fg" : "text-label text-ink-secondary"
          }
        >
          {errors.intro ?? t.detail.introHelp}
        </span>
      </div>
      {canWrite && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            {t.detail.save}
          </Button>
          {initial && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setResetOpen(true)}
              disabled={pending}
            >
              {t.detail.reset}
            </Button>
          )}
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
      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title={t.detail.resetTitle}
        description={t.detail.resetBody}
        closeLabel="Închide"
        className="max-w-md"
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setResetOpen(false)}>
            Renunță
          </Button>
          <Button type="button" onClick={reset} disabled={pending}>
            {t.detail.reset}
          </Button>
        </div>
      </Dialog>
    </form>
  );
}

/** Trimiterea unui email de test (date de probă, «[TEST]» în subiect) către o adresă aleasă. */
export function TestSendForm({ template }: { template: string }) {
  const id = useId();
  const [to, setTo] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) {
      setResult({ ok: false, text: t.detail.testInvalidEmail });
      return document.getElementById(`${id}-to`)?.focus();
    }
    setResult(null);
    start(async () => {
      const response = await sendTestAction({ template, to });
      setResult(
        response.ok
          ? { ok: true, text: t.detail.testDone(response.to) }
          : {
              ok: false,
              text:
                response.code === "noSmtp"
                  ? t.detail.testNoSmtp
                  : response.code === "email"
                    ? t.detail.testInvalidEmail
                    : t.detail.testFailed,
            },
      );
    });
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-2" data-test-send>
      <Label htmlFor={`${id}-to`}>{t.detail.testRecipient}</Label>
      <div className="flex flex-wrap items-start gap-2">
        <Input
          id={`${id}-to`}
          className="max-w-sm"
          autoComplete="off"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={pending}>
          {t.detail.testSubmit}
        </Button>
      </div>
      <span className="text-label text-ink-secondary">{t.detail.testHelp}</span>
      <p
        role={result && !result.ok ? "alert" : "status"}
        aria-live="polite"
        className={
          result && !result.ok ? "text-body text-tone-problem-fg" : "text-body text-ink-secondary"
        }
      >
        {result?.text}
      </p>
    </form>
  );
}

/** «Retrimite» pentru un rând din jurnalul de trimiteri (după verificare, cu confirmare). */
export function ResendLogButton({ dispatchId, label }: { dispatchId: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const confirm = () =>
    start(async () => {
      const result = await resendLogAction({ dispatchId });
      setOpen(false);
      setMessage(result.ok ? t.log.resendDone : t.log.resendFailed);
      if (result.ok) router.refresh();
    });

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`${t.log.resend}: ${label}`}
      >
        {t.log.resend}
      </Button>
      {message && (
        <span role="status" aria-live="polite" className="text-label text-ink-secondary">
          {message}
        </span>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Retrimiți emailul?"
        description="Emailul se pune din nou în coadă, ca acțiune separată. Dacă a fost deja livrat, destinatarul îl primește a doua oară."
        closeLabel="Închide"
        className="max-w-md"
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Renunță
          </Button>
          <Button type="button" onClick={confirm} disabled={pending}>
            {t.log.resend}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
