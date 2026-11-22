"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Badge, Button, Dialog, Label, Select } from "@ecom/ui";
import {
  issueInvoiceAction,
  retryInvoiceAction,
  reverseInvoiceAction,
  setEfacturaStatusAction,
} from "@/app/(admin)/admin/comenzi/factura-actions";
import { getMessages } from "@/messages";

const m = getMessages().admin.invoicing;

export interface InvoiceLineDto {
  position: number;
  title: string;
  kind: string;
  quantityText: string;
  unitName: string;
  totalText: string;
  taxText: string;
}

export interface InvoiceDocDto {
  id: string;
  orderId: string;
  kind: "proforma" | "invoice" | "storno";
  docKey: string;
  status: string;
  /** «SERIE NUMĂR» sau `null` cât documentul nu e emis. */
  reference: string | null;
  simulated: boolean;
  efacturaStatus: string;
  totalText: string;
  taxText: string;
  useStock: boolean;
  attempts: number;
  /** Text deja formatat (data din fusul magazinului). */
  whenText: string;
  nextAttemptText: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  /** Rezultatul emiterii e nesigur: reîncercarea cere confirmarea adminului. */
  uncertain: boolean;
  events: Array<{ id: string; type: string; message: string; whenText: string }>;
  lines: InvoiceLineDto[];
}

const STATUS_BADGE: Record<string, "success" | "danger" | "info" | "neutral"> = {
  issued: "success",
  failed: "danger",
  queued: "info",
  issuing: "info",
  skipped: "neutral",
};

export function kindLabel(doc: Pick<InvoiceDocDto, "kind" | "docKey">): string {
  return doc.kind === "storno" && doc.docKey === "storno:proforma"
    ? m.documents.stornoProforma
    : (m.documents.kinds[doc.kind] ?? doc.kind);
}

/** Butonul «Reîncearcă» cu dialog: la un rezultat nesigur cere confirmarea că documentul nu există la furnizor. */
export function RetryButton({ doc, canWrite }: { doc: InvoiceDocDto; canWrite: boolean }) {
  const router = useRouter();
  const base = useId();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (doc.status !== "failed" || !canWrite) return null;
  const run = () => {
    if (pending) return;
    if (doc.uncertain && !confirmed) {
      setProblem(m.documents.errors["INVOICE_OUTCOME_UNKNOWN"] ?? null);
      document.getElementById(`${base}-confirm`)?.focus();
      return;
    }
    setProblem(null);
    start(async () => {
      const result = await retryInvoiceAction({ invoiceId: doc.id, confirmNotIssued: confirmed });
      if (result.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setProblem(m.documents.errors[result.code] ?? m.documents.errors["failed"] ?? null);
      }
    });
  };
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)} data-invoice-retry>
        {m.documents.retry}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={m.documents.retryConfirmTitle}
        description={doc.uncertain ? m.documents.retryUncertain : undefined}
        closeLabel={m.documents.cancel}
        className="max-w-lg"
      >
        <div className="flex flex-col gap-4">
          {doc.uncertain ? (
            <label className="flex items-start gap-2 text-body">
              <input
                id={`${base}-confirm`}
                type="checkbox"
                className="mt-1 size-4 accent-brand"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {m.documents.retryConfirmed}
            </label>
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
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {m.documents.cancel}
            </Button>
            <Button type="button" onClick={run} disabled={pending}>
              {pending ? m.documents.retrying : m.documents.retryConfirm}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/** Starea unui document: etichetă, marcajul «SIMULAT», încercări, următoarea încercare, ultima eroare (fără date personale). */
export function StatusBadges({ doc }: { doc: InvoiceDocDto }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={STATUS_BADGE[doc.status] ?? "neutral"} dot>
        {m.documents.statuses[doc.status] ?? doc.status}
      </Badge>
      {doc.simulated ? (
        <Badge variant="warning" data-simulated>
          {m.documents.simulated}
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * Panoul «Facturare» din detaliul comenzii: documentele (proformă, factură, storno), cu starea, jurnalul și liniile lor; «Emite
 * factura acum», «Stornează factura», «Reîncearcă» și marcarea manuală a stării e-Factura (SmartBill nu o expune prin API).
 */
export function InvoicePanel({
  orderId,
  docs,
  canWrite,
  providerOn,
  canIssue,
  canReverse,
}: {
  orderId: string;
  docs: InvoiceDocDto[];
  canWrite: boolean;
  providerOn: boolean;
  canIssue: boolean;
  canReverse: boolean;
}) {
  const router = useRouter();
  const base = useId();
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [pending, start] = useTransition();
  const [efactura, setEfactura] = useState<Record<string, string>>({});

  const act = (fn: () => Promise<{ ok: true } | { ok: false; code: string }>, done: string) => {
    if (pending) return;
    setStatus(null);
    setProblem(null);
    start(async () => {
      const result = await fn();
      if (result.ok) {
        setStatus(done);
        setReverseOpen(false);
        router.refresh();
      } else {
        setProblem(m.documents.errors[result.code] ?? m.documents.errors["failed"] ?? null);
        setReverseOpen(false);
      }
    });
  };

  const hasInvoice = docs.some((d) => d.kind === "invoice" && d.status !== "skipped");

  return (
    <div className="flex flex-col gap-4" data-invoice-panel>
      <p className="text-body text-ink-secondary">{m.panel.description}</p>
      {docs.length === 0 ? (
        <p className="text-body text-ink-secondary" data-invoice-none>
          {providerOn ? m.panel.none : m.panel.noneProviderOff}
        </p>
      ) : null}
      {docs.map((doc) => (
        <article
          key={doc.id}
          className="flex flex-col gap-3 rounded-lg bg-surface-subtle p-4"
          data-invoice-doc={doc.kind}
          data-invoice-status={doc.status}
        >
          <header className="flex flex-wrap items-center gap-3">
            <h3 className="text-heading">
              {kindLabel(doc)}
              {doc.reference ? ` ${doc.reference}` : ""}
            </h3>
            <StatusBadges doc={doc} />
            <span className="text-label text-ink-secondary">{doc.whenText}</span>
          </header>
          <p className="text-body">
            {m.panel.totalLine}: <strong>{doc.totalText}</strong> · {m.panel.taxLine} {doc.taxText}
            {doc.kind === "invoice" ? (
              <span className="text-ink-secondary">
                {" "}
                · {doc.useStock ? m.documents.stock.yes : m.documents.stock.no}
              </span>
            ) : null}
          </p>
          {doc.kind !== "proforma" && doc.status === "issued" ? (
            <p className="text-body" data-efactura>
              {m.panel.efacturaTitle}:{" "}
              {m.documents.efactura[doc.efacturaStatus] ?? doc.efacturaStatus}
            </p>
          ) : null}
          {doc.status === "queued" && doc.nextAttemptText ? (
            <p className="text-label text-ink-secondary">
              {m.documents.attempts(doc.attempts)} · {m.documents.nextAttempt(doc.nextAttemptText)}
            </p>
          ) : null}
          {doc.lastError ? (
            <p
              role="note"
              className="rounded-lg bg-tone-warning-bg p-3 text-body text-tone-warning-fg"
              data-invoice-error
            >
              {doc.lastError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            {doc.status === "issued" ? (
              <Link
                href={`/api/admin/facturi/${doc.id}/pdf`}
                target="_blank"
                rel="noopener"
                className="text-body underline"
              >
                {m.documents.pdf}
              </Link>
            ) : null}
            <RetryButton doc={doc} canWrite={canWrite} />
          </div>
          {canWrite && doc.kind !== "proforma" && doc.status === "issued" ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-label text-ink-secondary">{m.panel.efacturaHelp}</p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${base}-${doc.id}-efactura`}>{m.panel.efacturaMark}</Label>
                  <Select
                    id={`${base}-${doc.id}-efactura`}
                    value={efactura[doc.id] ?? doc.efacturaStatus}
                    onChange={(event) => setEfactura({ ...efactura, [doc.id]: event.target.value })}
                  >
                    {["unknown", "pending", "sent", "validated", "error"].map((value) => (
                      <option key={value} value={value}>
                        {m.documents.efactura[value]}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    act(
                      () =>
                        setEfacturaStatusAction({
                          invoiceId: doc.id,
                          orderId,
                          status: (efactura[doc.id] ?? doc.efacturaStatus) as never,
                        }),
                      m.panel.efacturaSaved,
                    )
                  }
                >
                  {m.panel.efacturaSave}
                </Button>
              </div>
            </div>
          ) : null}
          {doc.lines.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-body">{m.panel.lines}</summary>
              <ul className="mt-2 flex flex-col gap-1 text-body">
                {doc.lines.map((line) => (
                  <li key={line.position} className="flex flex-wrap justify-between gap-2">
                    <span>
                      {line.title} · {line.quantityText} {line.unitName}
                    </span>
                    <span>
                      {line.totalText} ({m.panel.colTax} {line.taxText})
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <details>
            <summary className="cursor-pointer text-body">{m.panel.journal}</summary>
            <ol className="mt-2 flex flex-col gap-1 text-label text-ink-secondary">
              {doc.events.map((event) => (
                <li key={event.id}>
                  {event.whenText} · {event.message}
                </li>
              ))}
            </ol>
          </details>
        </article>
      ))}

      {canWrite ? (
        <div className="flex flex-wrap items-center gap-3">
          {canIssue && !hasInvoice ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => act(() => issueInvoiceAction({ orderId }), m.panel.issueDone)}
            >
              {pending ? m.panel.issuing : m.panel.issue}
            </Button>
          ) : null}
          {canReverse ? (
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => setReverseOpen(true)}
            >
              {m.panel.reverse}
            </Button>
          ) : null}
          <span role="status" aria-live="polite" className="text-body text-ink-secondary">
            {status}
          </span>
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

      <Dialog
        open={reverseOpen}
        onClose={() => setReverseOpen(false)}
        title={m.panel.reverseTitle}
        description={m.panel.reverseBody}
        closeLabel={m.documents.cancel}
        className="max-w-lg"
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setReverseOpen(false)}>
            {m.documents.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => act(() => reverseInvoiceAction({ orderId }), m.panel.reverseDone)}
          >
            {m.panel.reverseConfirm}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
