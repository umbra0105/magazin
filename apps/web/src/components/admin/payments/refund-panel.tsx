"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { Button, Dialog, Input, Label, Textarea } from "@ecom/ui";
import { markRefundDoneManually, refundPayment } from "@/app/(admin)/admin/comenzi/plati/actions";
import { formatMoney, formatMoneyInput, parseMoneyInput } from "@/lib/money-input";
import { getMessages } from "@/messages";

const m = getMessages().admin.payments;

/** Formularul de rambursare (parțială sau totală), cu confirmare într-un dialog propriu și cheie de idempotență per formular. */
export function RefundForm({
  paymentId,
  remainingMinor,
  currency,
  locale,
  canRefund,
}: {
  paymentId: string;
  remainingMinor: number;
  currency: string;
  locale: string;
  canRefund: boolean;
}) {
  const moneyLabel = (minor: number) => formatMoney(minor, currency, locale);
  const router = useRouter();
  const id = useId();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const requestKey = useRef(crypto.randomUUID());

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canRefund || pending) return;
    setStatus(null);
    setProblem(null);
    const found: { amount?: string; reason?: string } = {};
    const minor = parseMoneyInput(amount);
    if (minor === null || minor < 1) found.amount = m.refund.amountInvalid;
    else if (minor > remainingMinor) found.amount = m.refund.amountTooHigh;
    if (reason.trim() === "") found.reason = m.refund.reasonRequired;
    setErrors(found);
    if (found.amount) {
      document.getElementById(`${id}-amount`)?.focus();
      return;
    }
    if (found.reason) {
      document.getElementById(`${id}-reason`)?.focus();
      return;
    }
    setConfirming(minor);
  };

  const confirm = () => {
    if (confirming === null) return;
    const minor = confirming;
    start(async () => {
      const result = await refundPayment({
        paymentId,
        amount: formatMoneyInput(minor),
        reason,
        requestKey: requestKey.current,
      });
      setConfirming(null);
      if (result.ok) {
        setStatus(m.refund.done);
        setAmount("");
        setReason("");
        requestKey.current = crypto.randomUUID();
        router.refresh();
        return;
      }
      setProblem(
        result.code === "tooHigh"
          ? m.refund.amountTooHigh
          : result.code === "notRefundable"
            ? m.refund.notRefundable
            : result.code === "amount"
              ? m.refund.amountInvalid
              : result.code === "reason"
                ? m.refund.reasonRequired
                : m.refund.failed,
      );
    });
  };

  if (remainingMinor <= 0) return null;
  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-body text-ink-secondary">{m.refund.help}</p>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-amount`}>{m.refund.amount}</Label>
          <Input
            id={`${id}-amount`}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            disabled={!canRefund}
            aria-invalid={errors.amount ? true : undefined}
            aria-describedby={errors.amount ? `${id}-amount-error` : undefined}
            onChange={(event) => setAmount(event.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={!canRefund}
            onClick={() => setAmount(formatMoneyInput(remainingMinor))}
          >
            {m.refund.refundAll} ({moneyLabel(remainingMinor)})
          </Button>
          {errors.amount && (
            <p id={`${id}-amount-error`} className="text-label text-tone-problem-fg">
              {errors.amount}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor={`${id}-reason`}>{m.refund.reason}</Label>
          <Textarea
            id={`${id}-reason`}
            rows={3}
            maxLength={500}
            value={reason}
            disabled={!canRefund}
            aria-invalid={errors.reason ? true : undefined}
            aria-describedby={`${id}-reason-help`}
            onChange={(event) => setReason(event.target.value)}
          />
          <span id={`${id}-reason-help`} className="text-label text-ink-secondary">
            {errors.reason ?? m.refund.reasonHelp}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!canRefund || pending}>
          {m.refund.submit}
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
      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={m.refund.confirmTitle}
        description={confirming === null ? undefined : m.refund.confirmBody(moneyLabel(confirming))}
        closeLabel={m.refund.cancel}
        className="max-w-lg"
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setConfirming(null)}>
            {m.refund.cancel}
          </Button>
          <Button type="button" onClick={confirm} disabled={pending}>
            {m.refund.confirm}
          </Button>
        </div>
      </Dialog>
    </form>
  );
}

/** «Am rambursat manual»: referința din contul procesatorului, cu confirmare. */
export function ManualRefundForm({
  refundId,
  canRefund,
}: {
  refundId: string;
  canRefund: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canRefund || pending) return;
    if (reference.trim() === "") {
      setError(m.manual.referenceRequired);
      document.getElementById(`${id}-reference`)?.focus();
      return;
    }
    setError(null);
    setOpen(true);
  };

  const confirm = () =>
    start(async () => {
      const result = await markRefundDoneManually({ refundId, reference });
      setOpen(false);
      if (result.ok) router.refresh();
      else setError(result.code === "reference" ? m.manual.referenceRequired : m.manual.failed);
    });

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-2">
      <Label htmlFor={`${id}-reference`}>{m.manual.reference}</Label>
      <div className="flex flex-wrap items-start gap-2">
        <Input
          id={`${id}-reference`}
          className="max-w-sm"
          autoComplete="off"
          value={reference}
          disabled={!canRefund}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setReference(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={!canRefund || pending}>
          {m.manual.submit}
        </Button>
      </div>
      {error && <p className="text-label text-tone-problem-fg">{error}</p>}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={m.manual.confirmTitle}
        description={m.manual.confirmBody}
        closeLabel={m.refund.cancel}
        className="max-w-lg"
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            {m.refund.cancel}
          </Button>
          <Button type="button" onClick={confirm} disabled={pending}>
            {m.manual.confirm}
          </Button>
        </div>
      </Dialog>
    </form>
  );
}
