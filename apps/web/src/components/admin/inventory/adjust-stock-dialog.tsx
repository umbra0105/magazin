"use client";

import { SlidersHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Dialog, Input, Label, Select, Textarea } from "@ecom/ui";
import { adjustStock } from "@/app/(admin)/admin/produse/stoc/actions";
import type { ProductActionFailure } from "@/lib/product-action-support";
import {
  allowedDirections,
  composeQuantity,
  directionFor,
  validateAmount,
  type AdjustDirection,
  type SignRule,
} from "@/lib/stock-form";
import { formatLocalDate, formatLocalTime, parseLocalDateTime } from "@/lib/stock-time";
import { warningText } from "@/lib/stock-view";
import { getMessages } from "@/messages";

const m = getMessages().admin.inventory;

/** Cât de mult în viitor poate fi ora efectivă (oglindește toleranța din nucleu: ceasuri ușor nepotrivite). */
const FUTURE_TOLERANCE_MS = 60_000;

export interface ReasonOption {
  value: string;
  label: string;
  rule: SignRule;
}

export interface AdjustTarget {
  variantId: string;
  warehouseId: string;
  /** Produs și variantă, pentru titlu și pentru cititoarele de ecran */
  name: string;
  unit: { symbol: string; decimals: number };
  /** Stocul fizic de acum, deja formatat (cu unitate) */
  physicalText: string;
  /** Data pozei SmartBill aplicate (ISO), pentru avertismentul «ora efectivă dinaintea pozei» */
  asOf: string | null;
}

function errorText(result: ProductActionFailure): string {
  const errors = m.adjust.errors as unknown as Record<string, string | undefined>;
  return errors[result.code] ?? result.message ?? m.adjust.errors.generic;
}

/** Butonul «Ajustează» al unui rând de stoc și dialogul lui. Apare doar cu `inventory.write`. */
export function AdjustStockButton({
  target,
  reasons,
  timeZone,
  noteMax,
}: {
  target: AdjustTarget;
  reasons: readonly ReasonOption[];
  timeZone: string;
  noteMax: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-label={m.actions.adjustAria(target.name)}
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
        <span className="ml-1 hidden sm:inline">{m.actions.adjust}</span>
      </Button>
      {open && (
        <AdjustForm
          target={target}
          reasons={reasons}
          timeZone={timeZone}
          noteMax={noteMax}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

interface Saved {
  message: string;
  warnings: string[];
}

function AdjustForm({
  target,
  reasons,
  timeZone,
  noteMax,
  onClose,
}: {
  target: AdjustTarget;
  reasons: readonly ReasonOption[];
  timeZone: string;
  noteMax: number;
  onClose: () => void;
}) {
  const router = useRouter();
  // valorile implicite ale orei efective: ACUM, în ora magazinului (se calculează o singură dată, la deschidere)
  const [now] = useState(() => new Date());
  const [reason, setReason] = useState("");
  const [direction, setDirection] = useState<AdjustDirection>("subtract");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => formatLocalDate(now, timeZone));
  const [time, setTime] = useState(() => formatLocalTime(now, timeZone));
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [pending, startTransition] = useTransition();

  const rule: SignRule = reasons.find((r) => r.value === reason)?.rule ?? "either";
  const directions = allowedDirections(rule);
  const text = m.adjust;

  const chooseReason = (value: string) => {
    setReason(value);
    const next = reasons.find((r) => r.value === value)?.rule ?? "either";
    setDirection((current) => directionFor(next, current));
  };

  const validate = (): Record<string, string> => {
    const found: Record<string, string> = {};
    if (reason === "") found["reason"] = text.errors.reasonRequired;
    const parsedAmount = validateAmount(amount, target.unit.decimals);
    if (!parsedAmount.ok) {
      found["amount"] =
        parsedAmount.error === "required"
          ? text.errors.amountRequired
          : parsedAmount.error === "zero"
            ? text.errors.amountZero
            : parsedAmount.error === "decimals"
              ? text.errors.amountDecimals(target.unit.symbol, target.unit.decimals)
              : text.errors.amountInvalid;
    }
    const when = parseLocalDateTime(date, time, timeZone);
    if (!when.ok) {
      found[when.field] =
        when.field === "date"
          ? when.error === "required"
            ? text.errors.dateRequired
            : text.errors.dateInvalid
          : when.error === "required"
            ? text.errors.timeRequired
            : text.errors.timeInvalid;
    } else if (when.date.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      found["time"] = text.errors.future;
    }
    if (note.trim() === "") found["note"] = text.errors.noteRequired;
    else if (note.trim().length > noteMax) found["note"] = text.errors.noteTooLong(noteMax);
    return found;
  };

  const submit = () => {
    const found = validate();
    setErrors(found);
    setProblem(null);
    const first = (["reason", "amount", "date", "time", "note"] as const).find((key) => found[key]);
    if (first) {
      document.getElementById(`adjust-${first}`)?.focus();
      return;
    }
    const parsedAmount = validateAmount(amount, target.unit.decimals);
    const when = parseLocalDateTime(date, time, timeZone);
    if (!parsedAmount.ok || !when.ok) return;
    startTransition(async () => {
      try {
        const result = await adjustStock({
          variantId: target.variantId,
          warehouseId: target.warehouseId,
          quantity: composeQuantity(direction, parsedAmount.normalized),
          reason,
          note: note.trim(),
          effectiveAt: when.date.toISOString(),
        });
        if (result.ok) {
          const asOf = target.asOf ? new Date(target.asOf) : null;
          setSaved({
            message: text.saved(
              target.name,
              `${result.physicalBefore} ${target.unit.symbol}`,
              `${result.physicalAfter} ${target.unit.symbol}`,
            ),
            warnings: result.warnings.map((code) => warningText(code, { asOf, timeZone })),
          });
          router.refresh();
        } else {
          setProblem(errorText(result));
        }
      } catch {
        setProblem(text.errors.generic);
      }
    });
  };

  const describedBy = (id: string, help: boolean) =>
    [help ? `adjust-${id}-help` : null, errors[id] ? `adjust-${id}-error` : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const invalid = (id: string) => (errors[id] ? { "aria-invalid": true as const } : {});

  const fieldError = (id: string) =>
    errors[id] ? (
      <p id={`adjust-${id}-error`} className="text-xs text-danger">
        {errors[id]}
      </p>
    ) : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={text.title(target.name)}
      closeLabel={text.close}
      className="max-w-lg"
    >
      {saved ? (
        <div className="flex flex-col gap-4">
          <p
            role="status"
            data-saved
            className="rounded-md border border-success/50 bg-success/10 p-3 text-sm"
          >
            {saved.message}
          </p>
          {saved.warnings.length > 0 && (
            <div role="alert" data-warnings className="rounded-md border border-danger p-3 text-sm">
              <p className="font-medium">{m.warnings.title}</p>
              <ul className="mt-1 list-disc pl-5">
                {saved.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex justify-end">
            <Button type="button" onClick={onClose}>
              {text.close}
            </Button>
          </div>
        </div>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <p className="text-sm text-muted-foreground">{text.current(target.physicalText)}</p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="adjust-reason">{text.reason}</Label>
            <Select
              id="adjust-reason"
              value={reason}
              onChange={(event) => chooseReason(event.target.value)}
              {...invalid("reason")}
              {...(describedBy("reason", false) && {
                "aria-describedby": describedBy("reason", false),
              })}
            >
              <option value="">{text.reasonPlaceholder}</option>
              {reasons.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
            {fieldError("reason")}
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium">{text.direction}</legend>
            <div className="flex gap-4">
              {(["subtract", "add"] as const).map((value) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="adjust-direction"
                    value={value}
                    checked={direction === value}
                    disabled={!directions.includes(value)}
                    onChange={() => setDirection(value)}
                  />
                  {value === "add" ? text.add : text.subtract}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="adjust-amount">{text.amount}</Label>
            <Input
              id="adjust-amount"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              {...invalid("amount")}
              aria-describedby={describedBy("amount", true)}
            />
            <p id="adjust-amount-help" className="text-xs text-muted-foreground">
              {text.amountHelp(target.unit.symbol, target.unit.decimals)}
            </p>
            {fieldError("amount")}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="adjust-date">{text.date}</Label>
              <Input
                id="adjust-date"
                inputMode="numeric"
                autoComplete="off"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                {...invalid("date")}
                aria-describedby={describedBy("date", false)}
              />
              {fieldError("date")}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="adjust-time">{text.time}</Label>
              <Input
                id="adjust-time"
                inputMode="numeric"
                autoComplete="off"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                {...invalid("time")}
                aria-describedby={describedBy("time", true)}
              />
              {fieldError("time")}
            </div>
          </div>
          <p id="adjust-time-help" className="-mt-2 text-xs text-muted-foreground">
            {text.timeHelp(timeZone)}
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="adjust-note">{text.note}</Label>
            <Textarea
              id="adjust-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              {...invalid("note")}
              aria-describedby={describedBy("note", true)}
            />
            <p id="adjust-note-help" className="text-xs text-muted-foreground">
              {text.noteHelp}
            </p>
            {fieldError("note")}
          </div>

          {problem && (
            <p
              role="alert"
              data-problem
              className="rounded-md border border-danger p-3 text-sm text-danger"
            >
              {problem}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {text.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? text.saving : text.save}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
