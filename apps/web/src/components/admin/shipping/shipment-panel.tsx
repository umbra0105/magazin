"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Badge, Button, Dialog, Input, Label, buttonVariants } from "@ecom/ui";
import {
  cancelShipmentAction,
  createCarrierShipmentAction,
  createManualShipmentAction,
  createReturnShipmentAction,
  markShipmentDeliveredAction,
} from "@/app/(admin)/admin/comenzi/expediere-actions";
import { getMessages } from "@/messages";

const m = getMessages().admin.shipping.panel;

export interface ShipmentDto {
  id: string;
  kind: "outbound" | "return";
  mode: "provider" | "manual";
  provider: string | null;
  carrier: string;
  awb: string;
  trackingUrl: string | null;
  status: string;
  /** Texte deja formatate pe server (sume și date în fusul magazinului). */
  codText: string | null;
  createdText: string;
  deliveredText: string | null;
  syncedText: string | null;
  events: Array<{ label: string; whenText: string }>;
}

export interface CarrierInfoDto {
  label: string;
  demo: boolean;
  /** Adaptor încă netestat cu cont real (toți cei reali până la confirmarea utilizatorului). */
  untested: boolean;
}

const STATUS_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  created: "info",
  picked_up: "info",
  in_transit: "info",
  delivered: "success",
  returned: "warning",
  cancelled: "neutral",
};

/**
 * Expedierea din detaliul comenzii: AWB manual (transportul paletizat) sau prin curierul activ, etichete PDF/ZPL, marcare «livrată»,
 * anulare și AWB de retur. Toate acțiunile cer `orders.fulfill` și se verifică din nou pe server; aici doar se ascund butoanele.
 */
export function ShipmentPanel({
  orderId,
  shippingKind,
  canShip,
  canFulfill,
  hasActiveOutbound,
  shipments,
  carrier,
  manualCarriers,
}: {
  orderId: string;
  shippingKind: string;
  /** Comanda e confirmată și încă neexpediată. */
  canShip: boolean;
  canFulfill: boolean;
  hasActiveOutbound: boolean;
  shipments: ShipmentDto[];
  /** Curierul activ pentru AWB prin API, sau `null`. */
  carrier: CarrierInfoDto | null;
  manualCarriers: string[];
}) {
  const router = useRouter();
  const base = useId();
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [carrierName, setCarrierName] = useState("");
  const [awb, setAwb] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [returnFor, setReturnFor] = useState<ShipmentDto | null>(null);
  const [returnCarrier, setReturnCarrier] = useState("");
  const [returnAwb, setReturnAwb] = useState("");
  const [returnUrl, setReturnUrl] = useState("");

  const pickup = shippingKind === "pickup";
  const pallet = shippingKind === "pallet";

  const finish = (result: { ok: boolean; code?: string }, onOk?: () => void) => {
    if (result.ok) {
      setProblem(null);
      setStatus(m.done);
      onOk?.();
      router.refresh();
    } else {
      setStatus(null);
      setProblem(m.errors[result.code ?? "failed"] ?? m.errors["failed"] ?? "");
    }
  };

  const submitManual = (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const found: Record<string, string> = {};
    if (carrierName.trim().length < 2) found["carrier"] = m.errors["SHIPMENT_INVALID"] ?? "";
    if (awb.trim().length < 2) found["awb"] = m.errors["SHIPMENT_INVALID"] ?? "";
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      setProblem(m.errors["SHIPMENT_INVALID"] ?? null);
      document.getElementById(`${base}-${first}`)?.focus();
      return;
    }
    setProblem(null);
    setStatus(null);
    start(async () => {
      const result = await createManualShipmentAction({
        orderId,
        carrier: carrierName,
        awb,
        ...(trackingUrl.trim() ? { trackingUrl } : {}),
      });
      finish(result, () => {
        setCarrierName("");
        setAwb("");
        setTrackingUrl("");
      });
    });
  };

  const createViaCarrier = () => {
    if (pending) return;
    setProblem(null);
    setStatus(null);
    start(async () => finish(await createCarrierShipmentAction({ orderId })));
  };

  const markDelivered = (shipmentId: string) => {
    if (pending) return;
    setProblem(null);
    setStatus(null);
    start(async () => finish(await markShipmentDeliveredAction({ shipmentId, orderId })));
  };

  const confirmCancel = () => {
    if (!cancelId || pending) return;
    const shipmentId = cancelId;
    setProblem(null);
    start(async () => {
      const result = await cancelShipmentAction({ shipmentId, orderId });
      finish(result, () => setCancelId(null));
      if (!result.ok) setCancelId(null);
    });
  };

  const submitReturn = (mode: "carrier" | "manual") => {
    if (!returnFor || pending) return;
    if (mode === "manual" && (returnCarrier.trim().length < 2 || returnAwb.trim().length < 2)) {
      setProblem(m.errors["SHIPMENT_INVALID"] ?? null);
      return;
    }
    const shipmentId = returnFor.id;
    setProblem(null);
    start(async () => {
      const result = await createReturnShipmentAction({
        shipmentId,
        orderId,
        mode,
        ...(mode === "manual"
          ? {
              carrier: returnCarrier,
              awb: returnAwb,
              ...(returnUrl.trim() ? { trackingUrl: returnUrl } : {}),
            }
          : {}),
      });
      finish(result, () => {
        setReturnFor(null);
        setReturnCarrier("");
        setReturnAwb("");
        setReturnUrl("");
      });
    });
  };

  const outbound = shipments.filter((s) => s.kind === "outbound");
  const hasReturnOf = (id: string) =>
    shipments.some((s) => s.kind === "return" && s.status !== "cancelled" && s.id !== id);

  return (
    <div className="flex flex-col gap-4" data-shipment-panel>
      {pickup ? (
        <p className="text-body text-ink-secondary" data-shipment-pickup>
          {m.pickupNotice}
        </p>
      ) : null}

      {shipments.length === 0 && !pickup ? (
        <p className="text-body text-ink-secondary">{m.none}</p>
      ) : null}

      {shipments.map((s) => {
        const cancellable =
          s.status !== "cancelled" && s.status !== "delivered" && s.status !== "returned";
        const isOutbound = s.kind === "outbound";
        return (
          <article
            key={s.id}
            data-shipment={s.id}
            data-shipment-status={s.status}
            className="flex flex-col gap-3 rounded-lg bg-surface-subtle p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-heading">
                {s.kind === "return" ? `${m.returnKind}: ` : ""}
                {m.awb} {s.awb}
              </h3>
              <Badge variant={STATUS_TONE[s.status] ?? "neutral"} dot>
                {m.statuses[s.status] ?? s.status}
              </Badge>
              <Badge variant="neutral">{m.mode[s.mode] ?? s.mode}</Badge>
              {s.provider === "demo" ? <Badge variant="warning">{m.carrierDemo}</Badge> : null}
            </div>
            <dl className="grid gap-x-6 gap-y-2 text-body md:grid-cols-3">
              <div>
                <dt className="text-label text-ink-secondary">{m.carrierLabel}</dt>
                <dd>{s.carrier}</dd>
              </div>
              <div>
                <dt className="text-label text-ink-secondary">{m.created}</dt>
                <dd>{s.createdText}</dd>
              </div>
              {s.codText ? (
                <div>
                  <dt className="text-label text-ink-secondary">{m.cod}</dt>
                  <dd className="tabular-nums">{s.codText}</dd>
                </div>
              ) : null}
              {s.deliveredText ? (
                <div>
                  <dt className="text-label text-ink-secondary">{m.delivered}</dt>
                  <dd>{s.deliveredText}</dd>
                </div>
              ) : null}
            </dl>
            {s.trackingUrl ? (
              <p>
                <a
                  href={s.trackingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-body text-link underline-offset-2 hover:underline"
                >
                  {m.track}
                </a>
              </p>
            ) : null}
            {s.events.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="text-label font-medium">{m.events}</p>
                <ul className="flex flex-col gap-0.5 text-body text-ink-secondary">
                  {s.events.map((event, index) => (
                    <li key={`${event.whenText}-${index}`}>
                      {event.whenText} · {event.label}
                    </li>
                  ))}
                </ul>
                {s.syncedText ? (
                  <p className="text-label text-ink-secondary">{m.lastSynced(s.syncedText)}</p>
                ) : null}
              </div>
            ) : s.mode === "provider" ? (
              <p className="text-label text-ink-secondary">{m.noEvents}</p>
            ) : null}

            {canFulfill ? (
              <div className="flex flex-wrap items-center gap-2">
                {s.mode === "provider" && s.status !== "cancelled" ? (
                  <>
                    <a
                      className={buttonVariants({ variant: "outline" })}
                      href={`/api/admin/expedieri/${encodeURIComponent(s.id)}/eticheta?format=pdf`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {m.labelPdf}
                    </a>
                    <a
                      className={buttonVariants({ variant: "outline" })}
                      href={`/api/admin/expedieri/${encodeURIComponent(s.id)}/eticheta?format=zpl`}
                    >
                      {m.labelZpl}
                    </a>
                  </>
                ) : null}
                {isOutbound && cancellable ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => markDelivered(s.id)}
                  >
                    {m.markDelivered}
                  </Button>
                ) : null}
                {cancellable ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => setCancelId(s.id)}
                  >
                    {m.cancelAwb}
                  </Button>
                ) : null}
                {isOutbound && s.status === "delivered" && !hasReturnOf(s.id) ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => setReturnFor(s)}
                  >
                    {m.returnTitle}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}

      {canFulfill && canShip && !hasActiveOutbound && !pickup ? (
        <div className="flex flex-col gap-5">
          {pallet ? <p className="text-body text-ink-secondary">{m.palletNotice}</p> : null}
          {!pallet && carrier ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-heading">{m.carrierTitle}</h3>
              <p className="text-body text-ink-secondary">{m.carrierHelp(carrier.label)}</p>
              {carrier.demo ? (
                <p className="text-label text-tone-warning-fg">{m.carrierDemo}</p>
              ) : null}
              {carrier.untested ? (
                <p className="text-label text-tone-warning-fg">{m.carrierUntested}</p>
              ) : null}
              <div>
                <Button type="button" disabled={pending} onClick={createViaCarrier}>
                  {pending ? m.carrierWorking : m.carrierSubmit}
                </Button>
              </div>
            </div>
          ) : null}
          {!pallet && !carrier ? (
            <p className="text-body text-ink-secondary">{m.noCarrier}</p>
          ) : null}

          <form
            noValidate
            onSubmit={submitManual}
            className="flex flex-col gap-3"
            data-manual-shipment
          >
            <h3 className="text-heading">{m.manualTitle}</h3>
            <p className="text-body text-ink-secondary">{m.manualHelp}</p>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${base}-carrier`}>{m.carrierLabel}</Label>
                <Input
                  id={`${base}-carrier`}
                  value={carrierName}
                  list={manualCarriers.length > 0 ? `${base}-carriers` : undefined}
                  maxLength={80}
                  autoComplete="off"
                  aria-invalid={errors["carrier"] ? true : undefined}
                  onChange={(event) => setCarrierName(event.target.value)}
                />
                {manualCarriers.length > 0 ? (
                  <datalist id={`${base}-carriers`}>
                    {manualCarriers.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${base}-awb`}>{m.awbLabel}</Label>
                <Input
                  id={`${base}-awb`}
                  value={awb}
                  maxLength={60}
                  autoComplete="off"
                  aria-invalid={errors["awb"] ? true : undefined}
                  onChange={(event) => setAwb(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-2">
                <Label htmlFor={`${base}-url`}>{m.trackingLabel}</Label>
                <Input
                  id={`${base}-url`}
                  value={trackingUrl}
                  maxLength={300}
                  inputMode="url"
                  autoComplete="off"
                  onChange={(event) => setTrackingUrl(event.target.value)}
                />
              </div>
            </div>
            <div>
              <Button
                type="submit"
                {...(pallet ? {} : { variant: "outline" as const })}
                disabled={pending}
              >
                {pending ? m.manualWorking : m.manualSubmit}
              </Button>
            </div>
          </form>
        </div>
      ) : null}

      {!canShip && outbound.length === 0 && !pickup ? (
        <p className="text-body text-ink-secondary">{m.notShippable}</p>
      ) : null}

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

      <Dialog
        open={cancelId !== null}
        onClose={() => setCancelId(null)}
        title={m.cancelTitle}
        description={m.cancelBody}
        closeLabel={m.back}
        className="max-w-lg"
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setCancelId(null)}>
            {m.back}
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={confirmCancel}>
            {m.cancelConfirm}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={returnFor !== null}
        onClose={() => setReturnFor(null)}
        title={m.returnTitle}
        description={m.returnHelp}
        closeLabel={m.back}
        className="max-w-lg"
      >
        <div className="flex flex-col gap-3">
          {returnFor?.mode === "provider" ? (
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => submitReturn("carrier")}
              >
                {m.returnViaCarrier}
              </Button>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-rcarrier`}>{m.carrierLabel}</Label>
            <Input
              id={`${base}-rcarrier`}
              value={returnCarrier}
              maxLength={80}
              autoComplete="off"
              onChange={(event) => setReturnCarrier(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-rawb`}>{m.awbLabel}</Label>
            <Input
              id={`${base}-rawb`}
              value={returnAwb}
              maxLength={60}
              autoComplete="off"
              onChange={(event) => setReturnAwb(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-rurl`}>{m.trackingLabel}</Label>
            <Input
              id={`${base}-rurl`}
              value={returnUrl}
              maxLength={300}
              inputMode="url"
              autoComplete="off"
              onChange={(event) => setReturnUrl(event.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setReturnFor(null)}>
              {m.back}
            </Button>
            <Button type="button" disabled={pending} onClick={() => submitReturn("manual")}>
              {m.returnManual}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
