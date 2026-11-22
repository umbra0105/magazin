"use client";

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { Badge, Button, TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
import { createBulkShipmentsAction } from "@/app/(admin)/admin/comenzi/expediere-actions";
import { getMessages } from "@/messages";

const m = getMessages().admin.shipping.bulk;
const errors = getMessages().admin.shipping.panel.errors;

export interface BulkRowDto {
  orderId: string;
  number: string;
  placedText: string;
  destination: string;
  paymentText: string;
  totalText: string;
  /** Plata la livrare (ramburs): AWB-ul va transmite rambursul curierului. */
  cod: boolean;
}

interface Outcome {
  ok: boolean;
  code: string | null;
  awb: string | null;
}

/**
 * Expedierea în masă: comenzile gata de expediat, selecție și AWB prin curierul activ (cel mult 50 o dată), cu rezultatul pe
 * fiecare comandă. Fiecare comandă se procesează independent: o eroare (curier, adresă) nu le oprește pe celelalte.
 */
export function BulkShipments({
  rows,
  carrierLabel,
  canFulfill,
}: {
  rows: BulkRowDto[];
  /** Curierul activ, sau `null` (fără curier nu se pot crea AWB-uri în masă). */
  carrierLabel: string | null;
  canFulfill: boolean;
}) {
  const base = useId();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, Outcome>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const enabled = canFulfill && carrierLabel !== null;
  const toggle = (orderId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else if (next.size < 50) next.add(orderId);
      return next;
    });
  const allSelected =
    rows.length > 0 && rows.slice(0, 50).every((row) => selected.has(row.orderId));

  const submit = () => {
    if (!enabled || pending || selected.size === 0) return;
    setProblem(null);
    setSummary(null);
    start(async () => {
      const result = await createBulkShipmentsAction({ orderIds: [...selected] });
      if (!result.ok) {
        setProblem(errors[result.code] ?? errors["failed"] ?? "");
        return;
      }
      const next: Record<string, Outcome> = {};
      for (const outcome of result.outcomes) {
        next[outcome.orderId] = { ok: outcome.ok, code: outcome.code, awb: outcome.awb };
      }
      setResults(next);
      const ok = result.outcomes.filter((outcome) => outcome.ok).length;
      setSummary(m.done(ok, result.outcomes.length - ok));
      // lista nu se reîncarcă: rândurile rămân pe ecran cu rezultatul lor (la următoarea deschidere dispar comenzile expediate)
      setSelected(new Set());
    });
  };

  if (rows.length === 0) {
    return (
      <p className="text-body text-ink-secondary" data-bulk-empty>
        {m.empty}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-bulk-shipments>
      {carrierLabel === null ? (
        <p role="note" className="rounded-lg bg-tone-warning-bg p-3 text-body text-tone-warning-fg">
          {m.noCarrier}
        </p>
      ) : null}
      <p className="text-body text-ink-secondary">{m.palletOnly}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={!enabled || pending || selected.size === 0}
          onClick={submit}
        >
          {pending ? m.working : m.create}
        </Button>
        <span className="text-body text-ink-secondary" aria-live="polite">
          {m.selected(selected.size)} · {m.limit}
        </span>
      </div>
      <Table stacked aria-label={m.title}>
        <THead>
          <Tr>
            <Th priority="primary">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-brand"
                  checked={allSelected}
                  disabled={!enabled}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? new Set(rows.slice(0, 50).map((row) => row.orderId))
                        : new Set(),
                    )
                  }
                  aria-label={m.selectAll}
                />
                {m.colOrder}
              </label>
            </Th>
            <Th priority="secondary">{m.colPlaced}</Th>
            <Th priority="secondary">{m.colDestination}</Th>
            <Th priority="secondary">{m.colPayment}</Th>
            <Th priority="secondary" numeric>
              {m.colTotal}
            </Th>
            <Th priority="primary">{m.colResult}</Th>
          </Tr>
        </THead>
        <TBody>
          {rows.map((row) => {
            const outcome = results[row.orderId];
            return (
              <Tr key={row.orderId} data-bulk-row={row.orderId}>
                <Td>
                  <label className="flex items-center gap-2">
                    <input
                      id={`${base}-${row.orderId}`}
                      type="checkbox"
                      className="size-4 accent-brand"
                      checked={selected.has(row.orderId)}
                      disabled={!enabled}
                      onChange={() => toggle(row.orderId)}
                    />
                    <Link
                      href={`/admin/comenzi/${encodeURIComponent(row.orderId)}`}
                      className="text-link underline-offset-2 hover:underline"
                    >
                      {row.number}
                    </Link>
                  </label>
                </Td>
                <Td>{row.placedText}</Td>
                <Td>{row.destination}</Td>
                <Td>
                  {row.cod ? (
                    <Badge variant="warning">{m.cod}</Badge>
                  ) : (
                    <Badge variant="success">{m.paid}</Badge>
                  )}{" "}
                  {row.paymentText}
                </Td>
                <Td numeric>{row.totalText}</Td>
                <Td>
                  {outcome ? (
                    outcome.ok ? (
                      <span className="text-tone-success-fg">{m.ok(outcome.awb ?? "")}</span>
                    ) : (
                      <span role="alert" className="text-tone-problem-fg">
                        {m.failed}: {errors[outcome.code ?? "failed"] ?? errors["failed"]}
                      </span>
                    )
                  ) : null}
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
      <span role="status" aria-live="polite" className="text-body text-ink-secondary">
        {summary}
      </span>
      {problem ? (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {problem}
        </p>
      ) : null}
    </div>
  );
}
