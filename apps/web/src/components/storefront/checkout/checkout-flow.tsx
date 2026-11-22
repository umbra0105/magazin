"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { StoreButton, StorePill, cn, storeButtonVariants } from "@ecom/ui";
import {
  getLocalitiesAction,
  lookupCuiAction,
  placeOrderAction,
  previewCheckoutAction,
} from "@/app/(checkout)/checkout/actions";
import type { CartDto } from "@/lib/cart-dto";
import type { CheckoutPreviewDto } from "@/lib/checkout-dto";
import {
  addressErrors,
  companyErrors,
  contactErrors,
  type FieldErrors,
} from "@/lib/checkout-validation";
import { getMessages } from "@/messages";
import { FIELD, Field, TEXTAREA } from "./fields";

const m = getMessages().storefront.checkout;

type StepId = "contact" | "delivery" | "shipping" | "billing" | "payment" | "review";
const STEPS: StepId[] = ["contact", "delivery", "shipping", "billing", "payment", "review"];

interface Option {
  code: number;
  label: string;
}

interface Values {
  email: string;
  phone: string;
  fullName: string;
  countyCode: string;
  localityCode: string;
  street: string;
  postalCode: string;
  offerCode: string;
  paymentMethod: "" | "cod" | "bank_transfer" | "card";
  billingSame: boolean;
  billing: {
    fullName: string;
    countyCode: string;
    localityCode: string;
    street: string;
    postalCode: string;
  };
  isCompany: boolean;
  companyName: string;
  vatId: string;
  tradeRegisterNo: string;
  note: string;
  installRequested: boolean;
  installNote: string;
  consent: boolean;
}

const EMPTY: Values = {
  email: "",
  phone: "",
  fullName: "",
  countyCode: "",
  localityCode: "",
  street: "",
  postalCode: "",
  offerCode: "",
  paymentMethod: "",
  billingSame: true,
  billing: { fullName: "", countyCode: "", localityCode: "", street: "", postalCode: "" },
  isCompany: false,
  companyName: "",
  vatId: "",
  tradeRegisterNo: "",
  note: "",
  installRequested: false,
  installNote: "",
  consent: false,
};

const DRAFT_KEY = "ecom.checkout.v1";
const ATTEMPT_KEY = "ecom.checkout.attempt";

export interface CheckoutFlowProps {
  counties: Option[];
  cart: CartDto;
  consent: { text: string; version: string };
  bank: { holder: string; bankName: string; iban: string } | null;
  transferDeadline: string;
  groundNotice: string;
}

type CuiState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "verified"; name: string }
  | { kind: "unverified" }
  | { kind: "error"; message: string };

function readDraft(): Values | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Values>;
    // fără acord, fără metodă de plată: acestea se aleg din nou, cu datele de zi (nimic de plată nu se păstrează)
    return {
      ...EMPTY,
      ...parsed,
      billing: { ...EMPTY.billing, ...parsed.billing },
      consent: false,
      paymentMethod: "",
      offerCode: "",
    };
  } catch {
    return null;
  }
}

function attemptKey(): string {
  try {
    const existing = window.sessionStorage.getItem(ATTEMPT_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    window.sessionStorage.setItem(ATTEMPT_KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

function useLocalities() {
  const [cache, setCache] = useState<Record<string, Option[]>>({});
  const load = useCallback(async (countyCode: string) => {
    if (countyCode === "") return;
    const result = await getLocalitiesAction(Number(countyCode));
    if (!result) return;
    setCache((previous) => ({
      ...previous,
      [countyCode]: result.map((item) => ({ code: item.code, label: item.label })),
    }));
  }, []);
  return { cache, load };
}

export function CheckoutFlow(props: CheckoutFlowProps) {
  const router = useRouter();
  const base = useId();
  const [values, setValues] = useState<Values>(EMPTY);
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState<StepId>("contact");
  const [reached, setReached] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [preview, setPreview] = useState<CheckoutPreviewDto | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const [cui, setCui] = useState<CuiState>({ kind: "idle" });
  const [placing, setPlacing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const localities = useLocalities();
  const keyRef = useRef<string>("");
  const valuesRef = useRef(values);
  valuesRef.current = values;

  // ciorna din browser (doar câmpurile de contact și adresă) și cheia de idempotență a acestei încercări
  useEffect(() => {
    keyRef.current = attemptKey();
    const draft = readDraft();
    if (draft) {
      setValues(draft);
      void localities.load(draft.countyCode);
      void localities.load(draft.billing.countyCode);
    }
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(values));
    } catch {
      // fără stocare locală: formularul merge oricum
    }
  }, [values, hydrated]);

  const set = (patch: Partial<Values>) => setValues((previous) => ({ ...previous, ...patch }));
  const setBilling = (patch: Partial<Values["billing"]>) =>
    setValues((previous) => ({ ...previous, billing: { ...previous.billing, ...patch } }));

  const refresh = useCallback(
    async (override: Partial<Values> = {}): Promise<CheckoutPreviewDto | null> => {
      setPreviewing(true);
      setPreviewProblem(null);
      try {
        let current = { ...valuesRef.current, ...override };
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await previewCheckoutAction({
            destination:
              current.countyCode &&
              current.localityCode &&
              /^\d{6}$/.test(current.postalCode.trim())
                ? {
                    countyCode: Number(current.countyCode),
                    localityCode: Number(current.localityCode),
                    postalCode: current.postalCode.trim(),
                  }
                : null,
            offerCode: current.offerCode || null,
            paymentMethod: current.paymentMethod || null,
            vatId: current.isCompany ? current.vatId.trim() || null : null,
          });
          if (!result.ok) {
            setPreviewProblem(
              result.code === "rate_limited" ? m.errors.rateLimited : m.errors.failed,
            );
            return null;
          }
          const data = result.preview;
          // alegeri implicite: oferta cea mai ieftină și prima metodă de plată disponibilă
          const patch: Partial<Values> = {};
          if (!data.selectedOfferCode && data.offers[0]) patch.offerCode = data.offers[0].code;
          if (data.selectedOfferCode && current.offerCode !== data.selectedOfferCode) {
            patch.offerCode = data.selectedOfferCode;
          }
          const chosen = data.methods?.find((method) => method.method === current.paymentMethod);
          if ((!chosen || !chosen.available) && data.methods) {
            const first = data.methods.find((method) => method.available);
            patch.paymentMethod = first ? first.method : "";
          }
          const changed = (Object.keys(patch) as Array<keyof Values>).some(
            (key) => patch[key] !== current[key],
          );
          if (changed) {
            current = { ...current, ...patch };
            setValues((previous) => ({ ...previous, ...patch }));
            continue;
          }
          setPreview(data);
          return data;
        }
        return null;
      } finally {
        setPreviewing(false);
      }
    },
    [],
  );

  const stepIndex = (id: StepId) => STEPS.indexOf(id);
  const errorsFor = (id: StepId): FieldErrors => {
    if (id === "contact") return contactErrors(values);
    if (id === "delivery") return addressErrors(values);
    if (id === "shipping") return values.offerCode ? {} : { offerCode: m.errors.offer };
    if (id === "billing") {
      return {
        ...(values.billingSame ? {} : addressErrors(values.billing, "billing")),
        ...(values.isCompany ? companyErrors(values) : {}),
      };
    }
    if (id === "payment") return values.paymentMethod ? {} : { paymentMethod: m.errors.method };
    return values.consent ? {} : { consent: m.consentRequired };
  };

  const focusFirst = (found: FieldErrors) => {
    const first = Object.keys(found)[0];
    if (!first) return;
    requestAnimationFrame(() => document.getElementById(`${base}-${first}`)?.focus());
  };

  const goTo = (id: StepId) => {
    setErrors({});
    setProblem(null);
    setOpen(id);
    setReached((previous) => Math.max(previous, stepIndex(id)));
    requestAnimationFrame(() =>
      document.getElementById(`${base}-step-${id}`)?.scrollIntoView({ block: "start" }),
    );
  };

  const next = async (from: StepId) => {
    const found = errorsFor(from);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      focusFirst(found);
      return;
    }
    const target = STEPS[stepIndex(from) + 1];
    if (!target) return;
    if (from === "delivery" || from === "shipping") await refresh();
    if (target === "payment") await refresh();
    goTo(target);
  };

  const onCountyChange = (countyCode: string, which: "delivery" | "billing") => {
    if (which === "delivery") set({ countyCode, localityCode: "", offerCode: "" });
    else setBilling({ countyCode, localityCode: "" });
    void localities.load(countyCode);
  };

  const checkCui = async () => {
    const found = companyErrors(values);
    if (found["vatId"]) {
      setErrors({ vatId: found["vatId"] });
      return;
    }
    setCui({ kind: "checking" });
    const result = await lookupCuiAction({ vatId: values.vatId });
    if (!result.ok) {
      setCui({
        kind: "error",
        message:
          result.reason === "format"
            ? m.cuiFormat
            : result.reason === "check_digit"
              ? m.cuiCheckDigit
              : m.errors.rateLimited,
      });
      return;
    }
    setCui(
      result.verification === "verified" && result.company
        ? { kind: "verified", name: result.company.name }
        : { kind: "unverified" },
    );
    void refresh();
  };

  const place = async () => {
    const found = errorsFor("review");
    if (Object.keys(found).length > 0) {
      setErrors(found);
      focusFirst(found);
      return;
    }
    const data = preview ?? (await refresh());
    if (!data?.totals || !values.offerCode || !values.paymentMethod) {
      setProblem(m.errors.failed);
      return;
    }
    setPlacing(true);
    setProblem(null);
    const address = (v: {
      fullName: string;
      countyCode: string;
      localityCode: string;
      street: string;
      postalCode: string;
    }) => ({
      fullName: v.fullName.trim(),
      phone: values.phone.trim(),
      countyCode: Number(v.countyCode),
      localityCode: Number(v.localityCode),
      street: v.street.trim(),
      postalCode: v.postalCode.trim(),
    });
    try {
      const result = await placeOrderAction({
        idempotencyKey: keyRef.current,
        expectedTotalMinor: data.totals.totalMinor,
        contact: { email: values.email.trim(), phone: values.phone.trim() },
        shipping: address(values),
        billing: values.billingSame
          ? { sameAsShipping: true }
          : { sameAsShipping: false, address: address(values.billing) },
        company: values.isCompany
          ? {
              name: values.companyName.trim(),
              vatId: values.vatId.trim(),
              ...(values.tradeRegisterNo.trim()
                ? { tradeRegisterNo: values.tradeRegisterNo.trim() }
                : {}),
            }
          : null,
        shippingOfferCode: values.offerCode,
        paymentMethod: values.paymentMethod,
        ...(values.note.trim() ? { customerNote: values.note.trim() } : {}),
        installation: {
          requested: values.installRequested,
          ...(values.installRequested && values.installNote.trim()
            ? { note: values.installNote.trim() }
            : {}),
        },
        consent: { accepted: true, version: props.consent.version },
      });
      if (result.ok) {
        try {
          window.localStorage.removeItem(DRAFT_KEY);
          window.sessionStorage.removeItem(ATTEMPT_KEY);
        } catch {
          // nimic de curățat
        }
        if (result.redirect) {
          // card: clientul pleacă la pagina procesatorului (sau la pagina de plată dacă pornirea a eșuat)
          window.location.assign(result.redirect);
          return;
        }
        router.push("/comanda/confirmare");
        return;
      }
      setProblem(result.message);
      if (result.refresh) await refresh();
      if (result.code === "ORDER_CART_NOT_READY" || result.code === "STOCK_INSUFFICIENT") {
        // cheie nouă: coșul s-a schimbat, o încercare nouă nu trebuie confundată cu cea eșuată
        try {
          window.sessionStorage.removeItem(ATTEMPT_KEY);
        } catch {
          // fără stocare de sesiune
        }
        keyRef.current = attemptKey();
      }
    } finally {
      setPlacing(false);
    }
  };

  const countyOptions = props.counties;
  const localitiesOf = (county: string) => localities.cache[county] ?? [];

  // ridicare personală: adresa de la pasul 2 e doar adresa clientului (contact, facturare), NU o adresă de livrare
  const chosenOffer = preview?.offers.find((o) => o.code === values.offerCode) ?? null;
  const isPickup = chosenOffer?.kind === "pickup";
  const pickupFrom =
    isPickup && chosenOffer?.addressText ? m.pickupFrom(chosenOffer.addressText) : null;

  const summaryOf = (id: StepId): string | null => {
    if (stepIndex(id) >= reached && open !== id) return null;
    if (id === "contact") return values.email ? `${values.email} · ${values.phone}` : null;
    if (id === "delivery") {
      return values.street && preview?.destination
        ? `${values.fullName}, ${values.street}, ${preview.destination.localityName}, ${preview.destination.countyName}`
        : values.fullName || null;
    }
    if (id === "shipping") return pickupFrom ?? chosenOffer?.label ?? null;
    if (id === "billing") {
      return values.isCompany
        ? `${values.companyName} · ${values.vatId}`
        : values.billingSame
          ? isPickup
            ? m.billingSamePickup
            : m.billingSame
          : values.billing.fullName;
    }
    if (id === "payment")
      return preview?.methods?.find((x) => x.method === values.paymentMethod)?.label ?? null;
    return null;
  };

  const stepShell = (id: StepId, content: ReactNode) => {
    const index = stepIndex(id);
    const isOpen = open === id;
    const unlocked = index <= reached;
    const summary = summaryOf(id);
    return (
      <section
        key={id}
        id={`${base}-step-${id}`}
        data-step={id}
        aria-labelledby={`${base}-title-${id}`}
        className="rounded-card border border-line-subtle bg-surface-page"
      >
        <h2 className="m-0">
          <button
            type="button"
            id={`${base}-title-${id}`}
            aria-expanded={isOpen}
            aria-controls={`${base}-panel-${id}`}
            disabled={!unlocked}
            onClick={() => (isOpen ? setOpen(id) : unlocked ? goTo(id) : undefined)}
            className="flex min-h-14 w-full items-center gap-4 rounded-card px-5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60"
          >
            <span
              aria-hidden="true"
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-full border text-sm font-semibold",
                unlocked && !isOpen ? "border-brand bg-brand text-brand-fg" : "border-line-control",
              )}
            >
              {index + 1}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-lg font-semibold">
                {id === "delivery" && isPickup ? m.stepsPickup.delivery : m.steps[id]}
              </span>
              {!isOpen && summary ? (
                <span className="truncate text-sm text-ink-secondary" data-step-summary>
                  {summary}
                </span>
              ) : null}
            </span>
            {!isOpen && unlocked && summary ? (
              <span className="shrink-0 text-sm font-medium underline underline-offset-4">
                {m.edit}
              </span>
            ) : null}
          </button>
        </h2>
        <div
          id={`${base}-panel-${id}`}
          hidden={!isOpen}
          className="flex flex-col gap-5 border-t border-line-subtle px-5 py-6"
        >
          {isOpen && Object.keys(errors).length > 0 ? (
            <p
              role="alert"
              className="rounded-card bg-tone-problem-bg px-4 py-3 text-sm text-tone-problem-fg"
            >
              {m.errors.invalid}
            </p>
          ) : null}
          {content}
        </div>
      </section>
    );
  };

  const addressFields = (
    v: Values["billing"] | Values,
    update: (patch: Partial<Values["billing"]>) => void,
    which: "delivery" | "billing",
    prefix: string,
  ) => {
    const key = (name: string) => (prefix ? `${prefix}.${name}` : name);
    const selected = localitiesOf(v.countyCode);
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${base}-${key("fullName")}`}
          label={m.fields.fullName}
          error={errors[key("fullName")]}
          className="sm:col-span-2"
        >
          {(a) => (
            <input
              {...a}
              name={key("fullName")}
              autoComplete="name"
              value={v.fullName}
              onChange={(e) => update({ fullName: e.target.value })}
              className={FIELD}
            />
          )}
        </Field>
        <Field
          id={`${base}-${key("countyCode")}`}
          label={m.fields.county}
          error={errors[key("countyCode")]}
        >
          {(a) => (
            <select
              {...a}
              name={key("countyCode")}
              autoComplete="address-level1"
              value={v.countyCode}
              onChange={(e) => onCountyChange(e.target.value, which)}
              className={FIELD}
            >
              <option value="">{m.fields.countyPlaceholder}</option>
              {countyOptions.map((county) => (
                <option key={county.code} value={String(county.code)}>
                  {county.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id={`${base}-${key("localityCode")}`}
          label={m.fields.locality}
          error={errors[key("localityCode")]}
        >
          {(a) => (
            <select
              {...a}
              name={key("localityCode")}
              autoComplete="address-level2"
              value={v.localityCode}
              disabled={v.countyCode === ""}
              onChange={(e) => {
                update({ localityCode: e.target.value });
                if (which === "delivery") set({ offerCode: "" });
              }}
              className={FIELD}
            >
              <option value="">
                {v.countyCode === "" ? m.fields.localityFirst : m.fields.localityPlaceholder}
              </option>
              {selected.map((item) => (
                <option key={item.code} value={String(item.code)}>
                  {item.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id={`${base}-${key("street")}`}
          label={m.fields.street}
          error={errors[key("street")]}
          className="sm:col-span-2"
        >
          {(a) => (
            <input
              {...a}
              name={key("street")}
              autoComplete="street-address"
              value={v.street}
              onChange={(e) => update({ street: e.target.value })}
              className={FIELD}
            />
          )}
        </Field>
        <Field
          id={`${base}-${key("postalCode")}`}
          label={m.fields.postalCode}
          help={m.fields.postalHelp}
          error={errors[key("postalCode")]}
        >
          {(a) => (
            <input
              {...a}
              name={key("postalCode")}
              autoComplete="postal-code"
              inputMode="numeric"
              maxLength={6}
              value={v.postalCode}
              onChange={(e) => update({ postalCode: e.target.value.replace(/\D/g, "") })}
              className={cn(FIELD, "sm:max-w-48")}
            />
          )}
        </Field>
      </div>
    );
  };

  const continueButton = (from: StepId) => (
    <div>
      <StoreButton
        type="button"
        disabled={previewing}
        onClick={() => void next(from)}
        data-continue={from}
      >
        {previewing ? m.loading : m.continue}
      </StoreButton>
    </div>
  );

  const totals = preview?.totals ?? null;
  const method = preview?.methods?.find((x) => x.method === values.paymentMethod) ?? null;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void place();
      }}
      className="grid gap-8 lg:grid-cols-12 lg:items-start"
      data-checkout-form
    >
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-7 xl:col-span-8">
        {stepShell(
          "contact",
          <>
            <p className="text-ink-secondary">{m.contactLede}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${base}-email`} label={m.fields.email} error={errors["email"]}>
                {(a) => (
                  <input
                    {...a}
                    name="email"
                    type="text"
                    inputMode="email"
                    autoComplete="email"
                    value={values.email}
                    onChange={(e) => set({ email: e.target.value })}
                    className={FIELD}
                  />
                )}
              </Field>
              <Field id={`${base}-phone`} label={m.fields.phone} error={errors["phone"]}>
                {(a) => (
                  <input
                    {...a}
                    name="phone"
                    type="text"
                    inputMode="tel"
                    autoComplete="tel"
                    value={values.phone}
                    onChange={(e) => set({ phone: e.target.value })}
                    className={FIELD}
                  />
                )}
              </Field>
            </div>
            <p className="text-sm text-ink-secondary">{m.guestNote}</p>
            {continueButton("contact")}
          </>,
        )}
        {stepShell(
          "delivery",
          <>
            {addressFields(values, (patch) => set(patch), "delivery", "")}
            {continueButton("delivery")}
          </>,
        )}
        {stepShell(
          "shipping",
          <>
            <p className="text-ink-secondary">{m.shippingLede}</p>
            {previewing && !preview ? <p role="status">{m.shippingLoading}</p> : null}
            {previewProblem ? (
              <p role="alert" className="text-tone-problem-fg">
                {previewProblem}
              </p>
            ) : null}
            {preview?.fallbackUsed ? (
              <p
                className="rounded-card bg-tone-info-bg px-4 py-3 text-sm text-tone-info-fg"
                data-shipping-fallback
              >
                {m.shippingFallback}
              </p>
            ) : null}
            {preview?.incomplete ? (
              <p className="text-sm text-ink-secondary">{m.shippingIncomplete}</p>
            ) : null}
            <fieldset
              className="flex flex-col gap-3"
              aria-describedby={errors["offerCode"] ? `${base}-offerCode-error` : undefined}
            >
              <legend className="sr-only">{m.steps.shipping}</legend>
              {preview?.offers.map((offer, index) => (
                <label
                  key={offer.code}
                  data-offer={offer.code}
                  className={cn(
                    "flex min-h-14 cursor-pointer items-start gap-4 rounded-card border px-4 py-3",
                    values.offerCode === offer.code
                      ? "border-brand bg-card"
                      : "border-line-control",
                  )}
                >
                  <input
                    id={index === 0 ? `${base}-offerCode` : undefined}
                    type="radio"
                    name="shippingOffer"
                    value={offer.code}
                    checked={values.offerCode === offer.code}
                    onChange={() => {
                      set({ offerCode: offer.code });
                      void refresh({ offerCode: offer.code });
                    }}
                    className="mt-1 size-5 shrink-0 accent-brand"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 font-semibold">
                      {offer.label}
                      {offer.demo ? <StorePill tone="warning">{m.demoBadge}</StorePill> : null}
                    </span>
                    {offer.daysText ? (
                      <span className="text-sm text-ink-secondary">{offer.daysText}</span>
                    ) : null}
                    {offer.addressLine ? (
                      <span className="text-sm" data-offer-address>
                        {offer.addressLine}
                      </span>
                    ) : null}
                    {offer.demo ? (
                      <span className="text-sm text-ink-secondary">{m.demoNote}</span>
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 font-semibold tabular-nums",
                      offer.free && "text-tone-success-fg",
                    )}
                  >
                    {offer.priceText}
                  </span>
                </label>
              ))}
            </fieldset>
            {errors["offerCode"] ? (
              <p
                id={`${base}-offerCode-error`}
                role="alert"
                className="text-sm text-tone-problem-fg"
              >
                {errors["offerCode"]}
              </p>
            ) : null}
            {preview?.leadTimeText ? (
              <p className="text-sm font-medium">{preview.leadTimeText}</p>
            ) : null}
            {isPickup ? null : (
              // «la nivelul solului» e un mesaj despre livrare: nu se arată la ridicarea personală
              <p className="text-sm text-ink-secondary" data-ground-notice>
                {chosenOffer?.kind === "pallet" ? m.palletNotice : props.groundNotice}
              </p>
            )}
            {continueButton("shipping")}
          </>,
        )}
        {stepShell(
          "billing",
          <>
            <fieldset className="flex min-w-0 flex-col gap-3">
              <legend className="sr-only">{m.steps.billing}</legend>
              <label className="flex min-h-11 items-center gap-3">
                <input
                  type="radio"
                  name="billing"
                  checked={values.billingSame}
                  onChange={() => set({ billingSame: true })}
                  className="size-5 accent-brand"
                />
                {isPickup ? m.billingSamePickup : m.billingSame}
              </label>
              <label className="flex min-h-11 items-center gap-3">
                <input
                  type="radio"
                  name="billing"
                  checked={!values.billingSame}
                  onChange={() => set({ billingSame: false })}
                  className="size-5 accent-brand"
                />
                {m.billingOther}
              </label>
            </fieldset>
            {values.billingSame
              ? null
              : addressFields(values.billing, setBilling, "billing", "billing")}
            <label className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                checked={values.isCompany}
                onChange={(e) => {
                  set({ isCompany: e.target.checked });
                  setCui({ kind: "idle" });
                  void refresh({ isCompany: e.target.checked });
                }}
                className="size-5 accent-brand"
              />
              {m.companyToggle}
            </label>
            {values.isCompany ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id={`${base}-vatId`}
                  label={m.fields.vatId}
                  help={m.fields.vatHelp}
                  error={errors["vatId"]}
                >
                  {(a) => (
                    <input
                      {...a}
                      name="vatId"
                      type="text"
                      autoComplete="off"
                      value={values.vatId}
                      onChange={(e) => {
                        set({ vatId: e.target.value });
                        setCui({ kind: "idle" });
                      }}
                      className={FIELD}
                    />
                  )}
                </Field>
                <div className="flex items-end">
                  <StoreButton
                    type="button"
                    variant="secondary"
                    disabled={cui.kind === "checking"}
                    onClick={() => void checkCui()}
                    data-cui-check
                  >
                    {cui.kind === "checking" ? m.cuiChecking : m.cuiCheck}
                  </StoreButton>
                </div>
                <Field
                  id={`${base}-companyName`}
                  label={m.fields.company}
                  error={errors["companyName"]}
                  className="sm:col-span-2"
                >
                  {(a) => (
                    <input
                      {...a}
                      name="companyName"
                      type="text"
                      autoComplete="organization"
                      value={values.companyName}
                      onChange={(e) => set({ companyName: e.target.value })}
                      className={FIELD}
                    />
                  )}
                </Field>
                <Field
                  id={`${base}-tradeRegisterNo`}
                  label={m.fields.tradeRegisterNo}
                  className="sm:col-span-2"
                >
                  {(a) => (
                    <input
                      {...a}
                      name="tradeRegisterNo"
                      type="text"
                      autoComplete="off"
                      value={values.tradeRegisterNo}
                      onChange={(e) => set({ tradeRegisterNo: e.target.value })}
                      className={FIELD}
                    />
                  )}
                </Field>
                <div className="text-sm sm:col-span-2" role="status" data-cui-state={cui.kind}>
                  {cui.kind === "verified" ? (
                    <p>
                      {m.cuiVerified(cui.name)}{" "}
                      <button
                        type="button"
                        className="underline underline-offset-4"
                        onClick={() => set({ companyName: cui.name })}
                      >
                        {m.useCompanyName}
                      </button>
                    </p>
                  ) : null}
                  {cui.kind === "unverified" ? <p>{m.cuiUnverified}</p> : null}
                  {cui.kind === "error" ? (
                    <p className="text-tone-problem-fg">{cui.message}</p>
                  ) : null}
                </div>
              </div>
            ) : null}
            {continueButton("billing")}
          </>,
        )}
        {stepShell(
          "payment",
          <>
            <p className="text-ink-secondary">{m.paymentLede}</p>
            <fieldset className="flex min-w-0 flex-col gap-3">
              <legend className="sr-only">{m.steps.payment}</legend>
              {preview?.methods?.map((entry, index) => (
                <label
                  key={entry.method}
                  data-method={entry.method}
                  data-available={entry.available}
                  className={cn(
                    "flex min-h-14 items-start gap-4 rounded-card border px-4 py-3",
                    entry.available ? "cursor-pointer" : "cursor-not-allowed opacity-80",
                    values.paymentMethod === entry.method
                      ? "border-brand bg-card"
                      : "border-line-control",
                  )}
                >
                  <input
                    id={index === 0 ? `${base}-paymentMethod` : undefined}
                    type="radio"
                    name="paymentMethod"
                    value={entry.method}
                    disabled={!entry.available}
                    checked={values.paymentMethod === entry.method}
                    onChange={() => {
                      set({ paymentMethod: entry.method });
                      void refresh({ paymentMethod: entry.method });
                    }}
                    className="mt-1 size-5 shrink-0 accent-brand"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 font-semibold">
                      {entry.label}
                      {entry.available ? null : (
                        <StorePill tone="problem">{m.unavailable}</StorePill>
                      )}
                    </span>
                    <span className="text-sm text-ink-secondary">
                      {entry.available ? entry.helpText : entry.reasonText}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {errors["paymentMethod"] ? (
              <p role="alert" className="text-sm text-tone-problem-fg">
                {errors["paymentMethod"]}
              </p>
            ) : null}
            {values.paymentMethod === "bank_transfer" ? (
              <div className="rounded-card bg-card p-4 text-sm" data-bank-details>
                <p className="font-semibold">{m.bankTitle}</p>
                {props.bank ? (
                  <dl className="mt-2 grid gap-1">
                    <div className="flex gap-2">
                      <dt className="text-ink-secondary">{m.bankHolder}:</dt>
                      <dd>{props.bank.holder}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-ink-secondary">{m.bankName}:</dt>
                      <dd>{props.bank.bankName}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-ink-secondary">{m.bankIban}:</dt>
                      <dd className="font-mono">{props.bank.iban}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="mt-2">{m.bankMissing}</p>
                )}
                <p className="mt-3 text-ink-secondary">{m.bankReference}</p>
                <p className="mt-1 text-ink-secondary">{m.bankDeadline(props.transferDeadline)}</p>
              </div>
            ) : null}
            {continueButton("payment")}
          </>,
        )}
        {stepShell(
          "review",
          <>
            <p className="text-ink-secondary">{m.reviewLede}</p>
            {pickupFrom ? (
              <p className="font-medium" data-review-pickup>
                {pickupFrom}
              </p>
            ) : null}
            <Field id={`${base}-note`} label={m.fields.note}>
              {(a) => (
                <textarea
                  {...a}
                  name="note"
                  maxLength={1000}
                  value={values.note}
                  onChange={(e) => set({ note: e.target.value })}
                  className={TEXTAREA}
                />
              )}
            </Field>
            <div className="flex flex-col gap-2">
              <label className="flex min-h-11 items-start gap-3">
                <input
                  type="checkbox"
                  name="installRequested"
                  checked={values.installRequested}
                  onChange={(e) => set({ installRequested: e.target.checked })}
                  className="mt-1 size-5 shrink-0 accent-brand"
                />
                <span>
                  <span className="block font-medium">{m.installLabel}</span>
                  <span className="block text-sm text-ink-secondary">{m.installHelp}</span>
                </span>
              </label>
              {values.installRequested ? (
                <Field id={`${base}-installNote`} label={m.fields.installNote}>
                  {(a) => (
                    <textarea
                      {...a}
                      name="installNote"
                      maxLength={1000}
                      value={values.installNote}
                      onChange={(e) => set({ installNote: e.target.value })}
                      className={TEXTAREA}
                    />
                  )}
                </Field>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <label className="flex min-h-11 items-start gap-3">
                <input
                  id={`${base}-consent`}
                  type="checkbox"
                  name="consent"
                  checked={values.consent}
                  aria-invalid={errors["consent"] ? true : undefined}
                  aria-describedby={`${base}-consent-links${errors["consent"] ? ` ${base}-consent-error` : ""}`}
                  onChange={(e) => set({ consent: e.target.checked })}
                  className="mt-1 size-5 shrink-0 accent-brand"
                />
                <span>{props.consent.text}</span>
              </label>
              <p id={`${base}-consent-links`} className="text-sm text-ink-secondary">
                <Link
                  href="/termeni-si-conditii"
                  target="_blank"
                  rel="noopener"
                  className="underline underline-offset-4"
                >
                  {m.consentLinks.terms}
                </Link>{" "}
                ·{" "}
                <Link
                  href="/politica-de-confidentialitate"
                  target="_blank"
                  rel="noopener"
                  className="underline underline-offset-4"
                >
                  {m.consentLinks.privacy}
                </Link>{" "}
                ({m.draftNotice})
              </p>
              {errors["consent"] ? (
                <p
                  id={`${base}-consent-error`}
                  role="alert"
                  className="text-sm text-tone-problem-fg"
                >
                  {errors["consent"]}
                </p>
              ) : null}
            </div>
            {problem ? (
              <p
                role="alert"
                className="rounded-card bg-tone-problem-bg px-4 py-3 text-tone-problem-fg"
                data-checkout-problem
              >
                {problem}
              </p>
            ) : null}
            <StoreButton
              type="submit"
              size="lg"
              disabled={placing || previewing}
              data-checkout-submit
              className="w-full sm:w-auto"
            >
              {placing ? m.placing : m.placeOrder}
            </StoreButton>
          </>,
        )}
      </div>

      <aside
        aria-label={m.summary}
        className="flex min-w-0 flex-col gap-4 rounded-card bg-card p-6 lg:sticky lg:top-6 lg:col-span-5 xl:col-span-4"
        data-checkout-summary
      >
        <h2 className="text-lg font-semibold">{m.summary}</h2>
        <ul className="flex flex-col divide-y divide-line-subtle">
          {props.cart.lines.map((line) => (
            <li
              key={line.variantId}
              className="flex items-start justify-between gap-3 py-3 text-sm"
            >
              <span className="min-w-0">
                <span className="block font-medium">{line.title}</span>
                <span className="block text-ink-secondary">{line.quantityText}</span>
              </span>
              <span className="shrink-0 tabular-nums">{line.totalText}</span>
            </li>
          ))}
        </ul>
        <dl className="flex flex-col gap-1.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-secondary">{m.products}</dt>
            <dd className="tabular-nums">
              {totals?.productsText ?? props.cart.totals?.productsText}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-secondary">{m.shipping}</dt>
            <dd className="tabular-nums" data-summary-shipping>
              {totals ? totals.shippingText : "—"}
            </dd>
          </div>
          {totals?.codFeeText ? (
            <div className="flex justify-between gap-4">
              <dt className="text-ink-secondary">{m.codFee}</dt>
              <dd className="tabular-nums">{totals.codFeeText}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4 border-t border-line-subtle pt-3 text-base font-semibold">
            <dt>{m.total}</dt>
            <dd className="tabular-nums" data-summary-total>
              {totals ? totals.totalText : props.cart.totals?.totalText}
            </dd>
          </div>
          {totals ? (
            <div className="text-right text-ink-secondary tabular-nums">
              {m.vatIncluded(totals.vatText)}
            </div>
          ) : null}
        </dl>
        {pickupFrom ? (
          <p className="text-sm" data-summary-pickup>
            {pickupFrom}
          </p>
        ) : null}
        {method?.method === "cod" ? (
          <p className="text-sm text-ink-secondary">{method.helpText}</p>
        ) : null}
        <Link href="/cos" className={cn(storeButtonVariants({ variant: "secondary" }), "w-full")}>
          {m.backToCart}
        </Link>
      </aside>
    </form>
  );
}
