"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Dialog, StoreButton } from "@ecom/ui";
import {
  deleteAccountAction,
  setMarketingAction,
  updateProfileAction,
} from "@/app/(storefront)/cont/actions";
import { authPost } from "@/lib/auth-client";
import { getMessages } from "@/messages";
import { FIELD, Field } from "../checkout/fields";

const m = getMessages().account.profile;

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-card bg-card p-5 sm:p-6" aria-label={title}>
      <h2 className="text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** Nume și telefon. Emailul contului nu se schimbă din această pagină. */
export function ProfilePanel({
  name,
  email,
  emailVerified,
  phone,
}: {
  name: string;
  email: string;
  emailVerified: boolean;
  phone: string;
}) {
  const base = useId();
  const router = useRouter();
  const [nameValue, setName] = useState(name);
  const [phoneValue, setPhone] = useState(phone);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (nameValue.trim().length < 2) next["name"] = m.nameInvalid;
    if (
      phoneValue.trim() !== "" &&
      !/^(\+40|0040|0)\d{9}$/.test(phoneValue.replace(/[\s.\-()]/g, ""))
    ) {
      next["phone"] = m.phoneInvalid;
    }
    setErrors(next);
    const first = ["name", "phone"].find((k) => next[k]);
    if (first) {
      document.getElementById(`${base}-${first}`)?.focus();
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const result = await updateProfileAction({ name: nameValue, phone: phoneValue });
      setMessage(
        result.ok ? m.saved : (getMessages().account.errors[result.code] ?? m.nameInvalid),
      );
      if (result.ok) router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <Panel title={m.sections.data}>
      <form noValidate onSubmit={submit} className="grid max-w-xl gap-4" data-profile-form>
        <Field id={`${base}-name`} label={m.name} error={errors["name"]}>
          {(a) => (
            <input
              {...a}
              type="text"
              autoComplete="name"
              value={nameValue}
              onChange={(e) => setName(e.target.value)}
              className={FIELD}
            />
          )}
        </Field>
        <Field id={`${base}-email`} label={m.email} help={m.emailHelp}>
          {(a) => <input {...a} type="text" value={email} readOnly className={FIELD} />}
        </Field>
        {!emailVerified ? (
          <p className="text-sm text-tone-warning-fg">{m.emailUnverified}</p>
        ) : null}
        <Field id={`${base}-phone`} label={m.phone} error={errors["phone"]}>
          {(a) => (
            <input
              {...a}
              type="text"
              inputMode="tel"
              autoComplete="tel"
              value={phoneValue}
              onChange={(e) => setPhone(e.target.value)}
              className={FIELD}
            />
          )}
        </Field>
        <div>
          <StoreButton type="submit" disabled={pending}>
            {pending ? m.saving : m.save}
          </StoreButton>
        </div>
        <p
          role="status"
          aria-live="polite"
          className="min-h-6 text-ink-secondary"
          data-profile-message
        >
          {message}
        </p>
      </form>
    </Panel>
  );
}

/** Schimbarea parolei prin serviciile de autentificare existente (închid celelalte sesiuni). */
export function PasswordPanel({ minLength }: { minLength: number }) {
  const base = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const e: Record<string, string> = {};
    if (current === "") e["current"] = m.passwordWrong;
    if (next.length < minLength) e["next"] = m.passwordTooShort(minLength);
    if (repeat !== next) e["repeat"] = m.passwordMismatch;
    setErrors(e);
    const first = ["current", "next", "repeat"].find((k) => e[k]);
    if (first) {
      document.getElementById(`${base}-${first}`)?.focus();
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const result = await authPost("/api/auth/change-password", {
        currentPassword: current,
        newPassword: next,
      });
      if (result.ok) {
        setCurrent("");
        setNext("");
        setRepeat("");
        setMessage(m.passwordChanged);
      } else {
        setMessage(
          result.status === 400 || result.status === 401 ? m.passwordWrong : m.passwordFailed,
        );
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Panel title={m.sections.password}>
      <form noValidate onSubmit={submit} className="grid max-w-xl gap-4" data-password-form>
        <Field id={`${base}-current`} label={m.currentPassword} error={errors["current"]}>
          {(a) => (
            <input
              {...a}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className={FIELD}
            />
          )}
        </Field>
        <Field id={`${base}-next`} label={m.newPassword} error={errors["next"]}>
          {(a) => (
            <input
              {...a}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className={FIELD}
            />
          )}
        </Field>
        <Field id={`${base}-repeat`} label={m.confirmPassword} error={errors["repeat"]}>
          {(a) => (
            <input
              {...a}
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              className={FIELD}
            />
          )}
        </Field>
        <div>
          <StoreButton type="submit" disabled={pending}>
            {m.changePassword}
          </StoreButton>
        </div>
        <p
          role="status"
          aria-live="polite"
          className="min-h-6 text-ink-secondary"
          data-password-message
        >
          {message}
        </p>
      </form>
    </Panel>
  );
}

/** Preferințe de comunicare: emailurile de serviciu sunt mereu active; marketingul e un consimțământ separat, implicit oprit. */
export function CommunicationPanel({ marketingOptIn }: { marketingOptIn: boolean }) {
  const [value, setValue] = useState(marketingOptIn);
  const [message, setMessage] = useState<string | null>(null);
  async function change(next: boolean) {
    setValue(next);
    const result = await setMarketingAction({ optIn: next });
    if (result.ok) setMessage(m.marketingSaved);
    else setValue(!next);
  }
  return (
    <Panel title={m.sections.communication}>
      <p className="max-w-prose text-ink-secondary">{m.serviceEmails}</p>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => void change(e.target.checked)}
          className="mt-1 size-5 accent-[var(--brand)]"
          data-marketing-toggle
        />
        <span>
          {m.marketing}
          <span className="block text-sm text-ink-secondary">{m.marketingHelp}</span>
        </span>
      </label>
      <p
        role="status"
        aria-live="polite"
        className="min-h-6 text-ink-secondary"
        data-marketing-message
      >
        {message}
      </p>
    </Panel>
  );
}

/** Exportul GDPR: fișier JSON cu datele contului, descărcat printr-un POST (limitat ca frecvență pe server). */
export function ExportPanel() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function download() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/account/export", {
        method: "POST",
        credentials: "same-origin",
      });
      if (response.status === 429) return setMessage(m.exportLimited);
      if (!response.ok) return setMessage(m.exportFailed);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download =
        /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ??
        "date-cont.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setMessage(m.exportFailed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title={m.sections.export}>
      <p className="max-w-prose text-ink-secondary">{m.exportText}</p>
      <div>
        <StoreButton
          type="button"
          variant="secondary"
          onClick={download}
          disabled={busy}
          data-export-button
        >
          {busy ? m.exportBusy : m.exportButton}
        </StoreButton>
      </div>
      <p role="alert" className="min-h-6 text-tone-problem-fg">
        {message}
      </p>
    </Panel>
  );
}

/** Ștergerea contului = anonimizare: dialog propriu, cu parola; refuz cu mesaj clar cât există comenzi nefinalizate sau retur deschis. */
export function DeletePanel() {
  const router = useRouter();
  const base = useId();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    if (password === "") {
      setError(m.deleteWrongPassword);
      document.getElementById(`${base}-password`)?.focus();
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await deleteAccountAction({ password });
      if (result.ok) {
        window.location.assign("/");
        return;
      }
      setError(
        result.code === "blocked_orders"
          ? m.deleteBlockedOrders
          : result.code === "blocked_returns"
            ? m.deleteBlockedReturns
            : result.code === "blocked_staff"
              ? m.deleteBlockedStaff
              : result.code === "wrong_password"
                ? m.deleteWrongPassword
                : m.deleteFailed,
      );
    } finally {
      setPending(false);
      router.refresh();
    }
  }

  return (
    <Panel title={m.sections.delete}>
      <p className="max-w-prose text-ink-secondary">{m.deleteText}</p>
      <div>
        <StoreButton
          type="button"
          variant="secondary"
          onClick={() => {
            setPassword("");
            setError(null);
            setOpen(true);
          }}
          data-delete-open
        >
          {m.deleteButton}
        </StoreButton>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={m.deleteTitle}
        description={m.deleteConfirmText}
        closeLabel={getMessages().account.common.close}
      >
        <form noValidate onSubmit={confirm} className="flex flex-col gap-4" data-delete-form>
          <Field id={`${base}-password`} label={m.deletePassword}>
            {(a) => (
              <input
                {...a}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={FIELD}
              />
            )}
          </Field>
          <p role="alert" className="min-h-6 text-tone-problem-fg" data-delete-error>
            {error}
          </p>
          <div className="flex flex-wrap justify-end gap-3">
            <StoreButton type="button" variant="secondary" onClick={() => setOpen(false)}>
              {m.deleteNo}
            </StoreButton>
            <StoreButton type="submit" disabled={pending} data-delete-confirm>
              {pending ? m.deleteWorking : m.deleteYes}
            </StoreButton>
          </div>
        </form>
      </Dialog>
    </Panel>
  );
}
