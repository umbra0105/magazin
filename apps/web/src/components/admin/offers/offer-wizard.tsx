"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import type { CountyOption, LocalityOption, OfferPreview, OfferVariantOption } from "@ecom/core";
import { Button, Input, Label, Select } from "@ecom/ui";
import {
  createOfferAction,
  listOfferLocalitiesAction,
  previewOfferAction,
  searchOfferProductsAction,
} from "@/app/(admin)/admin/comenzi/oferte/actions";
import { LinkPanel } from "@/components/admin/offers/link-panel";
import { formatMoney } from "@/lib/money-input";
import { getMessages } from "@/messages";

const t = getMessages().admin.orders.offers;

export interface WizardLine {
  variantId: string;
  sku: string;
  title: string;
  quantity: string;
}

export interface WizardInitial {
  lines: WizardLine[];
  email: string;
  phone: string;
  fullName: string;
  countyCode: number | null;
  localityCode: number | null;
  street: string;
  postalCode: string;
  companyName: string;
  vatId: string;
  shippingOfferCode: string;
  fromOrder: boolean;
}

interface Props {
  counties: CountyOption[];
  /** Localitățile județului din schița preluată (altfel se încarcă la alegerea județului). */
  initialLocalities: LocalityOption[];
  initial: WizardInitial;
  currency: string;
  locale: string;
}

type Errors = Record<string, string>;
const QUANTITY = /^\d+([.,]\d{1,4})?$/;

/**
 * Ofertă nouă, pas cu pas (decizia A): produse → client și adresă → livrare → rezumat. Interfața nu trimite nicio sumă: prețurile,
 * transportul și totalul vin de la server (motorul de prețuri și serviciul de livrare), iar creația le îngheață. Fără validare
 * nativă a browserului (`noValidate`, mesaje în română, focus pe primul câmp greșit); un singur buton principal pe pas.
 */
export function OfferWizard({ counties, initialLocalities, initial, currency, locale }: Props) {
  const base = useId();
  const [step, setStep] = useState(0);
  const [lines, setLines] = useState<WizardLine[]>(initial.lines);
  const [form, setForm] = useState({
    email: initial.email,
    phone: initial.phone,
    fullName: initial.fullName,
    countyCode: initial.countyCode,
    localityCode: initial.localityCode,
    street: initial.street,
    postalCode: initial.postalCode,
    isCompany: initial.vatId !== "",
    companyName: initial.companyName,
    vatId: initial.vatId,
  });
  const [localities, setLocalities] = useState<LocalityOption[]>(initialLocalities);
  const [offerCode, setOfferCode] = useState(initial.shippingOfferCode);
  const [preview, setPreview] = useState<OfferPreview | null>(null);
  const [sendEmail, setSendEmail] = useState(true);
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    offerId: string;
    number: string;
    link: string;
    emailQueued: boolean | null;
  } | null>(null);
  const [pending, start] = useTransition();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const focus = (id: string) => document.getElementById(`${base}-${id}`)?.focus();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const destination = () =>
    form.countyCode && form.localityCode
      ? {
          countyCode: form.countyCode,
          localityCode: form.localityCode,
          postalCode: form.postalCode,
        }
      : null;

  const loadPreview = (code: string | null, then?: (p: OfferPreview) => void) => {
    const where = destination();
    if (!where) return;
    start(async () => {
      setProblem(null);
      const result = await previewOfferAction({
        lines: lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity.replace(",", "."),
        })),
        destination: where,
        shippingOfferCode: code,
        vatId: form.isCompany && form.vatId.trim() !== "" ? form.vatId.trim() : null,
      });
      if (!result.ok) {
        setProblem(t.wizard.errors[result.code]);
        return;
      }
      setPreview(result.preview);
      then?.(result.preview);
    });
  };

  const validateStep = (index: number): boolean => {
    const found: Errors = {};
    if (index === 0) {
      if (lines.length === 0) found["search"] = t.wizard.noLines;
      lines.forEach((line, position) => {
        // textul rămâne text (nicio cantitate ca număr zecimal); serverul o parsează exact cu `Quantity`
        const text = line.quantity.trim();
        if (!QUANTITY.test(text) || !/[1-9]/.test(text)) {
          found[`qty-${position}`] = t.wizard.quantityInvalid;
        }
      });
    }
    if (index === 1) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
        found["email"] = t.wizard.emailInvalid;
      if (!/^(\+40|0040|0)\d{9}$/.test(form.phone.replace(/[\s.\-()]/g, ""))) {
        found["phone"] = t.wizard.phoneInvalid;
      }
      if (form.fullName.trim().length < 2) found["fullName"] = t.wizard.required;
      if (!form.countyCode) found["county"] = t.wizard.required;
      if (!form.localityCode) found["locality"] = t.wizard.required;
      if (form.street.trim().length < 3) found["street"] = t.wizard.required;
      if (!/^\d{6}$/.test(form.postalCode.trim())) found["postalCode"] = t.wizard.postalInvalid;
      if (form.isCompany) {
        if (form.companyName.trim().length < 2) found["companyName"] = t.wizard.required;
        if (form.vatId.trim().length < 2) found["vatId"] = t.wizard.required;
      }
    }
    if (index === 2) {
      if (!offerCode || !preview?.offers.some((offer) => offer.code === offerCode)) {
        found["offer"] = t.wizard.shippingRequired;
      } else if (!preview.cardAvailable) found["offer"] = t.wizard.cardMissing;
    }
    setErrors(found);
    const firstKey = Object.keys(found)[0];
    if (firstKey) {
      focus(firstKey);
      return false;
    }
    return true;
  };

  const next = (event: FormEvent) => {
    event.preventDefault();
    if (pending || !validateStep(step)) return;
    if (step === 1) {
      setOfferCode("");
      loadPreview(null, () => setStep(2));
      return;
    }
    if (step === 2) {
      loadPreview(offerCode, () => setStep(3));
      return;
    }
    if (step === 3) return submit();
    setStep(step + 1);
  };

  const submit = () => {
    const where = destination();
    if (!where) return;
    start(async () => {
      setProblem(null);
      const result = await createOfferAction({
        sendEmail,
        draft: {
          email: form.email.trim(),
          phone: form.phone.trim(),
          shipping: {
            fullName: form.fullName.trim(),
            phone: form.phone.trim(),
            countyCode: where.countyCode,
            localityCode: where.localityCode,
            street: form.street.trim(),
            postalCode: form.postalCode.trim(),
          },
          billing: { sameAsShipping: true },
          company: form.isCompany
            ? { name: form.companyName.trim(), vatId: form.vatId.trim() }
            : null,
          shippingOfferCode: offerCode,
          lines: lines.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity.replace(",", "."),
          })),
        },
      });
      if (!result.ok) {
        setProblem(t.wizard.errors[result.code]);
        return;
      }
      setCreated(result);
    });
  };

  if (created) {
    return (
      <section className="flex flex-col gap-4" data-offer-created>
        <h2 className="text-title" ref={heading} tabIndex={-1}>
          {t.created.title(created.number)}
        </h2>
        <LinkPanel link={created.link} emailQueued={created.emailQueued} />
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/admin/comenzi/oferte/${created.offerId}`}
            className="inline-flex h-(--control-h) items-center rounded-md bg-brand px-4 text-brand-fg"
          >
            {t.created.toOffer}
          </Link>
          <Link
            href="/admin/comenzi/oferte/nou"
            className="inline-flex h-(--control-h) items-center rounded-md border border-line-input px-4"
          >
            {t.created.another}
          </Link>
        </div>
      </section>
    );
  }

  const name = t.wizard.steps[step] ?? "";
  return (
    <form noValidate onSubmit={next} className="flex max-w-3xl flex-col gap-6" data-offer-wizard>
      <div>
        <h2 className="text-title" ref={heading} tabIndex={-1} data-offer-step={step}>
          {t.wizard.stepLabel(step + 1, t.wizard.steps.length, name)}
        </h2>
        {initial.fromOrder && step === 0 && (
          <p role="note" className="mt-2 rounded-lg bg-surface-subtle p-3 text-body">
            {t.wizard.fromOrder}
          </p>
        )}
      </div>

      {step === 0 && (
        <ProductsStep
          base={base}
          lines={lines}
          setLines={setLines}
          errors={errors}
          clearError={(key) => setErrors((current) => ({ ...current, [key]: "" }))}
        />
      )}

      {step === 1 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${base}-email`} label={t.wizard.email} error={errors["email"]}>
            <Input
              id={`${base}-email`}
              value={form.email}
              onChange={(e) => set({ email: e.target.value })}
              autoComplete="off"
              aria-invalid={errors["email"] ? true : undefined}
            />
          </Field>
          <Field id={`${base}-phone`} label={t.wizard.phone} error={errors["phone"]}>
            <Input
              id={`${base}-phone`}
              value={form.phone}
              onChange={(e) => set({ phone: e.target.value })}
              inputMode="tel"
              aria-invalid={errors["phone"] ? true : undefined}
            />
          </Field>
          <Field id={`${base}-fullName`} label={t.wizard.fullName} error={errors["fullName"]}>
            <Input
              id={`${base}-fullName`}
              value={form.fullName}
              onChange={(e) => set({ fullName: e.target.value })}
              aria-invalid={errors["fullName"] ? true : undefined}
            />
          </Field>
          <Field id={`${base}-county`} label={t.wizard.county} error={errors["county"]}>
            <Select
              id={`${base}-county`}
              value={form.countyCode ?? ""}
              aria-invalid={errors["county"] ? true : undefined}
              onChange={(e) => {
                const code = e.target.value ? Number(e.target.value) : null;
                set({ countyCode: code, localityCode: null });
                setLocalities([]);
                if (code) {
                  start(async () =>
                    setLocalities(await listOfferLocalitiesAction({ countyCode: code })),
                  );
                }
              }}
            >
              <option value="">{t.wizard.chooseCounty}</option>
              {counties.map((county) => (
                <option key={county.code} value={county.code}>
                  {county.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`${base}-locality`} label={t.wizard.locality} error={errors["locality"]}>
            <Select
              id={`${base}-locality`}
              value={form.localityCode ?? ""}
              aria-invalid={errors["locality"] ? true : undefined}
              onChange={(e) =>
                set({ localityCode: e.target.value ? Number(e.target.value) : null })
              }
            >
              <option value="">{t.wizard.chooseLocality}</option>
              {localities.map((locality) => (
                <option key={locality.code} value={locality.code}>
                  {locality.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`${base}-street`} label={t.wizard.street} error={errors["street"]}>
            <Input
              id={`${base}-street`}
              value={form.street}
              onChange={(e) => set({ street: e.target.value })}
              aria-invalid={errors["street"] ? true : undefined}
            />
          </Field>
          <Field id={`${base}-postalCode`} label={t.wizard.postalCode} error={errors["postalCode"]}>
            <Input
              id={`${base}-postalCode`}
              value={form.postalCode}
              onChange={(e) => set({ postalCode: e.target.value })}
              inputMode="numeric"
              maxLength={6}
              aria-invalid={errors["postalCode"] ? true : undefined}
            />
          </Field>
          <label className="flex min-h-11 items-center gap-2 sm:col-span-2">
            <input
              type="checkbox"
              checked={form.isCompany}
              onChange={(e) => set({ isCompany: e.target.checked })}
              className="size-5 accent-brand"
            />
            <span>{t.wizard.company}</span>
          </label>
          {form.isCompany && (
            <>
              <Field
                id={`${base}-companyName`}
                label={t.wizard.companyName}
                error={errors["companyName"]}
              >
                <Input
                  id={`${base}-companyName`}
                  value={form.companyName}
                  onChange={(e) => set({ companyName: e.target.value })}
                  aria-invalid={errors["companyName"] ? true : undefined}
                />
              </Field>
              <Field id={`${base}-vatId`} label={t.wizard.vatId} error={errors["vatId"]}>
                <Input
                  id={`${base}-vatId`}
                  value={form.vatId}
                  onChange={(e) => set({ vatId: e.target.value })}
                  aria-invalid={errors["vatId"] ? true : undefined}
                />
              </Field>
            </>
          )}
        </div>
      )}

      {step === 2 && (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-body text-ink-secondary">{t.wizard.shippingHelp}</legend>
          {preview && preview.offers.length === 0 && <p>{t.wizard.shippingNone}</p>}
          {preview?.offers.map((offer, index) => (
            <label
              key={offer.code}
              className="flex min-h-11 items-center gap-3 rounded-lg border border-line-subtle p-3"
            >
              <input
                id={index === 0 ? `${base}-offer` : undefined}
                type="radio"
                name="offer"
                value={offer.code}
                checked={offerCode === offer.code}
                onChange={() => setOfferCode(offer.code)}
                className="size-5 accent-brand"
              />
              <span className="flex-1">
                {offer.carrier} · {offer.service}
              </span>
              <span className="font-medium">
                {offer.priceMinor === 0 ? t.wizard.free : money(offer.priceMinor)}
              </span>
            </label>
          ))}
          {errors["offer"] && (
            <p role="alert" className="text-label text-tone-problem-fg">
              {errors["offer"]}
            </p>
          )}
        </fieldset>
      )}

      {step === 3 && preview?.totals && (
        <div className="flex flex-col gap-4">
          <table className="w-full text-body">
            <thead>
              <tr className="text-left text-label text-ink-secondary">
                <th className="py-1">{t.wizard.lineColumns.product}</th>
                <th className="py-1">{t.wizard.lineColumns.quantity}</th>
                <th className="py-1 text-right">{t.wizard.lineColumns.unitPrice}</th>
                <th className="py-1 text-right">{t.wizard.lineColumns.total}</th>
              </tr>
            </thead>
            <tbody>
              {preview.lines.map((line) => (
                <tr key={line.sku} className="border-t border-line-subtle">
                  <td className="py-2">{line.title}</td>
                  <td className="py-2">
                    {line.quantity} {line.unitSymbol}
                  </td>
                  <td className="py-2 text-right">{money(line.unitPriceMinor)}</td>
                  <td className="py-2 text-right">{money(line.lineTotalMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="flex flex-col gap-1">
            <Row label={t.wizard.summaryProducts} value={money(preview.totals.subtotalMinor)} />
            <Row
              label={t.wizard.summaryShipping}
              value={
                preview.totals.shippingMinor === 0
                  ? t.wizard.free
                  : money(preview.totals.shippingMinor)
              }
            />
            <Row label={t.wizard.summaryVat} value={money(preview.totals.taxMinor)} muted />
            <Row label={t.wizard.summaryTotal} value={money(preview.totals.totalMinor)} strong />
          </dl>
          <p className="text-body text-ink-secondary">{t.wizard.cardOnly}</p>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={sendEmail}
              onChange={(e) => setSendEmail(e.target.checked)}
              className="size-5 accent-brand"
            />
            <span>{t.wizard.sendEmail}</span>
          </label>
        </div>
      )}

      {problem && (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {problem}
        </p>
      )}
      {pending && step !== 3 && (
        <p role="status" className="text-body text-ink-secondary">
          {t.wizard.loadingPreview}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {step > 0 && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setStep(step - 1)}
            disabled={pending}
          >
            {t.wizard.back}
          </Button>
        )}
        <Button type="submit" disabled={pending} data-offer-next>
          {step === 3 ? (pending ? t.wizard.creating : t.wizard.create) : t.wizard.next}
        </Button>
      </div>
    </form>
  );
}

function Row({
  label,
  value,
  strong,
  muted,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex justify-between ${strong ? "border-t border-line-subtle pt-2 font-semibold" : ""} ${muted ? "text-ink-secondary" : ""}`}
    >
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p role="alert" className="text-label text-tone-problem-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ProductsStep({
  base,
  lines,
  setLines,
  errors,
  clearError,
}: {
  base: string;
  lines: WizardLine[];
  setLines: (lines: WizardLine[]) => void;
  errors: Errors;
  clearError: (key: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OfferVariantOption[]>([]);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    const timer = setTimeout(async () => {
      setResults(await searchOfferProductsAction({ query }));
      setSearched(true);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const add = (option: OfferVariantOption) => {
    if (lines.some((line) => line.variantId === option.variantId)) return;
    setLines([
      ...lines,
      { variantId: option.variantId, sku: option.sku, title: option.title, quantity: "1" },
    ]);
    clearError("search");
    setQuery("");
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-ink-secondary">{t.wizard.productsHelp}</p>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${base}-search`}>{t.wizard.search}</Label>
        <Input
          id={`${base}-search`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.wizard.searchPlaceholder}
          autoComplete="off"
          aria-invalid={errors["search"] ? true : undefined}
        />
        {errors["search"] && (
          <p role="alert" className="text-label text-tone-problem-fg">
            {errors["search"]}
          </p>
        )}
      </div>
      {searched && results.length === 0 && <p>{t.wizard.noResults}</p>}
      {results.length > 0 && (
        <ul className="flex flex-col divide-y divide-line-subtle rounded-lg border border-line-subtle">
          {results.map((option) => (
            <li key={option.variantId} className="flex items-center justify-between gap-3 p-3">
              <span>
                {option.title} <span className="text-ink-secondary">({option.sku})</span>
              </span>
              <Button type="button" variant="outline" onClick={() => add(option)}>
                {t.wizard.add}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <ul className="flex flex-col gap-3">
          {lines.map((line, position) => (
            <li key={line.variantId} className="flex flex-wrap items-end gap-3">
              <span className="min-w-48 flex-1">
                {line.title} <span className="text-ink-secondary">({line.sku})</span>
              </span>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${base}-qty-${position}`}>{t.wizard.quantity}</Label>
                <Input
                  id={`${base}-qty-${position}`}
                  value={line.quantity}
                  inputMode="decimal"
                  className="w-28"
                  aria-invalid={errors[`qty-${position}`] ? true : undefined}
                  onChange={(e) =>
                    setLines(
                      lines.map((current, index) =>
                        index === position ? { ...current, quantity: e.target.value } : current,
                      ),
                    )
                  }
                />
                {errors[`qty-${position}`] && (
                  <p role="alert" className="text-label text-tone-problem-fg">
                    {errors[`qty-${position}`]}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => setLines(lines.filter((_, index) => index !== position))}
              >
                {t.wizard.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
