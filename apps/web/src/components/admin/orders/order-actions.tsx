"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { Button, Dialog, Input, Label, Textarea } from "@ecom/ui";
import {
  cancelOrderAction,
  clearSupplierAction,
  correctOrderAction,
  markPaidAction,
  markSupplierAction,
  processOrder,
  refundOrderAction,
} from "@/app/(admin)/admin/comenzi/actions";
import { formatMoney, formatMoneyInput, parseMoneyInput } from "@/lib/money-input";
import { getMessages } from "@/messages";

const t = getMessages().admin.orders;

export interface OrderActionsProps {
  orderId: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  fulfillmentStatus: string;
  totalMinor: number;
  currency: string;
  locale: string;
  /** Banii sunt încasați (plătită, parțial rambursată sau autorizată): anularea cere decizie explicită. */
  moneyHeld: boolean;
  caps: {
    process: boolean;
    cancel: boolean;
    refund: boolean;
    markPaid: boolean;
    edit: boolean;
    supplier: boolean;
  };
  /** Rambursare posibilă: suma rămasă și, pentru un rol cu limită, ce mai poate rambursa el. */
  refund: {
    remainingMinor: number;
    limit: { limitMinor: number; remainingMinor: number } | null;
  } | null;
  supplier: { name: string | null; note: string | null } | null;
  /** Date pentru corectare (doar cu drept de date personale). */
  edit: {
    email: string;
    phone: string;
    shipping: AddressFields;
    billing: AddressFields | null;
  } | null;
}

interface AddressFields {
  fullName: string;
  phone: string;
  street: string;
  postalCode: string;
}

type DialogId = "cancel" | "refund" | "markPaid" | "edit" | "supplier" | null;

/**
 * Acțiunile unei comenzi (Faza 11): un singur buton principal pe ecran (cel potrivit stării comenzii), restul secundare. Fiecare
 * acțiune are propriul dialog, cu `noValidate` și mesaje în română, cu focus pe primul câmp greșit. Interfața nu decide nimic:
 * permisiunile, limita Suport și toate regulile sunt verificate din nou pe server în acțiuni.
 */
export function OrderActions(props: OrderActionsProps) {
  const router = useRouter();
  const [open, setOpen] = useState<DialogId>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const money = (minor: number) => formatMoney(minor, props.currency, props.locale);

  const active = ["pending", "confirmed", "processing"].includes(props.status);
  const canProcess = props.caps.process && props.status === "confirmed";
  const canMarkPaid =
    props.caps.markPaid &&
    props.paymentMethod === "bank_transfer" &&
    props.status === "pending" &&
    props.paymentStatus === "pending";
  const canCancel = props.caps.cancel && active && props.fulfillmentStatus === "unfulfilled";
  const canRefund = props.caps.refund && props.refund !== null && props.refund.remainingMinor > 0;
  const canEdit = props.caps.edit && active && props.edit !== null;
  const canSupplier = props.caps.supplier && active;
  const primary: "markPaid" | "process" | null = canMarkPaid
    ? "markPaid"
    : canProcess
      ? "process"
      : null;

  const done = (text: string) => {
    setOpen(null);
    setProblem(null);
    setMessage(text);
    router.refresh();
  };

  const runProcess = () =>
    start(async () => {
      setProblem(null);
      const result = await processOrder({ orderId: props.orderId });
      if (result.ok) done(t.actions.processingDone);
      else
        setProblem(result.code === "notConfirmed" ? t.actions.processingInvalid : t.actions.failed);
    });

  const runClearSupplier = () =>
    start(async () => {
      setProblem(null);
      const result = await clearSupplierAction({ orderId: props.orderId });
      if (result.ok) done(t.supplier.cleared);
      else setProblem(t.actions.failed);
    });

  return (
    <div className="flex flex-col gap-3" data-order-actions>
      <div className="flex flex-wrap items-center gap-2">
        {primary === "markPaid" && (
          <Button type="button" onClick={() => setOpen("markPaid")}>
            {t.actions.markPaid}
          </Button>
        )}
        {primary === "process" && (
          <Button type="button" onClick={runProcess} disabled={pending}>
            {t.actions.processing}
          </Button>
        )}
        {canMarkPaid && primary !== "markPaid" && (
          <Button type="button" variant="outline" onClick={() => setOpen("markPaid")}>
            {t.actions.markPaid}
          </Button>
        )}
        {canRefund && (
          <Button type="button" variant="outline" onClick={() => setOpen("refund")}>
            {t.actions.refund}
          </Button>
        )}
        {canEdit && (
          <Button type="button" variant="outline" onClick={() => setOpen("edit")}>
            {t.actions.edit}
          </Button>
        )}
        {canSupplier && (
          <Button type="button" variant="outline" onClick={() => setOpen("supplier")}>
            {t.actions.supplierMark}
          </Button>
        )}
        {canSupplier && props.supplier && (
          <Button type="button" variant="outline" onClick={runClearSupplier} disabled={pending}>
            {t.actions.supplierClear}
          </Button>
        )}
        {canCancel && (
          <Button type="button" variant="outline" onClick={() => setOpen("cancel")}>
            {t.actions.cancel}
          </Button>
        )}
      </div>
      <p role="status" aria-live="polite" className="text-body text-ink-secondary">
        {message}
      </p>
      {problem && (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {problem}
        </p>
      )}

      {open === "cancel" && (
        <CancelDialog
          orderId={props.orderId}
          moneyHeld={props.moneyHeld}
          onClose={() => setOpen(null)}
          onDone={done}
        />
      )}
      {open === "refund" && props.refund && (
        <RefundDialog
          orderId={props.orderId}
          remainingMinor={props.refund.remainingMinor}
          limit={props.refund.limit}
          money={money}
          onClose={() => setOpen(null)}
          onDone={done}
        />
      )}
      {open === "markPaid" && (
        <MarkPaidDialog
          orderId={props.orderId}
          totalMinor={props.totalMinor}
          money={money}
          onClose={() => setOpen(null)}
          onDone={done}
        />
      )}
      {open === "edit" && props.edit && (
        <EditDialog
          orderId={props.orderId}
          initial={props.edit}
          onClose={() => setOpen(null)}
          onDone={done}
        />
      )}
      {open === "supplier" && (
        <SupplierDialog
          orderId={props.orderId}
          initial={props.supplier}
          onClose={() => setOpen(null)}
          onDone={done}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------------------------------------------------------------------

function DialogFooter({
  onClose,
  submitLabel,
  pending,
  destructive,
  disabled,
}: {
  onClose: () => void;
  submitLabel: string;
  pending: boolean;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" onClick={onClose}>
        {t.actions.cancelButton}
      </Button>
      <Button
        type="submit"
        variant={destructive ? "destructive" : "default"}
        disabled={pending || disabled}
      >
        {submitLabel}
      </Button>
    </div>
  );
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} className="text-label text-tone-problem-fg">
      {children}
    </p>
  );
}

function Alert({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg">
      {children}
    </p>
  );
}

const focus = (id: string) => document.getElementById(id)?.focus();

// --- anulare ---------------------------------------------------------------------------------------------------------------

function CancelDialog({
  orderId,
  moneyHeld,
  onClose,
  onDone,
}: {
  orderId: string;
  moneyHeld: boolean;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const [errors, setErrors] = useState<{ reason?: string; ack?: string }>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const found: { reason?: string; ack?: string } = {};
    const trimmed = reason.trim();
    if (trimmed.length < 3 || trimmed.length > 300) found.reason = t.cancel.reasonRequired;
    if (moneyHeld && !ack) found.ack = t.cancel.acknowledgeRequired;
    setErrors(found);
    if (found.reason) return focus(`${id}-reason`);
    if (found.ack) return focus(`${id}-ack`);
    start(async () => {
      const result = await cancelOrderAction({ orderId, reason: trimmed, acknowledgePaid: ack });
      if (result.ok) return onDone(result.needsRefund ? t.cancel.donePaid : t.cancel.done);
      setProblem(
        result.code === "reason"
          ? t.cancel.reasonRequired
          : result.code === "paidDecision"
            ? t.cancel.acknowledgeRequired
            : result.code === "cannotCancel"
              ? t.cancel.invalid
              : t.actions.failed,
      );
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t.cancel.title}
      description={t.cancel.help}
      closeLabel={t.actions.close}
      className="max-w-lg"
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        {moneyHeld && (
          <p
            role="note"
            className="rounded-lg bg-tone-warning-bg p-3 text-body text-tone-warning-fg"
          >
            {t.cancel.paidWarning}
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-reason`}>{t.cancel.reason}</Label>
          <Textarea
            id={`${id}-reason`}
            rows={3}
            maxLength={300}
            value={reason}
            aria-invalid={errors.reason ? true : undefined}
            aria-describedby={`${id}-reason-help`}
            onChange={(event) => setReason(event.target.value)}
          />
          <span
            id={`${id}-reason-help`}
            className={
              errors.reason ? "text-label text-tone-problem-fg" : "text-label text-ink-secondary"
            }
          >
            {errors.reason ?? t.cancel.reasonHelp}
          </span>
        </div>
        {moneyHeld && (
          <div className="flex flex-col gap-1">
            <label className="flex items-start gap-2 text-body">
              <input
                id={`${id}-ack`}
                type="checkbox"
                className="mt-1 size-4 accent-brand"
                checked={ack}
                aria-invalid={errors.ack ? true : undefined}
                onChange={(event) => setAck(event.target.checked)}
              />
              <span>{t.cancel.acknowledge}</span>
            </label>
            <FieldError id={`${id}-ack-error`}>{errors.ack}</FieldError>
          </div>
        )}
        <Alert>{problem}</Alert>
        <DialogFooter
          onClose={onClose}
          submitLabel={t.cancel.submit}
          pending={pending}
          destructive
        />
      </form>
    </Dialog>
  );
}

// --- rambursare ------------------------------------------------------------------------------------------------------------

function RefundDialog({
  orderId,
  remainingMinor,
  limit,
  money,
  onClose,
  onDone,
}: {
  orderId: string;
  remainingMinor: number;
  limit: { limitMinor: number; remainingMinor: number } | null;
  money: (minor: number) => string;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const id = useId();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const requestKey = useRef(crypto.randomUUID());
  // un rol cu limită nu poate cere mai mult decât îi mai permite limita (serverul verifică oricum, sub blocare)
  const ceiling = limit ? Math.min(remainingMinor, limit.remainingMinor) : remainingMinor;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const found: { amount?: string; reason?: string } = {};
    const minor = parseMoneyInput(amount);
    if (minor === null || minor < 1) found.amount = t.refund.amountInvalid;
    else if (minor > remainingMinor) found.amount = t.refund.amountTooHigh;
    else if (limit && minor > limit.remainingMinor)
      found.amount = t.refund.overLimit(money(limit.remainingMinor));
    if (reason.trim() === "") found.reason = t.refund.reasonRequired;
    setErrors(found);
    if (found.amount) return focus(`${id}-amount`);
    if (found.reason) return focus(`${id}-reason`);
    setConfirming(minor);
  };

  const confirm = () => {
    if (confirming === null) return;
    const minor = confirming;
    start(async () => {
      const result = await refundOrderAction({
        orderId,
        amount: formatMoneyInput(minor),
        reason,
        requestKey: requestKey.current,
      });
      setConfirming(null);
      if (result.ok) return onDone(t.refund.done);
      setProblem(
        result.code === "overLimit"
          ? t.refund.overLimit(money(result.remainingMinor ?? 0))
          : result.code === "limitUnavailable"
            ? t.refund.limitUnavailable
            : result.code === "tooHigh"
              ? t.refund.amountTooHigh
              : result.code === "notRefundable"
                ? t.refund.notRefundable
                : result.code === "amount"
                  ? t.refund.amountInvalid
                  : result.code === "reason"
                    ? t.refund.reasonRequired
                    : t.refund.failed,
      );
    });
  };

  return (
    <>
      <Dialog
        open={confirming === null}
        onClose={onClose}
        title={t.refund.title}
        description={t.refund.help}
        closeLabel={t.actions.close}
        className="max-w-lg"
      >
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <p className="text-body">{t.refund.remaining(money(remainingMinor))}</p>
          {limit && (
            <p role="note" className="rounded-lg bg-surface-subtle p-3 text-body">
              {limit.remainingMinor > 0
                ? t.refund.limit(money(limit.limitMinor), money(limit.remainingMinor))
                : t.refund.limitNone}
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-amount`}>{t.refund.amount}</Label>
            <Input
              id={`${id}-amount`}
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              aria-invalid={errors.amount ? true : undefined}
              aria-describedby={errors.amount ? `${id}-amount-error` : undefined}
              onChange={(event) => setAmount(event.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              disabled={ceiling <= 0}
              onClick={() => setAmount(formatMoneyInput(ceiling))}
            >
              {t.refund.all} ({money(ceiling)})
            </Button>
            <FieldError id={`${id}-amount-error`}>{errors.amount}</FieldError>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-reason`}>{t.refund.reason}</Label>
            <Textarea
              id={`${id}-reason`}
              rows={3}
              maxLength={500}
              value={reason}
              aria-invalid={errors.reason ? true : undefined}
              aria-describedby={`${id}-reason-help`}
              onChange={(event) => setReason(event.target.value)}
            />
            <span
              id={`${id}-reason-help`}
              className={
                errors.reason ? "text-label text-tone-problem-fg" : "text-label text-ink-secondary"
              }
            >
              {errors.reason ?? t.refund.reasonHelp}
            </span>
          </div>
          <Alert>{problem}</Alert>
          <DialogFooter
            onClose={onClose}
            submitLabel={t.refund.submit}
            pending={pending}
            disabled={ceiling <= 0}
          />
        </form>
      </Dialog>
      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={t.refund.confirmTitle}
        description={confirming === null ? undefined : t.refund.confirmBody(money(confirming))}
        closeLabel={t.actions.close}
        className="max-w-lg"
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setConfirming(null)}>
            {t.actions.cancelButton}
          </Button>
          <Button type="button" onClick={confirm} disabled={pending}>
            {t.refund.confirm}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

// --- marchează plătit ------------------------------------------------------------------------------------------------------

function MarkPaidDialog({
  orderId,
  totalMinor,
  money,
  onClose,
  onDone,
}: {
  orderId: string;
  totalMinor: number;
  money: (minor: number) => string;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const id = useId();
  const [amount, setAmount] = useState(formatMoneyInput(totalMinor));
  const [reference, setReference] = useState("");
  const [accept, setAccept] = useState(false);
  const [errors, setErrors] = useState<{ amount?: string; reference?: string; accept?: string }>(
    {},
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const parsed = parseMoneyInput(amount);
  const differs = parsed !== null && parsed >= 1 && parsed !== totalMinor;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const found: { amount?: string; reference?: string; accept?: string } = {};
    if (parsed === null || parsed < 1) found.amount = t.markPaid.amountInvalid;
    const ref = reference.trim();
    if (ref.length < 3 || ref.length > 100) found.reference = t.markPaid.referenceRequired;
    if (differs && !accept) found.accept = t.markPaid.acceptRequired;
    setErrors(found);
    if (found.amount) return focus(`${id}-amount`);
    if (found.reference) return focus(`${id}-reference`);
    if (found.accept) return focus(`${id}-accept`);
    start(async () => {
      const result = await markPaidAction({
        orderId,
        amount: formatMoneyInput(parsed as number),
        reference: ref,
        acceptDifference: accept,
      });
      if (result.ok) return onDone(result.already ? t.markPaid.already : t.markPaid.done);
      setProblem(
        result.code === "mismatch"
          ? t.markPaid.acceptRequired
          : result.code === "amount"
            ? t.markPaid.amountInvalid
            : result.code === "reference"
              ? t.markPaid.referenceRequired
              : result.code === "notPending"
                ? t.markPaid.notPending
                : t.markPaid.failed,
      );
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t.markPaid.title}
      description={t.markPaid.help}
      closeLabel={t.actions.close}
      className="max-w-lg"
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-body">{t.markPaid.expected(money(totalMinor))}</p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-amount`}>{t.markPaid.amount}</Label>
          <Input
            id={`${id}-amount`}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            aria-invalid={errors.amount ? true : undefined}
            onChange={(event) => setAmount(event.target.value)}
          />
          <FieldError id={`${id}-amount-error`}>{errors.amount}</FieldError>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-reference`}>{t.markPaid.reference}</Label>
          <Input
            id={`${id}-reference`}
            autoComplete="off"
            maxLength={100}
            value={reference}
            aria-invalid={errors.reference ? true : undefined}
            aria-describedby={`${id}-reference-help`}
            onChange={(event) => setReference(event.target.value)}
          />
          <span
            id={`${id}-reference-help`}
            className={
              errors.reference ? "text-label text-tone-problem-fg" : "text-label text-ink-secondary"
            }
          >
            {errors.reference ?? t.markPaid.referenceHelp}
          </span>
        </div>
        {differs && parsed !== null && (
          <div
            role="note"
            className="flex flex-col gap-2 rounded-lg bg-tone-warning-bg p-3 text-tone-warning-fg"
          >
            <p className="text-heading">{t.markPaid.differenceTitle}</p>
            <p className="text-body">
              {t.markPaid.differenceBody(money(totalMinor), money(parsed))}
            </p>
            <label className="flex items-start gap-2 text-body">
              <input
                id={`${id}-accept`}
                type="checkbox"
                className="mt-1 size-4 accent-brand"
                checked={accept}
                aria-invalid={errors.accept ? true : undefined}
                onChange={(event) => setAccept(event.target.checked)}
              />
              <span>{t.markPaid.acceptDifference}</span>
            </label>
            <FieldError id={`${id}-accept-error`}>{errors.accept}</FieldError>
          </div>
        )}
        <Alert>{problem}</Alert>
        <DialogFooter onClose={onClose} submitLabel={t.markPaid.submit} pending={pending} />
      </form>
    </Dialog>
  );
}

// --- editare (contact și adrese) ----------------------------------------------------------------------------------------

function AddressInputs({
  prefix,
  title,
  value,
  onChange,
  errors,
}: {
  prefix: string;
  title: string;
  value: AddressFields;
  onChange: (next: AddressFields) => void;
  errors: Record<string, string>;
}) {
  const field = (
    name: keyof AddressFields,
    label: string,
    extra?: { inputMode?: "tel" | "numeric" },
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${prefix}-${name}`}>{label}</Label>
      <Input
        id={`${prefix}-${name}`}
        autoComplete="off"
        value={value[name]}
        inputMode={extra?.inputMode}
        aria-invalid={errors[name] ? true : undefined}
        onChange={(event) => onChange({ ...value, [name]: event.target.value })}
      />
      <FieldError id={`${prefix}-${name}-error`}>{errors[name]}</FieldError>
    </div>
  );
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg bg-surface-subtle p-3">
      <legend className="px-1 text-heading">{title}</legend>
      {field("fullName", t.edit.fullName)}
      {field("phone", t.edit.phone, { inputMode: "tel" })}
      {field("street", t.edit.street)}
      {field("postalCode", t.edit.postalCode, { inputMode: "numeric" })}
    </fieldset>
  );
}

function EditDialog({
  orderId,
  initial,
  onClose,
  onDone,
}: {
  orderId: string;
  initial: NonNullable<OrderActionsProps["edit"]>;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const id = useId();
  const [email, setEmail] = useState(initial.email);
  const [phone, setPhone] = useState(initial.phone);
  const [shipping, setShipping] = useState(initial.shipping);
  const [billing, setBilling] = useState(initial.billing);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const validateAddress = (a: AddressFields, scope: string, out: Record<string, string>) => {
    if (a.fullName.trim().length < 2) out[`${scope}.fullName`] = t.edit.nameInvalid;
    if (!/^(?:\+40|0040|0)\d{9}$/.test(a.phone.replace(/[\s.\-()]/g, "")))
      out[`${scope}.phone`] = t.edit.phoneInvalid;
    if (a.street.trim().length < 3) out[`${scope}.street`] = t.edit.streetInvalid;
    if (!/^\d{6}$/.test(a.postalCode.trim())) out[`${scope}.postalCode`] = t.edit.postalInvalid;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const found: Record<string, string> = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) found["email"] = t.edit.emailInvalid;
    if (!/^(?:\+40|0040|0)\d{9}$/.test(phone.replace(/[\s.\-()]/g, "")))
      found["phone"] = t.edit.phoneInvalid;
    validateAddress(shipping, "shipping", found);
    if (billing) validateAddress(billing, "billing", found);
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      const [scope, name] = first.split(".");
      return focus(name ? `${id}-${scope}-${name}` : `${id}-${scope}`);
    }
    start(async () => {
      const result = await correctOrderAction({ orderId, email, phone, shipping, billing });
      if (result.ok) return onDone(result.changed.length === 0 ? t.edit.nothing : t.edit.done);
      setProblem(result.code === "editInvalid" ? t.edit.invalid : t.actions.failed);
    });
  };

  const scoped = (scope: string) =>
    Object.fromEntries(
      Object.entries(errors)
        .filter(([key]) => key.startsWith(`${scope}.`))
        .map(([key, value]) => [key.slice(scope.length + 1), value]),
    );

  return (
    <Dialog
      open
      onClose={onClose}
      title={t.edit.title}
      description={t.edit.help}
      closeLabel={t.actions.close}
      className="max-w-xl"
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3 rounded-lg bg-surface-subtle p-3">
          <legend className="px-1 text-heading">{t.edit.contact}</legend>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-email`}>{t.edit.email}</Label>
            <Input
              id={`${id}-email`}
              autoComplete="off"
              value={email}
              aria-invalid={errors["email"] ? true : undefined}
              onChange={(event) => setEmail(event.target.value)}
            />
            <FieldError id={`${id}-email-error`}>{errors["email"]}</FieldError>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-phone`}>{t.edit.phone}</Label>
            <Input
              id={`${id}-phone`}
              autoComplete="off"
              inputMode="tel"
              value={phone}
              aria-invalid={errors["phone"] ? true : undefined}
              onChange={(event) => setPhone(event.target.value)}
            />
            <FieldError id={`${id}-phone-error`}>{errors["phone"]}</FieldError>
          </div>
        </fieldset>
        <AddressInputs
          prefix={`${id}-shipping`}
          title={t.edit.address}
          value={shipping}
          onChange={setShipping}
          errors={scoped("shipping")}
        />
        {billing && (
          <AddressInputs
            prefix={`${id}-billing`}
            title={t.edit.billing}
            value={billing}
            onChange={setBilling}
            errors={scoped("billing")}
          />
        )}
        <p className="text-label text-ink-secondary">{t.edit.zoneLocked}</p>
        <Alert>{problem}</Alert>
        <DialogFooter onClose={onClose} submitLabel={t.edit.submit} pending={pending} />
      </form>
    </Dialog>
  );
}

// --- «La furnizor» -------------------------------------------------------------------------------------------------------

function SupplierDialog({
  orderId,
  initial,
  onClose,
  onDone,
}: {
  orderId: string;
  initial: { name: string | null; note: string | null } | null;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState(initial?.name ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (name.trim().length > 200 || note.trim().length > 1000) {
      setProblem(t.supplier.invalid);
      return focus(`${id}-name`);
    }
    start(async () => {
      const result = await markSupplierAction({ orderId, name, note });
      if (result.ok) return onDone(t.supplier.done);
      setProblem(result.code === "markInvalid" ? t.supplier.invalid : t.supplier.failed);
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t.supplier.title}
      description={t.supplier.help}
      closeLabel={t.actions.close}
      className="max-w-lg"
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>{t.supplier.name}</Label>
          <Input
            id={`${id}-name`}
            autoComplete="off"
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-note`}>{t.supplier.note}</Label>
          <Textarea
            id={`${id}-note`}
            rows={3}
            maxLength={1000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <Alert>{problem}</Alert>
        <DialogFooter onClose={onClose} submitLabel={t.supplier.submit} pending={pending} />
      </form>
    </Dialog>
  );
}
