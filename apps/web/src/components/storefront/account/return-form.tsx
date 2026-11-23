"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { Dialog, StoreButton } from "@ecom/ui";
import { initiateReturnAction } from "@/app/(storefront)/cont/actions";
import { getMessages } from "@/messages";
import { FIELD, Field, TEXTAREA } from "../checkout/fields";

const m = getMessages().account.returns;
const REASONS = Object.keys(getMessages().account.returnReason);

export interface ReturnFormLine {
  orderLineId: string;
  title: string;
  variantTitle: string | null;
  unitSymbol: string;
  /** Cât se poate returna, ca text exact (ex. «2,5»). */
  returnableText: string;
  /** Pasul de vânzare, ca text (ex. «0,5»). */
  stepText: string;
}

interface Row {
  checked: boolean;
  quantity: string;
  reasonCode: string;
  reasonText: string;
}

/**
 * Formularul de inițiere a returului (Faza 14): alegerea liniilor și a cantității (cel mult cât a rămas), motiv din listă, comentariu,
 * modul de trimitere și o confirmare într-un dialog propriu (nu `window.confirm`). `noValidate`, mesaje proprii, focus pe primul câmp
 * greșit. Validarea completă e pe server; cheia de idempotență e generată o singură dată, deci dublu-click nu creează două retururi.
 */
export function ReturnForm({ orderId, lines }: { orderId: string; lines: ReturnFormLine[] }) {
  const router = useRouter();
  const base = useId();
  const clientKey = useRef<string>(crypto.randomUUID());
  const [rows, setRows] = useState<Record<string, Row>>(() =>
    Object.fromEntries(
      lines.map((l) => [
        l.orderLineId,
        { checked: false, quantity: l.returnableText, reasonCode: "", reasonText: "" },
      ]),
    ),
  );
  const [note, setNote] = useState("");
  const [sendMode, setSendMode] = useState<"courier" | "drop_off">("courier");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  const set = (id: string, patch: Partial<Row>) =>
    setRows((prev) => ({ ...prev, [id]: { ...(prev[id] as Row), ...patch } }));

  function validate(): boolean {
    const next: Record<string, string> = {};
    const selected = lines.filter((l) => rows[l.orderLineId]?.checked);
    if (selected.length === 0) {
      setFormError(m.selectOne);
      document.getElementById(`${base}-check-${lines[0]?.orderLineId}`)?.focus();
      setErrors({});
      return false;
    }
    setFormError(null);
    let firstBad: string | null = null;
    for (const l of selected) {
      const r = rows[l.orderLineId] as Row;
      if (!/^\d+([.,]\d{1,4})?$/.test(r.quantity.trim())) {
        next[`${l.orderLineId}:quantity`] = m.quantityInvalid;
        firstBad ??= `${base}-qty-${l.orderLineId}`;
      }
      if (r.reasonCode === "") {
        next[`${l.orderLineId}:reason`] = m.chooseReason;
        firstBad ??= `${base}-reason-${l.orderLineId}`;
      } else if (r.reasonCode === "other" && r.reasonText.trim() === "") {
        next[`${l.orderLineId}:reasonText`] = m.reasonTextRequired;
        firstBad ??= `${base}-text-${l.orderLineId}`;
      }
    }
    setErrors(next);
    if (firstBad) {
      document.getElementById(firstBad)?.focus();
      return false;
    }
    return true;
  }

  async function submit() {
    setPending(true);
    setFormError(null);
    try {
      const result = await initiateReturnAction({
        orderId,
        clientKey: clientKey.current,
        sendMode,
        ...(note.trim() ? { customerNote: note.trim() } : {}),
        items: lines
          .filter((l) => rows[l.orderLineId]?.checked)
          .map((l) => {
            const r = rows[l.orderLineId] as Row;
            return {
              orderLineId: l.orderLineId,
              quantity: r.quantity.trim(),
              reasonCode: r.reasonCode,
              ...(r.reasonText.trim() ? { reasonText: r.reasonText.trim() } : {}),
            };
          }),
      });
      if (result.ok) {
        router.push(`/cont/retururi/${result.returnId}`);
        router.refresh();
        return;
      }
      setConfirming(false);
      setFormError(m.errors[result.code] ?? m.errors["failed"] ?? "");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      data-return-form
      onSubmit={(event) => {
        event.preventDefault();
        if (validate()) setConfirming(true);
      }}
    >
      <ul className="flex flex-col gap-4">
        {lines.map((l) => {
          const r = rows[l.orderLineId] as Row;
          return (
            <li key={l.orderLineId} className="rounded-card bg-card p-4" data-return-line>
              <label className="flex items-start gap-3">
                <input
                  id={`${base}-check-${l.orderLineId}`}
                  type="checkbox"
                  checked={r.checked}
                  onChange={(e) => set(l.orderLineId, { checked: e.target.checked })}
                  className="mt-1 size-5 accent-[var(--brand)]"
                />
                <span>
                  <span className="block font-medium">{l.title}</span>
                  {l.variantTitle ? (
                    <span className="block text-sm text-ink-secondary">{l.variantTitle}</span>
                  ) : null}
                  <span className="block text-sm text-ink-secondary">
                    {m.returnable(l.returnableText, l.unitSymbol)}
                  </span>
                </span>
              </label>
              {r.checked ? (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <Field
                    id={`${base}-qty-${l.orderLineId}`}
                    label={`${m.quantity} (${l.unitSymbol})`}
                    error={errors[`${l.orderLineId}:quantity`]}
                  >
                    {(a) => (
                      <input
                        {...a}
                        type="text"
                        inputMode="decimal"
                        value={r.quantity}
                        onChange={(e) => set(l.orderLineId, { quantity: e.target.value })}
                        className={FIELD}
                      />
                    )}
                  </Field>
                  <Field
                    id={`${base}-reason-${l.orderLineId}`}
                    label={m.reason}
                    error={errors[`${l.orderLineId}:reason`]}
                  >
                    {(a) => (
                      <select
                        {...a}
                        value={r.reasonCode}
                        onChange={(e) => set(l.orderLineId, { reasonCode: e.target.value })}
                        className={FIELD}
                      >
                        <option value="">{m.chooseReason}</option>
                        {REASONS.map((code) => (
                          <option key={code} value={code}>
                            {getMessages().account.returnReason[code]}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <Field
                    id={`${base}-text-${l.orderLineId}`}
                    label={m.reasonText}
                    error={errors[`${l.orderLineId}:reasonText`]}
                    className="sm:col-span-2"
                  >
                    {(a) => (
                      <input
                        {...a}
                        type="text"
                        maxLength={500}
                        value={r.reasonText}
                        onChange={(e) => set(l.orderLineId, { reasonText: e.target.value })}
                        className={FIELD}
                      />
                    )}
                  </Field>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <Field id={`${base}-note`} label={m.note} help={m.noteHelp}>
        {(a) => (
          <textarea
            {...a}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={TEXTAREA}
          />
        )}
      </Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{m.sendMode}</legend>
        {(
          [
            ["courier", m.sendModeCourier],
            ["drop_off", m.sendModeDropOff],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-3">
            <input
              type="radio"
              name="sendMode"
              value={value}
              checked={sendMode === value}
              onChange={() => setSendMode(value)}
              className="size-5 accent-[var(--brand)]"
            />
            {label}
          </label>
        ))}
      </fieldset>

      <p role="alert" className="min-h-6 text-tone-problem-fg" data-return-error>
        {formError}
      </p>
      <div>
        <StoreButton type="submit" disabled={pending}>
          {pending ? m.submitting : m.submit}
        </StoreButton>
      </div>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={m.confirmTitle}
        description={m.confirmText}
        closeLabel={getMessages().account.common.close}
      >
        <div className="flex flex-wrap justify-end gap-3">
          <StoreButton type="button" variant="secondary" onClick={() => setConfirming(false)}>
            {m.confirmNo}
          </StoreButton>
          <StoreButton type="button" onClick={submit} disabled={pending} data-return-confirm>
            {m.confirmYes}
          </StoreButton>
        </div>
      </Dialog>
    </form>
  );
}
