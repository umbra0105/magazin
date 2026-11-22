"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
import { issueInvoiceAction } from "@/app/(admin)/admin/comenzi/factura-actions";
import { getMessages } from "@/messages";
import { RetryButton, StatusBadges, kindLabel, type InvoiceDocDto } from "./invoice-panel";

const m = getMessages().admin.invoicing;

export interface InvoiceRowDto extends InvoiceDocDto {
  orderNumber: string;
}

/** Lista documentelor fiscale: starea, e-Factura, PDF, «Reîncearcă» pe cele eșuate, legătura spre comandă. */
export function InvoiceList({ rows, canWrite }: { rows: InvoiceRowDto[]; canWrite: boolean }) {
  if (rows.length === 0) {
    return (
      <p className="text-body text-ink-secondary" data-invoices-empty>
        {m.documents.empty}
      </p>
    );
  }
  return (
    <Table stacked aria-label={m.documents.title} data-invoice-list>
      <THead>
        <Tr>
          <Th priority="primary">{m.documents.colOrder}</Th>
          <Th priority="primary">{m.documents.colDocument}</Th>
          <Th priority="secondary">{m.documents.colStatus}</Th>
          <Th priority="secondary">{m.documents.colEfactura}</Th>
          <Th priority="primary" numeric>
            {m.documents.colTotal}
          </Th>
          <Th priority="secondary">{m.documents.colWhen}</Th>
          <Th priority="secondary">{m.documents.colActions}</Th>
        </Tr>
      </THead>
      <TBody>
        {rows.map((row) => (
          <Tr key={row.id} data-invoice-row={row.status}>
            <Td priority="primary">
              <Link href={`/admin/comenzi/${row.orderId}`} className="underline">
                {row.orderNumber}
              </Link>
            </Td>
            <Td priority="primary">
              <span className="block">
                {kindLabel(row)} {row.reference ?? m.documents.noNumber}
              </span>
              {row.lastError ? (
                <span className="block text-label text-ink-secondary">{row.lastError}</span>
              ) : null}
            </Td>
            <Td priority="secondary">
              <StatusBadges doc={row} />
            </Td>
            <Td priority="secondary">
              {row.kind === "proforma" || row.status !== "issued"
                ? m.documents.efactura["not_applicable"]
                : (m.documents.efactura[row.efacturaStatus] ?? row.efacturaStatus)}
            </Td>
            <Td priority="primary" numeric>
              {row.totalText}
            </Td>
            <Td priority="secondary">{row.whenText}</Td>
            <Td priority="secondary">
              <div className="flex flex-wrap items-center gap-2">
                {row.status === "issued" ? (
                  <Link
                    href={`/api/admin/facturi/${row.id}/pdf`}
                    target="_blank"
                    rel="noopener"
                    className="underline"
                  >
                    {m.documents.pdf}
                  </Link>
                ) : null}
                <RetryButton doc={row} canWrite={canWrite} />
              </div>
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

export interface UninvoicedRowDto {
  orderId: string;
  number: string;
  placedText: string;
  method: string;
  paymentStatus: string;
  totalText: string;
  openCommitments: number;
  failedInvoiceId: string | null;
}

/** «Comenzi confirmate fără factură»: «Emite factura» pune documentul în coadă (emiterea o face workerul). */
export function UninvoicedList({
  rows,
  canWrite,
  providerOn,
}: {
  rows: UninvoicedRowDto[];
  canWrite: boolean;
  providerOn: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const issue = (orderId: string) => {
    if (pending) return;
    setStatus(null);
    setProblem(null);
    start(async () => {
      const result = await issueInvoiceAction({ orderId });
      if (result.ok) {
        setStatus(m.uninvoiced.issued);
        router.refresh();
      } else {
        setProblem(m.documents.errors[result.code] ?? m.documents.errors["failed"] ?? null);
      }
    });
  };
  if (rows.length === 0) {
    return (
      <p className="text-body text-ink-secondary" data-uninvoiced-empty>
        {m.uninvoiced.empty}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-uninvoiced-list>
      {!providerOn ? (
        <p role="note" className="rounded-lg bg-tone-warning-bg p-3 text-body text-tone-warning-fg">
          {m.documents.errors["INVOICE_NO_PROVIDER"]}
        </p>
      ) : null}
      <Table stacked aria-label={m.uninvoiced.title}>
        <THead>
          <Tr>
            <Th priority="primary">{m.uninvoiced.colOrder}</Th>
            <Th priority="secondary">{m.uninvoiced.colPlaced}</Th>
            <Th priority="secondary">{m.uninvoiced.colMethod}</Th>
            <Th priority="primary" numeric>
              {m.uninvoiced.colTotal}
            </Th>
            <Th priority="secondary" numeric>
              {m.uninvoiced.colCommitments}
            </Th>
            <Th priority="secondary">{m.uninvoiced.colActions}</Th>
          </Tr>
        </THead>
        <TBody>
          {rows.map((row) => (
            <Tr key={row.orderId} data-uninvoiced-row>
              <Td priority="primary">
                <Link href={`/admin/comenzi/${row.orderId}`} className="underline">
                  {row.number}
                </Link>
                {row.failedInvoiceId ? (
                  <span className="block text-label text-tone-problem-fg">
                    {m.uninvoiced.failed}
                  </span>
                ) : null}
              </Td>
              <Td priority="secondary">{row.placedText}</Td>
              <Td priority="secondary">{m.uninvoiced.methods[row.method] ?? row.method}</Td>
              <Td priority="primary" numeric>
                {row.totalText}
              </Td>
              <Td priority="secondary" numeric>
                {row.openCommitments}
              </Td>
              <Td priority="secondary">
                {row.failedInvoiceId ? (
                  <Link href={`/admin/comenzi/${row.orderId}#invoicing`} className="underline">
                    {m.uninvoiced.openInvoice}
                  </Link>
                ) : canWrite && providerOn ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => issue(row.orderId)}
                  >
                    {m.uninvoiced.issue}
                  </Button>
                ) : null}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      <span role="status" aria-live="polite" className="text-body text-ink-secondary">
        {status}
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
