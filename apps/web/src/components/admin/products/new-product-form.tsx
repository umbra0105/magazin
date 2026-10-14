"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Button, Input, Select } from "@ecom/ui";
import { createProduct } from "@/app/(admin)/admin/produse/editor-actions";
import { parseMoneyInput } from "@/lib/money-input";
import { getMessages } from "@/messages";
import { describeFailure, focusFirstInvalid } from "./editor-support";
import type { PickOption } from "./editor-types";
import { Field } from "./editor-ui";
import { UnsavedChangesProvider } from "./unsaved-changes";
import { useTabForm } from "./use-tab-form";

const m = getMessages().admin.products;
const e = m.editor;

/**
 * Crearea rapidă a unui produs: titlu, SKU, preț (cu TVA, în lei), brand, categorie, clasă de
 * livrare. Produsul se creează cu o variantă, ca ciornă, iar categoria se leagă în aceeași
 * tranzacție; apoi te duce în editor pentru restul. Cere `products.write` (verificat pe server).
 */
export function NewProductForm({
  brands,
  categories,
}: {
  brands: readonly PickOption[];
  categories: readonly PickOption[];
}) {
  return (
    <UnsavedChangesProvider message={e.unsavedConfirm}>
      <Form brands={brands} categories={categories} />
    </UnsavedChangesProvider>
  );
}

function Form({
  brands,
  categories,
}: {
  brands: readonly PickOption[];
  categories: readonly PickOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const form = useTabForm(
    { title: "", sku: "", price: "", brandId: "", categoryId: "", shippingClass: "standard" },
    "create",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const { values } = form;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const found: Record<string, string> = {};
    if (values.title.trim() === "") found["title"] = m.editor.general.titleRequired;
    if (values.sku.trim() === "") found["sku"] = e.pricing.skuRequired;
    const price = parseMoneyInput(values.price);
    if (price === null) found["price"] = e.pricing.priceInvalid;
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setProblem(e.common.formError);
      focusFirstInvalid();
      return;
    }
    startTransition(async () => {
      try {
        const result = await createProduct({
          title: values.title.trim(),
          shippingClass: values.shippingClass,
          ...(values.brandId && { brandId: values.brandId }),
          ...(values.categoryId && { categoryIds: [values.categoryId] }),
          variants: [{ sku: values.sku.trim(), price }],
        });
        if (result.ok) {
          setCreated(true);
          router.push(`/admin/produse/${result.id}?created=1`);
          return;
        }
        const view = describeFailure(result, m.errors, {
          generic: e.common.generic,
          formError: e.common.formError,
        });
        // erorile pe variante vin ca „variants.0.sku” / „variants.0.price”
        const fields: Record<string, string> = {};
        for (const [key, text] of Object.entries(view.fields)) {
          fields[key.replace(/^variants\.0\./, "")] = text;
        }
        setErrors(fields);
        setProblem(view.form);
        focusFirstInvalid();
      } catch {
        setProblem(e.common.generic);
      }
    });
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex max-w-2xl flex-col gap-5">
      <Field id="new-title" label={e.create.title} error={errors["title"]}>
        {(control) => (
          <Input
            {...control}
            value={values.title}
            onChange={(ev) => form.set("title", ev.target.value)}
            maxLength={200}
            required
            autoFocus
          />
        )}
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="new-sku" label={e.create.sku} error={errors["sku"]}>
          {(control) => (
            <Input
              {...control}
              value={values.sku}
              onChange={(ev) => form.set("sku", ev.target.value)}
              maxLength={64}
              required
            />
          )}
        </Field>
        <Field
          id="new-price"
          label={e.create.price}
          help={e.pricing.priceHelp}
          error={errors["price"]}
        >
          {(control) => (
            <Input
              {...control}
              value={values.price}
              onChange={(ev) => form.set("price", ev.target.value)}
              inputMode="decimal"
              autoComplete="off"
              required
            />
          )}
        </Field>
        <Field id="new-brand" label={e.create.brand} error={errors["brandId"]}>
          {(control) => (
            <Select
              {...control}
              value={values.brandId}
              onChange={(ev) => form.set("brandId", ev.target.value)}
            >
              <option value="">{e.general.noBrand}</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="new-category" label={e.create.category} error={errors["categoryIds"]}>
          {(control) => (
            <Select
              {...control}
              value={values.categoryId}
              onChange={(ev) => form.set("categoryId", ev.target.value)}
            >
              <option value="">{e.common.none}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="new-shipping" label={e.create.shipping} error={errors["shippingClass"]}>
          {(control) => (
            <Select
              {...control}
              value={values.shippingClass}
              onChange={(ev) => form.set("shippingClass", ev.target.value)}
            >
              {Object.entries(m.shipping).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </Select>
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
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending || created}>
          {pending || created ? e.create.submitting : e.create.submit}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.push("/admin/produse")}>
          {e.create.cancel}
        </Button>
      </div>
    </form>
  );
}
