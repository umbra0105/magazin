"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Badge, Button, Dialog, Input } from "@ecom/ui";
import {
  deleteProductVariant,
  generateProductVariants,
  previewProductVariants,
  saveVariantFields,
} from "@/app/(admin)/admin/produse/editor-actions";
import { formatMoney, formatMoneyInput, parseMoneyInput } from "@/lib/money-input";
import type { ProductActionFailure } from "@/lib/product-action-support";
import { getMessages } from "@/messages";
import { describeFailure } from "./editor-support";
import type { EditorCaps, EditorOption, EditorVariant } from "./editor-types";
import { Field } from "./editor-ui";
import { buildVariantPatch, validatePricing, type PricingValues } from "./pricing-form";

const m = getMessages().admin.products;
const e = m.editor;
const v = e.variants;

interface VariantsContext {
  currency: string;
  locale: string;
  timezone: string;
}

interface PlanView {
  toCreate: { sku: string; selections: { option: string; value: string }[] }[];
  existing: number;
  orphaned: { variantId: string; sku: string; label: string }[];
  withoutOptions: number;
}

function failureText(result: ProductActionFailure): string {
  const errors = m.errors as Record<string, string>;
  return result.message ?? errors[result.code] ?? e.common.generic;
}

/**
 * Tabul Variante. Tabelul arată variantele (cu opțiunile lor) și se editează în rând: SKU, EAN,
 * garanție, preț, preț redus cu fereastră, greutate, cod producător (aceleași reguli ca la Prețuri:
 * lei cu cel mult 2 zecimale, redus ≤ întreg, fereastră validată; SKU-ul e unic, verificat pe server).
 * Generatorul compară opțiunile cu variantele existente și adaugă DOAR ce lipsește; ce nu mai
 * corespunde se raportează, nu se șterge: ștergerea e o acțiune explicită, cu confirmare. Prețul de
 * achiziție nu apare aici (panou de server, în tabul Prețuri). Cere `products.write`.
 */
export function VariantsTab({
  productId,
  variants,
  options,
  caps,
  context,
}: {
  productId: string;
  variants: readonly EditorVariant[];
  options: readonly EditorOption[];
  caps: EditorCaps;
  context: VariantsContext;
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<EditorVariant | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const editable = caps.canWrite;

  return (
    <div className="flex max-w-5xl flex-col gap-8">
      <section aria-labelledby="variants-heading" className="flex flex-col gap-3">
        <h2 id="variants-heading" className="text-lg font-semibold">
          {v.heading}
        </h2>
        <p className="text-sm text-muted-foreground">{v.help}</p>
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[42rem] text-sm">
            <caption className="sr-only">{v.tableLabel}</caption>
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="p-3 font-medium">
                  {v.columns.variant}
                </th>
                <th scope="col" className="p-3 font-medium">
                  {v.columns.sku}
                </th>
                <th scope="col" className="p-3 font-medium">
                  {v.columns.ean}
                </th>
                <th scope="col" className="p-3 font-medium">
                  {v.columns.price}
                </th>
                <th scope="col" className="p-3 font-medium">
                  {v.columns.sale}
                </th>
                <th scope="col" className="p-3 font-medium">
                  {v.columns.warranty}
                </th>
                {editable && (
                  <th scope="col" className="p-3 font-medium">
                    {v.columns.actions}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {variants.map((variant) =>
                editingId === variant.id ? (
                  <EditRow
                    key={variant.id}
                    variant={variant}
                    colSpan={editable ? 7 : 6}
                    context={context}
                    onCancel={() => setEditingId(null)}
                    onSaved={() => {
                      setStatus(v.saved(variant.sku));
                      setEditingId(null);
                      router.refresh();
                    }}
                  />
                ) : (
                  <tr
                    key={variant.id}
                    data-variant-row={variant.sku}
                    className="border-b border-border last:border-0"
                  >
                    <th scope="row" className="p-3 text-left font-normal">
                      <span className="flex flex-wrap items-center gap-2">
                        {variant.label || v.noOptions}
                        {variant.isDefault && <Badge>{v.defaultVariant}</Badge>}
                      </span>
                    </th>
                    <td className="p-3">{variant.sku}</td>
                    <td className="p-3">{variant.ean ?? "—"}</td>
                    <td className="p-3">
                      {formatMoney(variant.price, context.currency, context.locale)}
                    </td>
                    <td className="p-3">
                      {variant.salePrice === null
                        ? "—"
                        : formatMoney(variant.salePrice, context.currency, context.locale)}
                    </td>
                    <td className="p-3">{variant.warrantyMonths ?? "—"}</td>
                    {editable && (
                      <td className="p-3">
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            variant="outline"
                            aria-label={v.edit(variant.sku)}
                            onClick={() => {
                              setStatus(null);
                              setEditingId(variant.id);
                            }}
                          >
                            <Pencil aria-hidden className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            aria-label={v.delete(variant.sku)}
                            disabled={variants.length <= 1}
                            onClick={() => setDeleting(variant)}
                          >
                            <Trash2 aria-hidden className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </section>

      {editable && (
        <GeneratorPanel
          productId={productId}
          options={options}
          defaultPrice={variants[0]?.price ?? null}
          onGenerated={(message) => {
            setStatus(message);
            router.refresh();
          }}
        />
      )}

      {deleting && (
        <DeleteDialog
          variant={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setStatus(v.deleted(deleting.sku));
            setDeleting(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function EditRow({
  variant,
  colSpan,
  context,
  onCancel,
  onSaved,
}: {
  variant: EditorVariant;
  colSpan: number;
  context: VariantsContext;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const initial: PricingValues = {
    sku: variant.sku,
    price: formatMoneyInput(variant.price),
    salePrice: variant.salePrice === null ? "" : formatMoneyInput(variant.salePrice),
    saleStartsAt: variant.saleStartsAtLocal ?? "",
    saleEndsAt: variant.saleEndsAtLocal ?? "",
    ean: variant.ean ?? "",
    warrantyMonths: variant.warrantyMonths === null ? "" : String(variant.warrantyMonths),
    weightGrams: variant.weightGrams === null ? "" : String(variant.weightGrams),
    manufacturerPartNumber: variant.manufacturerPartNumber ?? "",
  };
  const [values, setValues] = useState<PricingValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const set = (key: keyof PricingValues, value: string) =>
    setValues((c) => ({ ...c, [key]: value }));
  const id = (name: string) => `variant-${variant.id}-${name}`;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const changed = Object.keys(initial).filter((k) => values[k] !== initial[k]);
    if (changed.length === 0) {
      onCancel();
      return;
    }
    const found = validatePricing(values, changed, {
      ...e.pricing,
      weightInvalid: v.weightInvalid,
    });
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setProblem(e.common.formError);
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    startTransition(async () => {
      try {
        const result = await saveVariantFields({
          variantId: variant.id,
          patch: buildVariantPatch(values, changed),
        });
        if (result.ok) {
          onSaved();
          return;
        }
        const view = describeFailure(result, m.errors, {
          generic: e.common.generic,
          formError: e.common.formError,
        });
        setErrors(view.fields);
        setProblem(view.form);
      } catch {
        setProblem(e.common.generic);
      }
    });
  };

  return (
    <tr data-variant-edit={variant.sku} className="border-b border-border bg-border/20">
      <td colSpan={colSpan} className="p-4">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <p className="text-sm font-medium">{v.edit(variant.sku)}</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={id("sku")} label={e.pricing.sku} error={errors["sku"]}>
              {(control) => (
                <Input
                  {...control}
                  value={values.sku}
                  onChange={(ev) => set("sku", ev.target.value)}
                  maxLength={64}
                />
              )}
            </Field>
            <Field id={id("ean")} label={e.pricing.ean} error={errors["ean"]}>
              {(control) => (
                <Input
                  {...control}
                  value={values.ean}
                  onChange={(ev) => set("ean", ev.target.value)}
                  inputMode="numeric"
                  maxLength={14}
                />
              )}
            </Field>
            <Field id={id("warranty")} label={v.columns.warranty} error={errors["warrantyMonths"]}>
              {(control) => (
                <Input
                  {...control}
                  value={values.warrantyMonths}
                  onChange={(ev) => set("warrantyMonths", ev.target.value)}
                  inputMode="numeric"
                  maxLength={3}
                />
              )}
            </Field>
            <Field id={id("price")} label={e.pricing.price} error={errors["price"]}>
              {(control) => (
                <Input
                  {...control}
                  value={values.price}
                  onChange={(ev) => set("price", ev.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                />
              )}
            </Field>
            <Field id={id("sale")} label={e.pricing.salePrice} error={errors["salePrice"]}>
              {(control) => (
                <Input
                  {...control}
                  value={values.salePrice}
                  onChange={(ev) => set("salePrice", ev.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                />
              )}
            </Field>
            <div className="hidden sm:block" />
            <Field
              id={id("starts")}
              label={e.pricing.saleStarts}
              help={e.pricing.saleWindowHelp(context.timezone)}
              error={errors["saleStartsAt"]}
            >
              {(control) => (
                <Input
                  {...control}
                  type="datetime-local"
                  value={values.saleStartsAt}
                  onChange={(ev) => set("saleStartsAt", ev.target.value)}
                />
              )}
            </Field>
            <Field id={id("ends")} label={e.pricing.saleEnds} error={errors["saleEndsAt"]}>
              {(control) => (
                <Input
                  {...control}
                  type="datetime-local"
                  value={values.saleEndsAt}
                  onChange={(ev) => set("saleEndsAt", ev.target.value)}
                />
              )}
            </Field>
            <div className="hidden sm:block" />
            <Field id={id("weight")} label={v.weight} error={errors["weightGrams"]}>
              {(control) => (
                <Input
                  {...control}
                  value={values.weightGrams ?? ""}
                  onChange={(ev) => set("weightGrams", ev.target.value)}
                  inputMode="numeric"
                />
              )}
            </Field>
            <Field id={id("mpn")} label={v.mpn} error={errors["manufacturerPartNumber"]}>
              {(control) => (
                <Input
                  {...control}
                  value={values.manufacturerPartNumber ?? ""}
                  onChange={(ev) => set("manufacturerPartNumber", ev.target.value)}
                  maxLength={100}
                />
              )}
            </Field>
          </div>
          {problem && (
            <p
              role="alert"
              data-problem
              className="rounded-md border border-danger p-3 text-sm text-danger"
            >
              {problem}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? e.common.saving : v.save}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel}>
              {v.cancel}
            </Button>
          </div>
        </form>
      </td>
    </tr>
  );
}

function GeneratorPanel({
  productId,
  options,
  defaultPrice,
  onGenerated,
}: {
  productId: string;
  options: readonly EditorOption[];
  defaultPrice: number | null;
  onGenerated: (message: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<{ name: string; values: string }[]>(
    options.length > 0
      ? options.map((o) => ({ name: o.name, values: o.values.join(", ") }))
      : [{ name: "", values: "" }],
  );
  const [price, setPrice] = useState(defaultPrice === null ? "" : formatMoneyInput(defaultPrice));
  const [baseSku, setBaseSku] = useState("");
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const parsedOptions = rows
    .map((row) => ({
      name: row.name.trim(),
      values: row.values
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    }))
    .filter((o) => o.name !== "" || o.values.length > 0);

  const touch = () => {
    setPlan(null);
    setProblem(null);
  };

  const preview = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (
      parsedOptions.length === 0 ||
      parsedOptions.some((o) => o.name === "" || o.values.length === 0)
    ) {
      setProblem(v.needOptions);
      return;
    }
    startTransition(async () => {
      try {
        const result = await previewProductVariants({
          id: productId,
          options: parsedOptions,
          baseSku,
        });
        if (result.ok) setPlan(result.plan);
        else setProblem(failureText(result));
      } catch {
        setProblem(e.common.generic);
      }
    });
  };

  const apply = () => {
    const bani = parseMoneyInput(price);
    if (bani === null) {
      setErrors({ price: v.priceInvalid });
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    setErrors({});
    setProblem(null);
    startTransition(async () => {
      try {
        const result = await generateProductVariants({
          id: productId,
          options: parsedOptions,
          price,
          baseSku,
        });
        if (result.ok) {
          setPlan(null);
          onGenerated(v.created(result.created));
        } else {
          setProblem(failureText(result));
        }
      } catch {
        setProblem(e.common.generic);
      }
    });
  };

  return (
    <section
      aria-labelledby="generator-heading"
      className="flex flex-col gap-4 rounded-md border border-border p-4"
    >
      <h2 id="generator-heading" className="text-lg font-semibold">
        {v.generator}
      </h2>
      <form onSubmit={preview} noValidate className="flex flex-col gap-4">
        {rows.map((row, index) => (
          <div key={index} className="grid items-end gap-3 sm:grid-cols-[1fr_2fr_auto]">
            <Field id={`opt-name-${index}`} label={`${v.option(index + 1)}: ${v.optionName}`}>
              {(control) => (
                <Input
                  {...control}
                  value={row.name}
                  placeholder={v.optionNameExample}
                  maxLength={100}
                  onChange={(ev) => {
                    touch();
                    setRows((c) =>
                      c.map((r, i) => (i === index ? { ...r, name: ev.target.value } : r)),
                    );
                  }}
                />
              )}
            </Field>
            <Field id={`opt-values-${index}`} label={`${v.option(index + 1)}: ${v.optionValues}`}>
              {(control) => (
                <Input
                  {...control}
                  value={row.values}
                  placeholder={v.optionValuesExample}
                  onChange={(ev) => {
                    touch();
                    setRows((c) =>
                      c.map((r, i) => (i === index ? { ...r, values: ev.target.value } : r)),
                    );
                  }}
                />
              )}
            </Field>
            {rows.length > 1 && (
              <Button
                type="button"
                variant="outline"
                aria-label={v.removeOption(index + 1)}
                onClick={() => {
                  touch();
                  setRows((c) => c.filter((_, i) => i !== index));
                }}
              >
                <Trash2 aria-hidden className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
        {rows.length < 3 && (
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                touch();
                setRows((c) => [...c, { name: "", values: "" }]);
              }}
            >
              {v.addOption}
            </Button>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="gen-price" label={v.basePrice} error={errors["price"]}>
            {(control) => (
              <Input
                {...control}
                value={price}
                inputMode="decimal"
                autoComplete="off"
                onChange={(ev) => {
                  setPrice(ev.target.value);
                  setErrors({});
                }}
              />
            )}
          </Field>
          <Field id="gen-sku" label={v.baseSku} help={v.baseSkuHelp}>
            {(control) => (
              <Input
                {...control}
                value={baseSku}
                maxLength={64}
                onChange={(ev) => {
                  touch();
                  setBaseSku(ev.target.value);
                }}
              />
            )}
          </Field>
        </div>
        <div>
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? v.previewing : v.preview}
          </Button>
        </div>
      </form>

      {problem && (
        <p
          role="alert"
          data-problem
          className="rounded-md border border-danger p-3 text-sm text-danger"
        >
          {problem}
        </p>
      )}

      {plan && (
        <div
          data-variant-plan
          className="flex flex-col gap-3 rounded-md border border-border bg-border/20 p-4"
        >
          <h3 className="text-base font-semibold">{v.planTitle}</h3>
          {plan.toCreate.length === 0 ? (
            <p className="text-sm">{v.planNothing}</p>
          ) : (
            <>
              <p className="text-sm font-medium">{v.planCreate(plan.toCreate.length)}</p>
              <ul className="list-inside list-disc text-sm">
                {plan.toCreate.map((item) => (
                  <li key={item.sku}>
                    <span className="font-medium">{item.sku}</span>{" "}
                    <span className="text-muted-foreground">
                      {item.selections.map((s) => `${s.option}: ${s.value}`).join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {plan.existing > 0 && <p className="text-sm">{v.planExisting(plan.existing)}</p>}
          {plan.withoutOptions > 0 && (
            <p className="text-sm">{v.planWithoutOptions(plan.withoutOptions)}</p>
          )}
          {plan.orphaned.length > 0 && (
            <div className="text-sm">
              <p>{v.planOrphans(plan.orphaned.length)}</p>
              <ul className="list-inside list-disc">
                {plan.orphaned.map((o) => (
                  <li key={o.variantId}>
                    {o.sku} <span className="text-muted-foreground">{o.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.toCreate.length > 0 && (
            <div>
              <Button type="button" disabled={pending} onClick={apply}>
                {pending ? v.applying : v.apply}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function DeleteDialog({
  variant,
  onClose,
  onDeleted,
}: {
  variant: EditorVariant;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={v.deleteTitle(variant.sku)}
      description={v.deleteDescription}
      closeLabel="Închide"
    >
      <div className="flex flex-col gap-4">
        {problem && (
          <p
            role="alert"
            data-problem
            className="rounded-md border border-danger p-3 text-sm text-danger"
          >
            {problem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {v.cancel}
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                try {
                  const result = await deleteProductVariant({ variantId: variant.id });
                  if (result.ok) onDeleted();
                  else setProblem(failureText(result));
                } catch {
                  setProblem(e.common.generic);
                }
              })
            }
          >
            {pending ? v.deleting : v.deleteConfirm}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
