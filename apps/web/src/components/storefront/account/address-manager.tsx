"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Dialog, StoreButton, StorePill } from "@ecom/ui";
import {
  getAccountLocalitiesAction,
  removeAddressAction,
  saveAddressAction,
  setDefaultAddressAction,
} from "@/app/(storefront)/cont/actions";
import { getMessages } from "@/messages";
import { FIELD, Field } from "../checkout/fields";

const m = getMessages().account.addresses;

export interface AddressCardData {
  id: string;
  label: string | null;
  fullName: string;
  company: string | null;
  vatId: string | null;
  vatIdVerification: string | null;
  tradeRegisterNo: string | null;
  phone: string;
  countyCode: number;
  countyName: string;
  localityCode: number;
  localityName: string;
  street: string;
  postalCode: string;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
}

interface Draft {
  id: string | null;
  label: string;
  fullName: string;
  phone: string;
  countyCode: string;
  localityCode: string;
  street: string;
  postalCode: string;
  isCompany: boolean;
  companyName: string;
  vatId: string;
  tradeRegisterNo: string;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
}

const EMPTY: Draft = {
  id: null,
  label: "",
  fullName: "",
  phone: "",
  countyCode: "",
  localityCode: "",
  street: "",
  postalCode: "",
  isCompany: false,
  companyName: "",
  vatId: "",
  tradeRegisterNo: "",
  isDefaultShipping: false,
  isDefaultBilling: false,
};

const fromCard = (a: AddressCardData): Draft => ({
  id: a.id,
  label: a.label ?? "",
  fullName: a.fullName,
  phone: a.phone,
  countyCode: String(a.countyCode),
  localityCode: String(a.localityCode),
  street: a.street,
  postalCode: a.postalCode,
  isCompany: a.company !== null,
  companyName: a.company ?? "",
  vatId: a.vatId ?? "",
  tradeRegisterNo: a.tradeRegisterNo ?? "",
  isDefaultShipping: a.isDefaultShipping,
  isDefaultBilling: a.isDefaultBilling,
});

/**
 * Agenda de adrese (Faza 14): listă, adăugare/modificare într-un dialog, ștergere cu dialog de confirmare, adresă implicită de livrare
 * și de facturare. Formularul are `noValidate` și mesaje proprii; validarea completă (SIRUTA, CUI, telefon) e pe server.
 */
export function AddressManager({
  addresses,
  counties,
}: {
  addresses: AddressCardData[];
  counties: Array<{ code: number; name: string }>;
}) {
  const router = useRouter();
  const base = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [localities, setLocalities] = useState<Array<{ code: number; label: string }>>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<AddressCardData | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadLocalities(countyCode: string) {
    if (countyCode === "") return setLocalities([]);
    const rows = await getAccountLocalitiesAction(Number(countyCode));
    setLocalities(rows ?? []);
  }

  async function open(next: Draft) {
    setErrors({});
    setFormError(null);
    setNotice(null);
    setDraft(next);
    await loadLocalities(next.countyCode);
  }

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  function validate(d: Draft): boolean {
    const next: Record<string, string> = {};
    if (d.fullName.trim().length < 2) next["fullName"] = m.errors.fullName;
    if (!/^(\+40|0040|0)\d{9}$/.test(d.phone.replace(/[\s.\-()]/g, "")))
      next["phone"] = m.errors.phone;
    if (d.countyCode === "") next["county"] = m.errors.county;
    if (d.localityCode === "") next["locality"] = m.errors.locality;
    if (d.street.trim().length < 3) next["street"] = m.errors.street;
    if (!/^\d{6}$/.test(d.postalCode.trim())) next["postalCode"] = m.errors.postalCode;
    if (d.isCompany && d.companyName.trim().length < 2) next["companyName"] = m.errors.companyName;
    if (d.isCompany && d.vatId.trim().length < 2) next["vatId"] = m.errors.vatId;
    setErrors(next);
    const order = [
      "fullName",
      "phone",
      "county",
      "locality",
      "street",
      "postalCode",
      "companyName",
      "vatId",
    ];
    const first = order.find((k) => next[k]);
    if (first) document.getElementById(`${base}-${first}`)?.focus();
    return !first;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || !validate(draft)) return;
    setPending(true);
    setFormError(null);
    try {
      const result = await saveAddressAction({
        ...(draft.id ? { id: draft.id } : {}),
        address: {
          label: draft.label.trim() || undefined,
          fullName: draft.fullName,
          phone: draft.phone,
          countyCode: Number(draft.countyCode),
          localityCode: Number(draft.localityCode),
          street: draft.street,
          postalCode: draft.postalCode,
          company: draft.isCompany
            ? {
                name: draft.companyName,
                vatId: draft.vatId,
                ...(draft.tradeRegisterNo.trim()
                  ? { tradeRegisterNo: draft.tradeRegisterNo.trim() }
                  : {}),
              }
            : null,
          isDefaultShipping: draft.isDefaultShipping,
          isDefaultBilling: draft.isDefaultBilling,
        },
      });
      if (result.ok) {
        setDraft(null);
        setNotice(m.saved);
        router.refresh();
        return;
      }
      setFormError(getMessages().account.errors[result.code] ?? m.errors.generic);
    } finally {
      setPending(false);
    }
  }

  async function makeDefault(id: string, kind: "shipping" | "billing") {
    const result = await setDefaultAddressAction({ id, kind });
    if (result.ok) router.refresh();
  }

  async function confirmRemove() {
    if (!removing) return;
    setPending(true);
    try {
      const result = await removeAddressAction({ id: removing.id });
      setRemoving(null);
      if (result.ok) {
        setNotice(m.removed);
        router.refresh();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6" data-address-book>
      <div>
        <StoreButton type="button" onClick={() => open(EMPTY)} data-address-add>
          {m.add}
        </StoreButton>
      </div>
      <p
        role="status"
        aria-live="polite"
        className="min-h-6 text-ink-secondary"
        data-address-notice
      >
        {notice}
      </p>
      {addresses.length === 0 ? (
        <p className="text-ink-secondary">{m.empty}</p>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {addresses.map((a) => (
            <li
              key={a.id}
              className="flex flex-col gap-3 rounded-card bg-card p-4"
              data-address-card
            >
              <div className="flex flex-wrap gap-2">
                {a.isDefaultShipping ? (
                  <StorePill tone="success">{m.defaultShipping}</StorePill>
                ) : null}
                {a.isDefaultBilling ? <StorePill tone="info">{m.defaultBilling}</StorePill> : null}
              </div>
              <p>
                {a.label ? <span className="block font-semibold">{a.label}</span> : null}
                {a.company ? (
                  <span className="block">
                    {a.company} ({a.vatId}){" "}
                    <span className="text-sm text-ink-secondary">
                      {a.vatIdVerification === "verified" ? m.verified : m.unverified}
                    </span>
                  </span>
                ) : (
                  <span className="block">{a.fullName}</span>
                )}
                {a.street}
                <br />
                {a.postalCode} {a.localityName}, {a.countyName}
                <br />
                {a.phone}
              </p>
              <div className="flex flex-wrap gap-2">
                <StoreButton type="button" variant="secondary" onClick={() => open(fromCard(a))}>
                  {m.edit}
                </StoreButton>
                {!a.isDefaultShipping ? (
                  <StoreButton
                    type="button"
                    variant="ghost"
                    onClick={() => makeDefault(a.id, "shipping")}
                  >
                    {m.makeDefaultShipping}
                  </StoreButton>
                ) : null}
                {!a.isDefaultBilling ? (
                  <StoreButton
                    type="button"
                    variant="ghost"
                    onClick={() => makeDefault(a.id, "billing")}
                  >
                    {m.makeDefaultBilling}
                  </StoreButton>
                ) : null}
                <StoreButton type="button" variant="ghost" onClick={() => setRemoving(a)}>
                  {m.remove}
                </StoreButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? m.edit : m.add}
        closeLabel={getMessages().account.common.close}
        className="max-w-2xl"
      >
        {draft ? (
          <form noValidate onSubmit={save} className="grid gap-4 sm:grid-cols-2" data-address-form>
            <Field
              id={`${base}-label`}
              label={m.fields.label}
              help={m.fields.labelHelp}
              className="sm:col-span-2"
            >
              {(a) => (
                <input
                  {...a}
                  type="text"
                  maxLength={60}
                  value={draft.label}
                  onChange={(e) => patch({ label: e.target.value })}
                  className={FIELD}
                />
              )}
            </Field>
            <Field id={`${base}-fullName`} label={m.fields.fullName} error={errors["fullName"]}>
              {(a) => (
                <input
                  {...a}
                  type="text"
                  autoComplete="name"
                  value={draft.fullName}
                  onChange={(e) => patch({ fullName: e.target.value })}
                  className={FIELD}
                />
              )}
            </Field>
            <Field id={`${base}-phone`} label={m.fields.phone} error={errors["phone"]}>
              {(a) => (
                <input
                  {...a}
                  type="text"
                  inputMode="tel"
                  autoComplete="tel"
                  value={draft.phone}
                  onChange={(e) => patch({ phone: e.target.value })}
                  className={FIELD}
                />
              )}
            </Field>
            <Field id={`${base}-county`} label={m.fields.county} error={errors["county"]}>
              {(a) => (
                <select
                  {...a}
                  value={draft.countyCode}
                  onChange={(e) => {
                    patch({ countyCode: e.target.value, localityCode: "" });
                    void loadLocalities(e.target.value);
                  }}
                  className={FIELD}
                >
                  <option value="">{m.fields.chooseCounty}</option>
                  {counties.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field id={`${base}-locality`} label={m.fields.locality} error={errors["locality"]}>
              {(a) => (
                <select
                  {...a}
                  value={draft.localityCode}
                  onChange={(e) => patch({ localityCode: e.target.value })}
                  className={FIELD}
                >
                  <option value="">{m.fields.chooseLocality}</option>
                  {localities.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field id={`${base}-street`} label={m.fields.street} error={errors["street"]}>
              {(a) => (
                <input
                  {...a}
                  type="text"
                  autoComplete="street-address"
                  value={draft.street}
                  onChange={(e) => patch({ street: e.target.value })}
                  className={FIELD}
                />
              )}
            </Field>
            <Field
              id={`${base}-postalCode`}
              label={m.fields.postalCode}
              error={errors["postalCode"]}
            >
              {(a) => (
                <input
                  {...a}
                  type="text"
                  inputMode="numeric"
                  autoComplete="postal-code"
                  value={draft.postalCode}
                  onChange={(e) => patch({ postalCode: e.target.value })}
                  className={FIELD}
                />
              )}
            </Field>
            <label className="flex items-center gap-3 sm:col-span-2">
              <input
                type="checkbox"
                checked={draft.isCompany}
                onChange={(e) => patch({ isCompany: e.target.checked })}
                className="size-5 accent-[var(--brand)]"
              />
              {m.fields.isCompany}
            </label>
            {draft.isCompany ? (
              <>
                <Field
                  id={`${base}-companyName`}
                  label={m.fields.companyName}
                  error={errors["companyName"]}
                >
                  {(a) => (
                    <input
                      {...a}
                      type="text"
                      value={draft.companyName}
                      onChange={(e) => patch({ companyName: e.target.value })}
                      className={FIELD}
                    />
                  )}
                </Field>
                <Field id={`${base}-vatId`} label={m.fields.vatId} error={errors["vatId"]}>
                  {(a) => (
                    <input
                      {...a}
                      type="text"
                      value={draft.vatId}
                      onChange={(e) => patch({ vatId: e.target.value })}
                      className={FIELD}
                    />
                  )}
                </Field>
                <Field
                  id={`${base}-trade`}
                  label={m.fields.tradeRegisterNo}
                  className="sm:col-span-2"
                >
                  {(a) => (
                    <input
                      {...a}
                      type="text"
                      value={draft.tradeRegisterNo}
                      onChange={(e) => patch({ tradeRegisterNo: e.target.value })}
                      className={FIELD}
                    />
                  )}
                </Field>
              </>
            ) : null}
            <label className="flex items-center gap-3 sm:col-span-2">
              <input
                type="checkbox"
                checked={draft.isDefaultShipping}
                onChange={(e) => patch({ isDefaultShipping: e.target.checked })}
                className="size-5 accent-[var(--brand)]"
              />
              {m.fields.defaultShipping}
            </label>
            <label className="flex items-center gap-3 sm:col-span-2">
              <input
                type="checkbox"
                checked={draft.isDefaultBilling}
                onChange={(e) => patch({ isDefaultBilling: e.target.checked })}
                className="size-5 accent-[var(--brand)]"
              />
              {m.fields.defaultBilling}
            </label>
            <p
              role="alert"
              className="min-h-6 text-tone-problem-fg sm:col-span-2"
              data-address-error
            >
              {formError}
            </p>
            <div className="flex flex-wrap justify-end gap-3 sm:col-span-2">
              <StoreButton type="button" variant="secondary" onClick={() => setDraft(null)}>
                {m.cancel}
              </StoreButton>
              <StoreButton type="submit" disabled={pending}>
                {pending ? m.saving : m.save}
              </StoreButton>
            </div>
          </form>
        ) : null}
      </Dialog>

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={m.removeTitle}
        description={m.removeText}
        closeLabel={getMessages().account.common.close}
      >
        <div className="flex flex-wrap justify-end gap-3">
          <StoreButton type="button" variant="secondary" onClick={() => setRemoving(null)}>
            {m.cancel}
          </StoreButton>
          <StoreButton
            type="button"
            onClick={confirmRemove}
            disabled={pending}
            data-address-remove-confirm
          >
            {m.removeConfirm}
          </StoreButton>
        </div>
      </Dialog>
    </div>
  );
}
