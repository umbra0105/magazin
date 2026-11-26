"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button, Dialog, Input, Label, Select, Textarea } from "@ecom/ui";
import {
  approveReturnAction,
  awaitShipmentAction,
  inspectReturnAction,
  noteReturnAction,
  receiveReturnAction,
  refundReturnAction,
  rejectReturnAction,
  restockReturnAction,
  setReturnAwbAction,
} from "@/app/(admin)/admin/comenzi/retururi/actions";
import { getMessages } from "@/messages";

const m = getMessages().admin.returns;
const a = m.actions;

export interface InspectItemDto {
  id: string;
  title: string;
  unitSymbol: string;
  requestedQty: string;
  acceptedQty: string | null;
  condition: string | null;
  resellable: boolean | null;
}

export interface ReturnActionsProps {
  returnId: string;
  status: string;
  sendMode: string;
  canRefund: boolean;
  hasAwb: boolean;
  awbCarrier: string;
  awbNumber: string;
  awbUrl: string;
  adminNote: string;
  items: InspectItemDto[];
  /** Transportul plătit la comandă, formatat ca text de câmp (ex. «35,00»), ca limită a transportului rambursat. */
  orderShippingText: string;
  refundPending: boolean;
  anyRestockable: boolean;
}

type Pending =
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "receive" }
  | { kind: "refund" }
  | { kind: "restock" }
  | null;

/**
 * Acțiunile adminului pe un retur, în funcție de stare (Faza 14): aprobare, respingere (cu motiv vizibil clientului), AWB manual,
 * recepție, inspecție pe linie, rambursare (doar produsele; transportul doar manual, cu motiv), repunere pe stoc. Acțiunile cu efect
 * trec printr-un dialog propriu de confirmare. Mesajele de eroare vin din coduri stabile; permisiunile se verifică din nou pe server.
 */
export function ReturnActions(props: ReturnActionsProps) {
  const router = useRouter();
  const base = useId();
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState(props.adminNote);
  const [approveNote, setApproveNote] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [carrier, setCarrier] = useState(props.awbCarrier);
  const [awb, setAwb] = useState(props.awbNumber);
  const [trackingUrl, setTrackingUrl] = useState(props.awbUrl);
  const [shipping, setShipping] = useState("");
  const [shippingReason, setShippingReason] = useState("");
  const [lines, setLines] = useState(() =>
    props.items.map((i) => ({
      returnItemId: i.id,
      acceptedQuantity: i.acceptedQty ?? i.requestedQty,
      condition: i.condition ?? "as_new",
      resellable: i.resellable ?? true,
    })),
  );

  const fail = (code: string) => setProblem(m.errors[code] ?? m.errors["failed"] ?? "");

  type Outcome = ({ ok: true } & Record<string, unknown>) | { ok: false; code: string };
  async function run(
    action: () => Promise<Outcome>,
    onOk?: (result: Record<string, unknown>) => void,
  ) {
    setBusy(true);
    setProblem(null);
    setMessage(null);
    try {
      const result = await action();
      if (result.ok) {
        if (onOk) onOk(result);
        else setMessage(a.done);
        router.refresh();
      } else {
        fail(result.code);
      }
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const id = props.returnId;
  const s = props.status;

  async function confirm() {
    if (!pending) return;
    if (pending.kind === "approve")
      await run(() =>
        approveReturnAction({ returnId: id, ...(approveNote.trim() ? { note: approveNote } : {}) }),
      );
    if (pending.kind === "reject")
      await run(() => rejectReturnAction({ returnId: id, reason: rejectReason }));
    if (pending.kind === "receive") await run(() => receiveReturnAction({ returnId: id }));
    if (pending.kind === "refund") {
      await run(
        () =>
          refundReturnAction({
            returnId: id,
            ...(shipping.trim() ? { shipping, shippingReason } : {}),
          }),
        // 0 lei = produse plătite integral cu puncte: returul se închide fără rambursare de bani
        (r) =>
          setMessage(
            Number(r["amountMinor"]) === 0
              ? a.refundPointsOnly
              : a.refundDone(String(Number(r["amountMinor"]) / 100)),
          ),
      );
    }
    if (pending.kind === "restock") {
      await run(
        () => restockReturnAction({ returnId: id }),
        (r) => {
          const res = (r as unknown as { result: { restocked: number; notManaged: number } })
            .result;
          setMessage(a.restocked(res.restocked, res.notManaged));
        },
      );
    }
  }

  return (
    <div className="flex flex-col gap-6" data-return-actions>
      {s === "requested" ? (
        <section className="flex flex-col gap-3" aria-label={a.approve}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-approve-note`}>{a.approveNote}</Label>
            <Textarea
              id={`${base}-approve-note`}
              maxLength={1000}
              value={approveNote}
              onChange={(e) => setApproveNote(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              onClick={() => setPending({ kind: "approve" })}
              disabled={busy}
              data-return-approve
            >
              {a.approve}
            </Button>
          </div>
        </section>
      ) : null}

      {s === "requested" || s === "inspected" ? (
        <section className="flex flex-col gap-3" aria-label={a.reject}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-reject`}>{a.rejectReason}</Label>
            <Textarea
              id={`${base}-reject`}
              maxLength={500}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              data-return-reject
              onClick={() => {
                if (rejectReason.trim().length < 3) {
                  setProblem(m.errors["RETURN_INPUT_INVALID"] ?? "");
                  document.getElementById(`${base}-reject`)?.focus();
                  return;
                }
                setPending({ kind: "reject" });
              }}
            >
              {a.reject}
            </Button>
          </div>
        </section>
      ) : null}

      {s === "approved" || s === "awaiting_shipment" ? (
        <section className="flex flex-col gap-3" aria-label={m.detail.awb}>
          <h3 className="text-heading font-semibold">{m.detail.awb}</h3>
          <form
            noValidate
            className="grid max-w-xl gap-3"
            data-return-awb-form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() =>
                setReturnAwbAction({
                  returnId: id,
                  carrier,
                  awb,
                  ...(trackingUrl.trim() ? { trackingUrl } : {}),
                }),
              );
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${base}-carrier`}>{a.carrier}</Label>
              <Input
                id={`${base}-carrier`}
                value={carrier}
                maxLength={80}
                onChange={(e) => setCarrier(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${base}-awb`}>{a.awbNumber}</Label>
              <Input
                id={`${base}-awb`}
                value={awb}
                maxLength={60}
                onChange={(e) => setAwb(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${base}-url`}>{a.trackingUrl}</Label>
              <Input
                id={`${base}-url`}
                value={trackingUrl}
                maxLength={300}
                onChange={(e) => setTrackingUrl(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={busy} data-return-awb-save>
                {a.saveAwb}
              </Button>
              {s === "approved" && props.sendMode === "drop_off" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(() => awaitShipmentAction({ returnId: id }))}
                >
                  {a.awaitDropOff}
                </Button>
              ) : null}
            </div>
          </form>
        </section>
      ) : null}

      {s === "awaiting_shipment" ? (
        <div>
          <Button
            type="button"
            disabled={busy}
            onClick={() => setPending({ kind: "receive" })}
            data-return-receive
          >
            {a.received}
          </Button>
        </div>
      ) : null}

      {s === "received" ? (
        <section className="flex flex-col gap-3" aria-label={a.inspectTitle}>
          <h3 className="text-heading font-semibold">{a.inspectTitle}</h3>
          <ul className="flex flex-col gap-4">
            {props.items.map((item, index) => {
              const row = lines[index];
              if (!row) return null;
              const set = (patch: Partial<typeof row>) =>
                setLines((prev) => prev.map((x, i) => (i === index ? { ...x, ...patch } : x)));
              return (
                <li
                  key={item.id}
                  className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-4"
                  data-inspect-line
                >
                  <p className="sm:col-span-4 font-medium">
                    {item.title} · {m.detail.colRequested}: {item.requestedQty} {item.unitSymbol}
                  </p>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${base}-qty-${item.id}`}>{a.acceptedQty}</Label>
                    <Input
                      id={`${base}-qty-${item.id}`}
                      value={row.acceptedQuantity}
                      onChange={(e) => set({ acceptedQuantity: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${base}-cond-${item.id}`}>{a.condition}</Label>
                    <Select
                      id={`${base}-cond-${item.id}`}
                      value={row.condition}
                      onChange={(e) => set({ condition: e.target.value })}
                    >
                      {Object.entries(m.conditions).map(([code, label]) => (
                        <option key={code} value={code}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <label className="flex items-center gap-2 sm:col-span-2">
                    <input
                      type="checkbox"
                      checked={row.resellable}
                      onChange={(e) => set({ resellable: e.target.checked })}
                    />
                    {a.resellable}
                  </label>
                </li>
              );
            })}
          </ul>
          <div>
            <Button
              type="button"
              disabled={busy}
              data-return-inspect
              onClick={() => void run(() => inspectReturnAction({ returnId: id, lines }))}
            >
              {a.saveInspection}
            </Button>
          </div>
        </section>
      ) : null}

      {s === "inspected" && props.canRefund ? (
        <section className="flex flex-col gap-3" aria-label={a.refundTitle}>
          <h3 className="text-heading font-semibold">{a.refundTitle}</h3>
          <p className="max-w-prose text-body text-ink-secondary">{a.refundHint}</p>
          <div className="grid max-w-xl gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${base}-ship`}>
                {a.refundShipping} (max. {props.orderShippingText})
              </Label>
              <Input
                id={`${base}-ship`}
                inputMode="decimal"
                value={shipping}
                onChange={(e) => setShipping(e.target.value)}
              />
              <p className="text-label text-ink-secondary">{a.refundShippingHelp}</p>
            </div>
            {shipping.trim() ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${base}-ship-reason`}>{a.refundShippingReason}</Label>
                <Input
                  id={`${base}-ship-reason`}
                  maxLength={300}
                  value={shippingReason}
                  onChange={(e) => setShippingReason(e.target.value)}
                />
              </div>
            ) : null}
          </div>
          <div>
            <Button
              type="button"
              disabled={busy || props.refundPending}
              onClick={() => setPending({ kind: "refund" })}
              data-return-refund
            >
              {a.refundButton}
            </Button>
          </div>
        </section>
      ) : null}

      {(s === "inspected" || s === "refunded") && props.anyRestockable ? (
        <section className="flex flex-col gap-2" aria-label={a.restock}>
          <p className="max-w-prose text-body text-ink-secondary">{a.restockHint}</p>
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setPending({ kind: "restock" })}
              data-return-restock
            >
              {a.restock}
            </Button>
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2" aria-label={m.detail.adminNote}>
        <Label htmlFor={`${base}-note`}>{m.detail.adminNote}</Label>
        <Textarea
          id={`${base}-note`}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="text-label text-ink-secondary">{m.detail.adminNoteHelp}</p>
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => noteReturnAction({ returnId: id, note }))}
          >
            {m.detail.saveNote}
          </Button>
        </div>
      </section>

      <p
        role="status"
        aria-live="polite"
        className="min-h-6 text-body text-ink-secondary"
        data-return-message
      >
        {message}
      </p>
      {problem ? (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
          data-return-problem
        >
          {problem}
        </p>
      ) : null}

      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={a.confirmTitle}
        closeLabel={a.close}
        className="max-w-lg"
      >
        <div className="flex flex-wrap justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => setPending(null)}>
            {a.confirmNo}
          </Button>
          <Button type="button" disabled={busy} onClick={() => void confirm()} data-return-confirm>
            {busy ? a.working : a.confirmYes}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
