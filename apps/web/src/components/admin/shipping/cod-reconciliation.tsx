"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Badge, Button, Dialog, Input, Label, TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
import { markCodCollectedAction } from "@/app/(admin)/admin/comenzi/expediere-actions";
import { formatMoneyInput, parseMoneyInput } from "@/lib/money-input";
import { getMessages } from "@/messages";

const m = getMessages().admin.shipping.cod;
const statuses = getMessages().admin.shipping.panel.statuses;

export interface CodRowDto {
  orderId: string;
  number: string;
  carrier: string;
  awb: string;
  status: string;
  shippedText: string;
  totalMinor: number;
  totalText: string;
}

/**
 * Reconcilierea rambursului: comenzile expediate cu ramburs și încă nevirate. «Marchează încasat» cere suma virată, referința din
 * extras și data; o sumă diferită de total cere decizie explicită. Regulile sunt pe server (aceleași ca la «Marchează plătit»).
 */
export function CodReconciliation({
  rows,
  canCollect,
  today,
}: {
  rows: CodRowDto[];
  canCollect: boolean;
  /** AAAA-LL-ZZ, ziua curentă în ora magazinului (valoarea implicită și limita superioară a datei). */
  today: string;
}) {
  const router = useRouter();
  const base = useId();
  const [open, setOpen] = useState<CodRowDto | null>(null);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [date, setDate] = useState(today);
  const [accept, setAccept] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const openFor = (row: CodRowDto) => {
    setOpen(row);
    setAmount(formatMoneyInput(row.totalMinor));
    setReference("");
    setDate(today);
    setAccept(false);
    setErrors({});
    setProblem(null);
  };

  const parsedAmount = parseMoneyInput(amount);
  const differs = open !== null && parsedAmount !== null && parsedAmount !== open.totalMinor;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!open || pending) return;
    const found: Record<string, string> = {};
    if (parsedAmount === null || parsedAmount < 1) {
      found["amount"] = m.errors["ORDER_PAYMENT_AMOUNT_INVALID"] ?? "";
    }
    if (reference.trim().length < 3 || reference.trim().length > 100) {
      found["reference"] = m.errors["ORDER_PAYMENT_REFERENCE_INVALID"] ?? "";
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) {
      found["date"] = m.errors["ORDER_PAYMENT_DATE_INVALID"] ?? "";
    }
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(`${base}-${first}`)?.focus();
      return;
    }
    setProblem(null);
    start(async () => {
      const result = await markCodCollectedAction({
        orderId: open.orderId,
        amount,
        reference,
        date,
        acceptDifference: accept,
      });
      if (result.ok) {
        setStatus(result.already ? m.already : m.collected);
        setOpen(null);
        router.refresh();
      } else {
        setProblem(m.errors[result.code] ?? m.errors["failed"] ?? "");
      }
    });
  };

  if (rows.length === 0) {
    return (
      <p className="text-body text-ink-secondary" data-cod-empty>
        {m.empty}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-cod-reconciliation>
      <Table stacked aria-label={m.title}>
        <THead>
          <Tr>
            <Th priority="primary">{m.colOrder}</Th>
            <Th priority="secondary">{m.colCarrier}</Th>
            <Th priority="secondary">{m.colAwb}</Th>
            <Th priority="secondary">{m.colStatus}</Th>
            <Th priority="secondary">{m.colShipped}</Th>
            <Th priority="primary" numeric>
              {m.colTotal}
            </Th>
            <Th priority="primary">
              <span className="sr-only">{m.markCollected}</span>
            </Th>
          </Tr>
        </THead>
        <TBody>
          {rows.map((row) => (
            <Tr key={row.orderId} data-cod-row={row.orderId}>
              <Td>
                <Link
                  href={`/admin/comenzi/${encodeURIComponent(row.orderId)}`}
                  className="text-link underline-offset-2 hover:underline"
                >
                  {row.number}
                </Link>
              </Td>
              <Td>{row.carrier}</Td>
              <Td>{row.awb}</Td>
              <Td>
                <Badge variant={row.status === "delivered" ? "success" : "info"} dot>
                  {statuses[row.status] ?? row.status}
                </Badge>
              </Td>
              <Td>{row.shippedText}</Td>
              <Td numeric>{row.totalText}</Td>
              <Td>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canCollect}
                  onClick={() => openFor(row)}
                >
                  {m.markCollected}
                </Button>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      <span role="status" aria-live="polite" className="text-body text-ink-secondary">
        {status}
      </span>

      <Dialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open ? m.dialogTitle(open.number) : ""}
        description={m.dialogHelp}
        closeLabel={m.cancel}
        className="max-w-lg"
      >
        <form noValidate onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-amount`}>{m.amount}</Label>
            <Input
              id={`${base}-amount`}
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              aria-invalid={errors["amount"] ? true : undefined}
              onChange={(event) => setAmount(event.target.value)}
            />
            {errors["amount"] ? (
              <p role="alert" className="text-label text-tone-problem-fg">
                {errors["amount"]}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-reference`}>{m.reference}</Label>
            <Input
              id={`${base}-reference`}
              autoComplete="off"
              maxLength={100}
              value={reference}
              aria-invalid={errors["reference"] ? true : undefined}
              onChange={(event) => setReference(event.target.value)}
            />
            {errors["reference"] ? (
              <p role="alert" className="text-label text-tone-problem-fg">
                {errors["reference"]}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-date`}>{m.date}</Label>
            <Input
              id={`${base}-date`}
              placeholder="AAAA-LL-ZZ"
              autoComplete="off"
              maxLength={10}
              value={date}
              aria-invalid={errors["date"] ? true : undefined}
              onChange={(event) => setDate(event.target.value)}
            />
            {errors["date"] ? (
              <p role="alert" className="text-label text-tone-problem-fg">
                {errors["date"]}
              </p>
            ) : null}
          </div>
          {differs ? (
            <div className="flex flex-col gap-1">
              <label className="flex min-h-11 items-center gap-2 text-body md:min-h-0">
                <input
                  type="checkbox"
                  className="size-4 accent-brand"
                  checked={accept}
                  onChange={(event) => setAccept(event.target.checked)}
                />
                {m.acceptDifference}
              </label>
              <span className="text-label text-ink-secondary">{m.differenceHelp}</span>
            </div>
          ) : null}
          {problem ? (
            <p
              role="alert"
              className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
            >
              {problem}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(null)}>
              {m.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? m.submitting : m.submit}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
