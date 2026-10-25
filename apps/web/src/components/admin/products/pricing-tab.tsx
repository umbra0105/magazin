"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { netFromGross } from "@ecom/shared/vat";
import { Input } from "@ecom/ui";
import { saveVariantFields } from "@/app/(admin)/admin/produse/editor-actions";
import { formatMoney, formatMoneyInput, parseMoneyInput } from "@/lib/money-input";
import { getMessages } from "@/messages";
import { describeFailure, focusFirstInvalid } from "./editor-support";
import type { EditorCaps, EditorVariant } from "./editor-types";
import { Field, SaveBar } from "./editor-ui";
import { buildVariantPatch, validatePricing } from "./pricing-form";
import {
  previewVariantPrice,
  type PreviewProduct,
  type PreviewUnit,
  type PreviewVariant,
} from "./price-preview";
import { useTabForm } from "./use-tab-form";

const m = getMessages().admin.products;
const e = m.editor;
const pd = getMessages().admin.priceDisplay;

interface PricingContext {
  /** Cota TVA în puncte de bază (din `tax.standardRate`). */
  vatRateBps: number;
  /** Cota în procente, pentru afișare (ex. „21”). */
  vatRateLabel: string;
  currency: string;
  locale: string;
  timezone: string;
  defaultWarrantyMonths: number;
}

/**
 * Tabul Prețuri. La un produs cu O SINGURĂ variantă: preț, preț redus cu fereastră de date, SKU, EAN,
 * garanție, cu previzualizarea prețului fără TVA (cota din setări). Prețul se introduce în lei cu cel
 * mult 2 zecimale și se convertește în bani fără `float`. La mai multe variante: doar tabel de
 * citire (prețurile se editează pe variante, în tabul Variante).
 *
 * `purchaseSlot` e panoul prețului de achiziție, randat pe SERVER și predat aici ca nod gata făcut
 * (fără props cu valori): apare doar cine are `products.cost.view`.
 */
export function PricingTab({
  variants,
  caps,
  context,
  sale,
  purchaseSlot,
}: {
  variants: readonly EditorVariant[];
  caps: EditorCaps;
  context: PricingContext;
  /** Produsul și unitățile, pentru «Cum se afișează prețul» (valorile efective ale fiecărei variante) */
  sale: SaleContext;
  purchaseSlot: ReactNode;
}) {
  const single = variants.length === 1 ? variants[0] : undefined;

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <section aria-labelledby="pricing-heading" className="flex flex-col gap-4">
        <h2 id="pricing-heading" className="text-lg font-semibold">
          {e.pricing.heading}
        </h2>
        <p className="text-sm text-muted-foreground">{e.pricing.vatRate(context.vatRateLabel)}</p>
        {single ? (
          <SingleVariantForm variant={single} caps={caps} context={context} sale={sale} />
        ) : (
          <VariantsTable variants={variants} context={context} sale={sale} />
        )}
      </section>
      {purchaseSlot}
    </div>
  );
}

function VariantsTable({
  variants,
  context,
  sale,
}: {
  variants: readonly EditorVariant[];
  context: PricingContext;
  sale: SaleContext;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p role="note" className="rounded-md border border-border bg-border/30 p-3 text-sm">
        {e.pricing.multiVariant(variants.length)}
      </p>
      <table className="w-full text-sm">
        <caption className="sr-only">{e.pricing.variantsTable}</caption>
        <thead>
          <tr className="border-b border-border text-left">
            <th scope="col" className="py-2 pr-4 font-medium">
              {e.pricing.variantSku}
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              {e.pricing.variantPrice}
            </th>
            <th scope="col" className="py-2 font-medium">
              {e.pricing.variantSale}
            </th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v) => (
            <tr key={v.id} className="border-b border-border">
              <th scope="row" className="py-2 pr-4 text-left font-normal">
                {v.sku}
              </th>
              <td className="py-2 pr-4">
                {formatMoney(v.price, context.currency, context.locale)}
              </td>
              <td className="py-2">
                {v.salePrice === null
                  ? "—"
                  : formatMoney(v.salePrice, context.currency, context.locale)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <PricePreview
        rows={variants.map((v) => ({ key: v.id, sku: v.sku, variant: v }))}
        sale={sale}
        context={context}
      />
    </div>
  );
}

/** Produsul și unitățile, pentru valorile efective ale prețului pe unitate și pe pas. */
interface SaleContext {
  product: PreviewProduct;
  units: readonly PreviewUnit[];
}

/**
 * «Cum se afișează prețul»: prețul întreg și cel redus, cu unitatea și pasul EFECTIVE ale fiecărei variante (varianta peste
 * produs), pe unitate și pe pas. Afișare PROVIZORIE, doar informativă; «≈» înseamnă că suma nu iese exactă în bani.
 */
function PricePreview({
  rows,
  sale,
  context,
}: {
  rows: readonly { key: string; sku: string | null; variant: PreviewVariant }[];
  sale: SaleContext;
  context: PricingContext;
}) {
  const format = { currency: context.currency, locale: context.locale };
  return (
    <section
      aria-labelledby="price-preview-heading"
      data-price-preview
      className="flex flex-col gap-2 rounded-md border border-border bg-border/20 p-3 text-sm"
    >
      <h3 id="price-preview-heading" className="font-medium">
        {pd.heading}
      </h3>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const out = previewVariantPrice(row.variant, sale.product, sale.units, format);
          return (
            <li key={row.key} data-preview-row={row.sku ?? undefined} className="flex flex-col">
              {row.sku && <span className="text-muted-foreground">{pd.forVariant(row.sku)}</span>}
              <span data-preview-price>
                {out.price.reference}
                {out.price.perUnit && (
                  <span className="ml-1 text-muted-foreground">{out.price.perUnit}</span>
                )}
              </span>
              {out.price.stepPrice && (
                <span className="text-muted-foreground" data-preview-step>
                  {out.price.stepPrice}
                </span>
              )}
              {out.sale && (
                <span data-preview-sale>
                  {pd.saleLabel}: {out.sale.reference}
                  {out.sale.perUnit && (
                    <span className="ml-1 text-muted-foreground">{out.sale.perUnit}</span>
                  )}
                  {out.sale.stepPrice && (
                    <span className="block text-muted-foreground">{out.sale.stepPrice}</span>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground" data-price-provisional>
        {pd.provisional}
      </p>
    </section>
  );
}

function SingleVariantForm({
  variant,
  caps,
  context,
  sale,
}: {
  variant: EditorVariant;
  caps: EditorCaps;
  context: PricingContext;
  sale: SaleContext;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const form = useTabForm(
    {
      sku: variant.sku,
      price: formatMoneyInput(variant.price),
      salePrice: variant.salePrice === null ? "" : formatMoneyInput(variant.salePrice),
      saleStartsAt: variant.saleStartsAtLocal ?? "",
      saleEndsAt: variant.saleEndsAtLocal ?? "",
      ean: variant.ean ?? "",
      warrantyMonths: variant.warrantyMonths === null ? "" : String(variant.warrantyMonths),
    },
    "pricing",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const { values } = form;
  const editable = caps.canWrite;

  const preview = (raw: string): string | null => {
    const bani = parseMoneyInput(raw);
    if (bani === null) return null;
    return e.pricing.vatPreview(
      formatMoney(netFromGross(bani, context.vatRateBps), context.currency, context.locale),
      context.vatRateLabel,
    );
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);
    setProblem(null);
    if (!form.dirty) {
      setErrors({});
      setStatus(e.common.unchanged);
      return;
    }
    const found = validatePricing(values, form.changed, e.pricing);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setProblem(e.common.formError);
      focusFirstInvalid();
      return;
    }
    startTransition(async () => {
      try {
        const result = await saveVariantFields({
          variantId: variant.id,
          patch: buildVariantPatch(values, form.changed),
        });
        if (result.ok) {
          form.commit();
          setErrors({});
          setStatus(e.common.saved);
          router.refresh();
          return;
        }
        const view = describeFailure(result, m.errors, {
          generic: e.common.generic,
          formError: e.common.formError,
        });
        setErrors(view.fields);
        setProblem(view.form);
        focusFirstInvalid();
      } catch {
        setProblem(e.common.generic);
      }
    });
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="variant-sku" label={e.pricing.sku} error={errors["sku"]}>
          {(control) => (
            <Input
              {...control}
              value={values.sku}
              onChange={(ev) => form.set("sku", ev.target.value)}
              maxLength={64}
              disabled={!editable}
            />
          )}
        </Field>
        <Field id="variant-ean" label={e.pricing.ean} error={errors["ean"]}>
          {(control) => (
            <Input
              {...control}
              value={values.ean}
              onChange={(ev) => form.set("ean", ev.target.value)}
              inputMode="numeric"
              maxLength={14}
              disabled={!editable}
            />
          )}
        </Field>
        <Field
          id="variant-price"
          label={e.pricing.price}
          help={[e.pricing.priceHelp, preview(values.price)].filter(Boolean).join(" ")}
          error={errors["price"]}
        >
          {(control) => (
            <Input
              {...control}
              value={values.price}
              onChange={(ev) => form.set("price", ev.target.value)}
              inputMode="decimal"
              autoComplete="off"
              disabled={!editable}
            />
          )}
        </Field>
        <Field
          id="variant-sale-price"
          label={e.pricing.salePrice}
          help={[e.pricing.salePriceHelp, values.salePrice ? preview(values.salePrice) : null]
            .filter(Boolean)
            .join(" ")}
          error={errors["salePrice"]}
        >
          {(control) => (
            <Input
              {...control}
              value={values.salePrice}
              onChange={(ev) => form.set("salePrice", ev.target.value)}
              inputMode="decimal"
              autoComplete="off"
              disabled={!editable}
            />
          )}
        </Field>
        <Field
          id="variant-sale-starts"
          label={e.pricing.saleStarts}
          help={e.pricing.saleWindowHelp(context.timezone)}
          error={errors["saleStartsAt"]}
        >
          {(control) => (
            <Input
              {...control}
              type="datetime-local"
              value={values.saleStartsAt}
              onChange={(ev) => form.set("saleStartsAt", ev.target.value)}
              disabled={!editable}
            />
          )}
        </Field>
        <Field id="variant-sale-ends" label={e.pricing.saleEnds} error={errors["saleEndsAt"]}>
          {(control) => (
            <Input
              {...control}
              type="datetime-local"
              value={values.saleEndsAt}
              onChange={(ev) => form.set("saleEndsAt", ev.target.value)}
              disabled={!editable}
            />
          )}
        </Field>
        <Field
          id="variant-warranty"
          label={e.pricing.warranty}
          help={e.pricing.warrantyHelp(String(context.defaultWarrantyMonths))}
          error={errors["warrantyMonths"]}
        >
          {(control) => (
            <Input
              {...control}
              value={values.warrantyMonths}
              onChange={(ev) => form.set("warrantyMonths", ev.target.value)}
              inputMode="numeric"
              maxLength={3}
              disabled={!editable}
            />
          )}
        </Field>
      </div>

      <PricePreview
        rows={[
          {
            key: variant.id,
            sku: null,
            variant: {
              ...variant,
              // în timp ce scrii: previzualizarea urmărește câmpurile (o valoare încă neterminată păstrează ultimul preț valid)
              price: parseMoneyInput(values.price) ?? variant.price,
              salePrice:
                values.salePrice.trim() === ""
                  ? null
                  : (parseMoneyInput(values.salePrice) ?? variant.salePrice),
            },
          },
        ]}
        sale={sale}
        context={context}
      />

      {!editable && <p className="text-sm text-muted-foreground">{e.common.readOnlyTab}</p>}
      <SaveBar
        pending={pending}
        canSave={editable}
        dirty={form.dirty}
        status={status}
        problem={problem}
        labels={{ ...e.common, unsavedMark: e.unsavedMark }}
      />
    </form>
  );
}
