"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Badge, Button, Dialog, Input, Textarea } from "@ecom/ui";
import {
  extendEntitlementAction,
  refundDigitalLineAction,
  resetDownloadsAction,
  restoreEntitlementAction,
  revokeEntitlementAction,
} from "@/app/(admin)/admin/comenzi/digital-actions";
import { getMessages } from "@/messages";

const m = getMessages().digitalAdmin;
const t = m.order;

export interface DigitalPanelItem {
  id: string;
  productTitle: string;
  grantReason: "payment" | "delivery" | "admin";
  grantedText: string;
  downloadCount: number;
  maxDownloads: number | null;
  revoked: boolean;
  revokedReason: string | null;
  lastAccessText: string | null;
  /** Totalul liniei, formatat (pentru dialogul de rambursare). */
  lineTotalText: string;
  log: Array<{
    id: string;
    whenText: string;
    action: "view" | "download";
    module: string | null;
    ip: string | null;
  }>;
}

type Kind = "reset" | "extend" | "revoke" | "restore" | "refund";

const errorText = (code: unknown): string =>
  (typeof code === "string" && m.errors[code]) || (m.errors["failed"] ?? "");

/**
 * Panoul «Acces digital» din detaliul comenzii (Faza 14b, `docs/17`): drepturile de acces ale liniilor digitale, contorul de
 * descărcări, jurnalul de accesări și acțiunile adminului (resetare, prelungire, retragere, restabilire, rambursarea liniei), fiecare
 * cu motiv obligatoriu într-un dialog propriu (fără widget-uri native). Serverul reverifică orice permisiune; aici controalele fără
 * permisiune doar lipsesc. IP-ul din jurnal e vizibil doar cu `digital.view`, pe server; cheia de stocare nu apare aici.
 */
export function DigitalPanel({
  items,
  awaiting,
  canManage,
  canRefund,
}: {
  items: readonly DigitalPanelItem[];
  /** Comanda are linii digitale încă fără acces acordat (în așteptarea plății sau a livrării). */
  awaiting: boolean;
  canManage: boolean;
  canRefund: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [active, setActive] = useState<{ kind: Kind; item: DigitalPanelItem } | null>(null);
  const [reason, setReason] = useState("");
  const [addDownloads, setAddDownloads] = useState("5");
  const [unlimited, setUnlimited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function open(kind: Kind, item: DigitalPanelItem) {
    setActive({ kind, item });
    setReason("");
    setError(null);
    setStatus(null);
    setAddDownloads("5");
    setUnlimited(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!active) return;
    const base = { entitlementId: active.item.id, reason };
    setBusy(true);
    setError(null);
    try {
      let result: { ok: boolean; code?: string };
      if (active.kind === "reset") result = await resetDownloadsAction(base);
      else if (active.kind === "revoke") result = await revokeEntitlementAction(base);
      else if (active.kind === "restore") result = await restoreEntitlementAction(base);
      else if (active.kind === "refund") result = await refundDigitalLineAction(base);
      else {
        const add = Number(addDownloads);
        if (!unlimited && (!Number.isInteger(add) || add < 1 || add > 10_000)) {
          setError(errorText("DIGITAL_INPUT_INVALID"));
          return;
        }
        result = await extendEntitlementAction(
          unlimited ? { ...base, unlimited: true } : { ...base, addDownloads: add },
        );
      }
      if (result.ok) {
        setActive(null);
        setStatus(t.done);
        startTransition(() => router.refresh());
      } else {
        setError(errorText((result as { code?: string }).code));
      }
    } catch {
      setError(errorText("failed"));
    } finally {
      setBusy(false);
    }
  }

  const titleOf = (kind: Kind): string =>
    ({
      reset: t.resetTitle,
      extend: t.extendTitle,
      revoke: t.revokeTitle,
      restore: t.restoreTitle,
      refund: t.refundTitle,
    })[kind];

  return (
    <div className="flex flex-col gap-4" data-digital-panel>
      {awaiting ? (
        <p role="note" className="rounded-lg bg-surface-subtle p-3 text-ink-secondary">
          {t.pending}
        </p>
      ) : null}
      {status ? (
        <p aria-live="polite" className="text-tone-success-fg">
          {status}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="text-ink-secondary">{t.empty}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line-subtle">
          {items.map((item) => (
            <li key={item.id} className="flex flex-col gap-3 py-4" data-digital-entitlement>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{item.productTitle}</span>
                <Badge variant={item.revoked ? "danger" : "success"}>
                  {item.revoked ? t.revoked : t.active}
                </Badge>
              </div>
              <p className="text-label text-ink-secondary">
                {t.granted}: {item.grantedText} ({t.grantedBy[item.grantReason]}) ·{" "}
                {t.downloads(item.downloadCount, item.maxDownloads)} ·{" "}
                {item.lastAccessText ? t.lastAccess(item.lastAccessText) : t.never}
              </p>
              {item.revoked && item.revokedReason ? (
                <p className="text-label text-tone-problem-fg">
                  {t.revokedReason(item.revokedReason)}
                </p>
              ) : null}
              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => open("reset", item)}
                  >
                    {t.reset}
                  </Button>
                  {item.maxDownloads !== null ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => open("extend", item)}
                    >
                      {t.extend}
                    </Button>
                  ) : null}
                  {item.revoked ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => open("restore", item)}
                    >
                      {t.restore}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => open("revoke", item)}
                    >
                      {t.revoke}
                    </Button>
                  )}
                  {canRefund && !item.revoked ? (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => open("refund", item)}
                    >
                      {t.refund}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <details className="text-label">
                <summary className="cursor-pointer text-ink-secondary">{t.log}</summary>
                {item.log.length === 0 ? (
                  <p className="mt-2 text-ink-secondary">{t.logEmpty}</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-1" data-digital-log>
                    {item.log.map((entry) => (
                      <li key={entry.id} className="text-ink-secondary">
                        {entry.whenText} · {t.logAction[entry.action]}
                        {entry.module ? ` · ${entry.module}` : ""}
                        {entry.ip ? ` · ${entry.ip}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={active !== null}
        onClose={() => setActive(null)}
        title={active ? titleOf(active.kind) : ""}
        description={
          active
            ? active.kind === "refund"
              ? t.refundText(active.item.lineTotalText)
              : active.item.productTitle
            : ""
        }
        closeLabel={t.cancel}
      >
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          {active?.kind === "extend" ? (
            <div className="flex flex-col gap-2">
              <label htmlFor="dg-add" className="text-label font-medium">
                {t.addDownloads}
              </label>
              <Input
                id="dg-add"
                inputMode="numeric"
                value={addDownloads}
                disabled={unlimited}
                onChange={(event) => setAddDownloads(event.target.value)}
              />
              <label className="flex items-center gap-2 text-label">
                <input
                  type="checkbox"
                  checked={unlimited}
                  onChange={(event) => setUnlimited(event.target.checked)}
                  className="size-4 accent-brand"
                />
                {t.unlimited}
              </label>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="dg-reason" className="text-label font-medium">
              {t.reason}
            </label>
            <Textarea
              id="dg-reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              aria-describedby="dg-reason-help"
              aria-invalid={error ? true : undefined}
            />
            <p id="dg-reason-help" className="text-label text-ink-secondary">
              {t.reasonHelp}
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-tone-problem-fg">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setActive(null)}>
              {t.cancel}
            </Button>
            <Button
              type="submit"
              variant={active?.kind === "refund" ? "destructive" : "default"}
              disabled={busy}
            >
              {t.confirm}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
