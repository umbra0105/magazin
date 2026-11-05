"use client";

import { ArrowRightLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Dialog, Input, Label, Select, Textarea } from "@ecom/ui";
import { transferStock } from "@/app/(admin)/admin/produse/stoc/actions";
import type { ProductActionFailure } from "@/lib/product-action-support";
import { validateTransfer } from "@/lib/stock-form";
import type { TransferTargetData } from "@/lib/stock-view";
import { getMessages } from "@/messages";

const m = getMessages().admin.inventory;

export interface TransferDestination {
  id: string;
  name: string;
}

function errorText(result: ProductActionFailure): string {
  const errors = m.transfer.errors as unknown as Record<string, string | undefined>;
  return errors[result.code] ?? result.message ?? m.transfer.errors.generic;
}

/**
 * Butonul «Transferă» al unui rând de stoc și dialogul lui (13d). Apare doar cu `inventory.write`, cu steagul de multi-depozit
 * pornit și cu cel puțin două depozite active (pagina nu-l desenează altfel). Sursa e depozitul afișat; destinațiile sunt
 * celelalte depozite active. Serverul rămâne autoritatea (disponibil, pas, unitate, depozite active) și validează din nou.
 */
export function TransferStockButton({
  target,
  destinations,
  noteMax,
  refreshOnClose = false,
}: {
  target: TransferTargetData;
  destinations: readonly TransferDestination[];
  noteMax: number;
  /** Reîmprospătează lista abia la închiderea dialogului (vederea «Stoc mic»: rândul poate ieși din listă) */
  refreshOnClose?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-label={m.transfer.openAria(target.name)}
        onClick={() => setOpen(true)}
      >
        <ArrowRightLeft aria-hidden="true" className="h-4 w-4" />
        <span className="ml-1 hidden sm:inline">{m.transfer.open}</span>
      </Button>
      {open && (
        <TransferForm
          target={target}
          destinations={destinations}
          noteMax={noteMax}
          refreshOnClose={refreshOnClose}
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

function TransferForm({
  target,
  destinations,
  noteMax,
  refreshOnClose,
  onClose,
}: {
  target: TransferTargetData;
  destinations: readonly TransferDestination[];
  noteMax: number;
  refreshOnClose: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const text = m.transfer;
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [pending, startTransition] = useTransition();

  const close = () => {
    onClose();
    if (saved && refreshOnClose) router.refresh();
  };

  const validate = () => {
    const result = validateTransfer({
      destination,
      amount,
      decimals: target.unit.decimals,
      destinations: destinations.map((d) => d.id),
    });
    const found: Record<string, string> = {};
    if (!result.ok) {
      if (result.errors.destination) found["destination"] = text.errors.destinationRequired;
      const amountError = result.errors.amount;
      if (amountError) {
        found["amount"] =
          amountError === "required"
            ? text.errors.amountRequired
            : amountError === "zero"
              ? text.errors.amountZero
              : amountError === "decimals"
                ? text.errors.amountDecimals(target.unit.symbol, target.unit.decimals)
                : text.errors.amountInvalid;
      }
    }
    if (note.trim().length > noteMax) found["note"] = text.errors.noteTooLong(noteMax);
    return { result, found };
  };

  const submit = () => {
    const { result, found } = validate();
    setErrors(found);
    setProblem(null);
    const first = (["destination", "amount", "note"] as const).find((key) => found[key]);
    if (first) {
      document.getElementById(`transfer-${first}`)?.focus();
      return;
    }
    if (!result.ok) return;
    const destinationName = destinations.find((d) => d.id === result.destination)?.name ?? "";
    startTransition(async () => {
      try {
        const outcome = await transferStock({
          variantId: target.variantId,
          fromWarehouseId: target.sourceWarehouseId,
          toWarehouseId: result.destination,
          quantity: result.quantity,
          ...(note.trim() !== "" && { note: note.trim() }),
        });
        if (outcome.ok) {
          setSaved({
            message: text.saved(
              `${outcome.quantity} ${target.unit.symbol}`,
              target.sourceWarehouseName,
              destinationName,
            ),
            warnings: outcome.warnings,
          });
          if (!refreshOnClose) router.refresh();
        } else {
          setProblem(errorText(outcome));
        }
      } catch {
        setProblem(text.errors.generic);
      }
    });
  };

  const describedBy = (id: string, help: boolean) =>
    [help ? `transfer-${id}-help` : null, errors[id] ? `transfer-${id}-error` : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const invalid = (id: string) => (errors[id] ? { "aria-invalid": true as const } : {});
  const fieldError = (id: string) =>
    errors[id] ? (
      <p id={`transfer-${id}-error`} className="text-xs text-danger">
        {errors[id]}
      </p>
    ) : null;

  return (
    <Dialog
      open
      onClose={close}
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
              <p className="font-medium">{text.warningsTitle}</p>
              <ul className="mt-1 list-disc pl-5">
                {saved.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex justify-end">
            <Button type="button" onClick={close}>
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
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium" data-source>
              {text.source(target.sourceWarehouseName)}
            </p>
            <p data-available>{text.available(target.availableText, target.availableSteps)}</p>
            <p className="text-xs text-muted-foreground">{text.availableHelp}</p>
            <p className="text-xs text-muted-foreground" data-step>
              {text.step(target.stepText)}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="transfer-destination">{text.destination}</Label>
            <Select
              id="transfer-destination"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              {...invalid("destination")}
              {...(describedBy("destination", false) && {
                "aria-describedby": describedBy("destination", false),
              })}
            >
              <option value="">{text.destinationPlaceholder}</option>
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
            {fieldError("destination")}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="transfer-amount">{text.amount}</Label>
            <Input
              id="transfer-amount"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              {...invalid("amount")}
              aria-describedby={describedBy("amount", true)}
            />
            <p id="transfer-amount-help" className="text-xs text-muted-foreground">
              {text.amountHelp(target.unit.symbol, target.unit.decimals)}
            </p>
            {fieldError("amount")}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="transfer-note">{text.note}</Label>
            <Textarea
              id="transfer-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              {...invalid("note")}
              aria-describedby={describedBy("note", true)}
            />
            <p id="transfer-note-help" className="text-xs text-muted-foreground">
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
            <Button type="button" variant="outline" onClick={close}>
              {text.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? text.submitting : text.submit}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
