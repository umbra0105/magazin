"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { Button, Input, Label, Textarea } from "@ecom/ui";
import { adjustLoyaltyPoints } from "@/app/(admin)/admin/clienti/puncte/actions";
import { getMessages } from "@/messages";

const m = getMessages().admin.loyalty.adjust;

/** Ajustarea manuală a punctelor unui client: motiv obligatoriu, mesaje proprii, focus pe primul câmp greșit. */
export function AdjustPointsForm({ customerId }: { customerId: string }) {
  const router = useRouter();
  const base = useId();
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ points?: string; reason?: string }>({});
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // aceeași cerere trimisă de două ori (dublu clic, reîncercare) se aplică o singură dată
  const requestKey = useRef<string | null>(null);

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setStatus(null);
    setProblem(null);
    const value = /^-?\d{1,7}$/.test(points.trim()) ? Number(points.trim()) : 0;
    const found: { points?: string; reason?: string } = {};
    if (value === 0 || Math.abs(value) > 1_000_000) found.points = m.pointsInvalid;
    if (reason.trim().length < 3) found.reason = m.reasonRequired;
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(`${base}-${first}`)?.focus();
      return;
    }
    requestKey.current ??= crypto.randomUUID();
    const key = requestKey.current;
    start(async () => {
      try {
        const result = await adjustLoyaltyPoints({
          customerId,
          points: value,
          reason: reason.trim(),
          requestKey: key,
        });
        if (result.ok) {
          requestKey.current = null;
          setPoints("");
          setReason("");
          setStatus(m.done(result.balance));
          router.refresh();
        } else {
          setProblem(
            result.code === "insufficient"
              ? m.insufficient
              : result.code === "invalid"
                ? m.pointsInvalid
                : m.failed,
          );
        }
      } catch {
        setProblem(m.failed);
      }
    });
  };

  const describedBy = (name: "points" | "reason", help?: string) =>
    [help, errors[name] ? `${base}-${name}-error` : null].filter(Boolean).join(" ") || undefined;
  const errorFor = (name: "points" | "reason") =>
    errors[name] ? (
      <p id={`${base}-${name}-error`} role="alert" className="text-label text-tone-problem-fg">
        {errors[name]}
      </p>
    ) : null;

  return (
    <form noValidate onSubmit={onSubmit} className="flex max-w-xl flex-col gap-3" data-adjust-form>
      <h2 className="text-section">{m.title}</h2>
      <p id={`${base}-help`} className="text-label text-ink-secondary">
        {m.help}
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${base}-points`}>{m.points}</Label>
        <Input
          id={`${base}-points`}
          name="points"
          autoComplete="off"
          maxLength={9}
          value={points}
          aria-invalid={errors.points ? true : undefined}
          aria-describedby={describedBy("points", `${base}-help`)}
          onChange={(event) => {
            requestKey.current = null;
            setPoints(event.target.value);
          }}
          className="max-w-40"
        />
        {errorFor("points")}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${base}-reason`}>{m.reason}</Label>
        <Textarea
          id={`${base}-reason`}
          name="reason"
          rows={2}
          maxLength={300}
          value={reason}
          aria-invalid={errors.reason ? true : undefined}
          aria-describedby={describedBy("reason", `${base}-reason-help`)}
          onChange={(event) => {
            requestKey.current = null;
            setReason(event.target.value);
          }}
        />
        <p id={`${base}-reason-help`} className="text-label text-ink-secondary">
          {m.reasonHelp}
        </p>
        {errorFor("reason")}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? m.submitting : m.submit}
        </Button>
        <p role="status" className="text-body" data-adjust-status>
          {status}
        </p>
      </div>
      {problem ? (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
          data-adjust-problem
        >
          {problem}
        </p>
      ) : null}
    </form>
  );
}
