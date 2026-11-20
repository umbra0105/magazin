"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Button, Dialog, Label, Select, Textarea } from "@ecom/ui";
import {
  addNoteAction,
  resendOrderEmailAction,
  setInstallationStatusAction,
} from "@/app/(admin)/admin/comenzi/actions";
import { getMessages } from "@/messages";

const t = getMessages().admin.orders;

/** Adaugă o notă internă: textul nu ajunge în cronologie sau în audit, doar în lista de note. */
export function NoteForm({ orderId }: { orderId: string }) {
  const router = useRouter();
  const id = useId();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setStatus(null);
    const trimmed = body.trim();
    if (trimmed === "" || trimmed.length > 2000) {
      setError(t.detail.notes.required);
      document.getElementById(`${id}-body`)?.focus();
      return;
    }
    setError(null);
    start(async () => {
      const result = await addNoteAction({ orderId, body: trimmed });
      if (result.ok) {
        setBody("");
        setStatus(t.detail.notes.added);
        router.refresh();
      } else setError(t.detail.notes.failed);
    });
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-2">
      <Label htmlFor={`${id}-body`}>{t.detail.notes.label}</Label>
      <Textarea
        id={`${id}-body`}
        rows={3}
        maxLength={2000}
        value={body}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help`}
        onChange={(event) => setBody(event.target.value)}
      />
      <span
        id={`${id}-help`}
        className={error ? "text-label text-tone-problem-fg" : "text-label text-ink-secondary"}
      >
        {error ?? t.detail.notes.help}
      </span>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" disabled={pending}>
          {t.detail.notes.submit}
        </Button>
        <span role="status" aria-live="polite" className="text-body text-ink-secondary">
          {status}
        </span>
      </div>
    </form>
  );
}

/** «Retrimite» pentru un email al comenzii: acțiune separată, cu confirmare, înregistrată în cronologie și în audit. */
export function ResendEmailButton({
  orderId,
  dispatchId,
  label,
}: {
  orderId: string;
  dispatchId: string;
  label: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const confirm = () =>
    start(async () => {
      const result = await resendOrderEmailAction({ orderId, dispatchId });
      setOpen(false);
      setMessage(result.ok ? t.detail.emails.resendDone : t.detail.emails.resendFailed);
      if (result.ok) router.refresh();
    });

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`${t.detail.emails.resend}: ${label}`}
      >
        {t.detail.emails.resend}
      </Button>
      {message && (
        <span role="status" aria-live="polite" className="text-label text-ink-secondary">
          {message}
        </span>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t.detail.emails.resendTitle}
        description={t.detail.emails.resendBody}
        closeLabel={t.actions.close}
        className="max-w-lg"
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            {t.actions.cancelButton}
          </Button>
          <Button type="button" onClick={confirm} disabled={pending}>
            {t.detail.emails.resend}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

/** Starea cererii de instalare: doar urmărire, nu atinge totalul, stocul sau starea comenzii. */
export function InstallationStatusForm({
  orderId,
  current,
  statuses,
}: {
  orderId: string;
  current: string;
  statuses: readonly { value: string; label: string }[];
}) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(current);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending || value === current) return;
    setMessage(null);
    setError(null);
    start(async () => {
      const result = await setInstallationStatusAction({ orderId, status: value });
      if (result.ok) {
        setMessage(t.detail.installation.done);
        router.refresh();
      } else setError(t.detail.installation.failed);
    });
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-status`}>{t.detail.installation.change}</Label>
        <Select
          id={`${id}-status`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="min-w-48"
        >
          {statuses.map((status) => (
            <option key={status.value} value={status.value}>
              {status.label}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" variant="outline" disabled={pending || value === current}>
        {t.detail.installation.submit}
      </Button>
      <span role="status" aria-live="polite" className="text-body text-ink-secondary">
        {message}
      </span>
      {error && (
        <span role="alert" className="text-label text-tone-problem-fg">
          {error}
        </span>
      )}
    </form>
  );
}
