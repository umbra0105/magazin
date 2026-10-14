"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Button, Input, Select, Textarea } from "@ecom/ui";
import { checkProductSlug, saveProductFields } from "@/app/(admin)/admin/produse/editor-actions";
import { getMessages } from "@/messages";
import { describeFailure, focusFirstInvalid } from "./editor-support";
import type { EditorCaps, EditorProduct, PickOption } from "./editor-types";
import { CheckField, Field, SaveBar } from "./editor-ui";
import { useTabForm } from "./use-tab-form";

const m = getMessages().admin.products;
const e = m.editor;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Tabul General: titlu, subtitlu, adresă, descriere (conținut: `products.content.write`) și stare,
 * brand, clasă de livrare, montaj, excluderea de la discountul de grup (`products.write`). Câmpurile
 * la care utilizatorul nu are drept sunt dezactivate, iar serverul le respinge oricum.
 */
export function GeneralTab({
  product,
  brands,
  caps,
}: {
  product: EditorProduct;
  brands: readonly PickOption[];
  caps: EditorCaps;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const form = useTabForm(
    {
      title: product.title,
      subtitle: product.subtitle ?? "",
      slug: product.slug,
      description: product.description ?? "",
      status: product.status,
      brandId: product.brandId ?? "",
      shippingClass: product.shippingClass,
      requiresInstallation: product.requiresInstallation,
      excludeFromGroupDiscount: product.excludeFromGroupDiscount,
    },
    "general",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [slugNote, setSlugNote] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const { values } = form;
  const content = caps.canContent;
  const restricted = caps.canWrite;
  const canSave = content || restricted;

  const validate = (): Record<string, string> => {
    const found: Record<string, string> = {};
    if (form.changed.includes("title") && values.title.trim() === "") {
      found["title"] = e.general.titleRequired;
    }
    if (
      form.changed.includes("slug") &&
      values.slug.trim() !== "" &&
      !SLUG_PATTERN.test(values.slug.trim())
    ) {
      found["slug"] = e.general.slugInvalid;
    }
    return found;
  };

  const buildPatch = (): Record<string, unknown> => {
    const patch: Record<string, unknown> = {};
    for (const key of form.changed) {
      const value = values[key];
      if (key === "brandId") patch["brandId"] = value === "" ? null : value;
      else if (key === "subtitle" || key === "description")
        patch[key] = value === "" ? null : value;
      else if (key === "title" || key === "slug") patch[key] = String(value).trim();
      else patch[key] = value;
    }
    return patch;
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
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setProblem(e.common.formError);
      focusFirstInvalid();
      return;
    }
    startTransition(async () => {
      try {
        const result = await saveProductFields({ id: product.id, patch: buildPatch() });
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

  const checkSlug = async () => {
    setChecking(true);
    setSlugNote(null);
    try {
      const result = await checkProductSlug({ slug: values.slug.trim(), excludeId: product.id });
      if (result.ok) {
        if (result.available) setSlugNote(e.general.slugCheck + ": OK");
        else setErrors((c) => ({ ...c, slug: result.message ?? e.general.slugInvalid }));
      }
    } catch {
      setProblem(e.common.generic);
    } finally {
      setChecking(false);
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex max-w-3xl flex-col gap-5">
      <Field id="product-title" label={e.general.title} error={errors["title"]}>
        {(control) => (
          <Input
            {...control}
            value={values.title}
            onChange={(ev) => form.set("title", ev.target.value)}
            maxLength={200}
            required
            disabled={!content}
          />
        )}
      </Field>

      <Field id="product-subtitle" label={e.general.subtitle} error={errors["subtitle"]}>
        {(control) => (
          <Input
            {...control}
            value={values.subtitle}
            onChange={(ev) => form.set("subtitle", ev.target.value)}
            maxLength={300}
            disabled={!content}
          />
        )}
      </Field>

      <div className="flex flex-col gap-2">
        <Field
          id="product-slug"
          label={e.general.slug}
          help={e.general.slugHelp}
          error={errors["slug"]}
        >
          {(control) => (
            <Input
              {...control}
              value={values.slug}
              onChange={(ev) => {
                setSlugNote(null);
                form.set("slug", ev.target.value);
              }}
              maxLength={200}
              disabled={!content}
            />
          )}
        </Field>
        {content && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={checking || values.slug.trim() === ""}
              onClick={() => void checkSlug()}
            >
              {checking ? e.general.slugChecking : e.general.slugCheck}
            </Button>
            <span role="status" className="text-sm text-muted-foreground">
              {slugNote}
            </span>
          </div>
        )}
      </div>

      <Field
        id="product-description"
        label={e.general.description}
        help={e.general.descriptionHelp}
        error={errors["description"]}
      >
        {(control) => (
          <Textarea
            {...control}
            value={values.description}
            onChange={(ev) => form.set("description", ev.target.value)}
            rows={10}
            disabled={!content}
          />
        )}
      </Field>

      <fieldset className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-medium">{m.table.status}</legend>
        <Field
          id="product-status"
          label={e.general.status}
          help={e.general.statusHelp}
          error={errors["status"]}
        >
          {(control) => (
            <Select
              {...control}
              value={values.status}
              onChange={(ev) => form.set("status", ev.target.value)}
              disabled={!restricted}
            >
              {Object.entries(m.statuses).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="product-brand" label={e.general.brand} error={errors["brandId"]}>
          {(control) => (
            <Select
              {...control}
              value={values.brandId}
              onChange={(ev) => form.set("brandId", ev.target.value)}
              disabled={!restricted}
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
        <Field id="product-shipping" label={e.general.shipping} error={errors["shippingClass"]}>
          {(control) => (
            <Select
              {...control}
              value={values.shippingClass}
              onChange={(ev) => form.set("shippingClass", ev.target.value)}
              disabled={!restricted}
            >
              {Object.entries(m.shipping).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex flex-col gap-3 sm:col-span-2">
          <CheckField
            id="product-installation"
            label={e.general.requiresInstallation}
            checked={values.requiresInstallation}
            disabled={!restricted}
            onChange={(v) => form.set("requiresInstallation", v)}
          />
          <CheckField
            id="product-exclude-group"
            label={e.general.excludeFromGroupDiscount}
            checked={values.excludeFromGroupDiscount}
            disabled={!restricted}
            onChange={(v) => form.set("excludeFromGroupDiscount", v)}
          />
        </div>
      </fieldset>

      {!canSave && <p className="text-sm text-muted-foreground">{e.common.readOnlyTab}</p>}
      <SaveBar
        pending={pending}
        canSave={canSave}
        dirty={form.dirty}
        status={status}
        problem={problem}
        labels={{ ...e.common, unsavedMark: e.unsavedMark }}
      />
    </form>
  );
}
