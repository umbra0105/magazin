"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { Select, Input } from "@ecom/ui";
import { saveProductFields, saveVariantFields } from "@/app/(admin)/admin/produse/editor-actions";
import { daysText } from "@/lib/stock-view";
import { getMessages } from "@/messages";
import { describeFailure, focusFirstInvalid } from "./editor-support";
import type { EditorCaps, EditorProduct, EditorVariant } from "./editor-types";
import { CheckField, Field, SaveBar } from "./editor-ui";
import {
  buildProductStockPatch,
  buildVariantStockPatch,
  effectiveLeadTime,
  effectiveManage,
  manageChoice,
  parseLeadTimeInput,
  type LeadTimeContext,
  type StockTexts,
  type VariantManage,
} from "./stock-form";
import { useTabForm } from "./use-tab-form";

const m = getMessages().admin.products;
const e = m.editor;
const t = e.stock;

const STOCK_TEXTS: StockTexts = {
  leadTimeInvalid: t.errors.leadTimeInvalid,
  leadTimeTooLong: t.errors.leadTimeTooLong,
  labelTooLong: "",
};

const STATUS_OPTIONS = ["instock", "outofstock", "onbackorder"] as const;

/** Cheia unui câmp de variantă în formular: `<id variantă>:<manage|status>` (id-urile nu conțin «:»). */
const variantKey = (variantId: string, field: "manage" | "status") => `${variantId}:${field}`;

/**
 * Tabul Stoc al produsului (Faza 5, punctul 9a): gestiunea (bifa suprascrie setarea magazinului), disponibilitatea la
 * negestionate, hibridul «La comandă» la epuizare, termenul de livrare propriu (cu ce se aplică acum), suprascrierile pe
 * variantă și, dedesubt, cantitățile pe variante (componentă de server, cu «Ajustează» și «Istoric»). Modificările cer
 * `products.write` (verificat pe server); cantitățile cer `inventory.read`. Produsul digital nu are stoc.
 */
export function StockTab({
  product,
  variants,
  caps,
  storeManagesStock,
  leadTime,
  quantitiesSlot,
}: {
  product: EditorProduct;
  variants: readonly EditorVariant[];
  caps: EditorCaps;
  storeManagesStock: boolean;
  leadTime: LeadTimeContext;
  quantitiesSlot: ReactNode;
}) {
  if (product.type === "digital") {
    return (
      <div className="flex max-w-3xl flex-col gap-3">
        <h2 className="text-lg font-semibold">{t.heading}</h2>
        <p
          role="note"
          data-stock-digital
          className="rounded-md border border-border bg-border/30 p-3 text-sm"
        >
          {t.digital}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <ProductStockForm
        product={product}
        caps={caps}
        storeManagesStock={storeManagesStock}
        leadTime={leadTime}
      />
      {variants.length > 1 && (
        <VariantStockForm product={product} variants={variants} caps={caps} />
      )}
      {quantitiesSlot}
    </div>
  );
}

function ProductStockForm({
  product,
  caps,
  storeManagesStock,
  leadTime,
}: {
  product: EditorProduct;
  caps: EditorCaps;
  storeManagesStock: boolean;
  leadTime: LeadTimeContext;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const form = useTabForm(
    {
      manageStock: product.manageStock,
      stockStatus: product.stockStatus,
      allowBackorder: product.allowBackorder,
      leadTimeDays: product.leadTimeDays === null ? "" : String(product.leadTimeDays),
    },
    "stock",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const editable = caps.canWrite;

  const lead = parseLeadTimeInput(form.values.leadTimeDays, STOCK_TEXTS);
  const effective = effectiveLeadTime(lead.ok ? lead.value : product.leadTimeDays, leadTime);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);
    setProblem(null);
    if (!form.dirty) {
      setStatus(e.common.unchanged);
      return;
    }
    const built = buildProductStockPatch(form.values, form.changed, STOCK_TEXTS);
    if (!built.ok) {
      setErrors(built.errors);
      setProblem(e.common.formError);
      focusFirstInvalid();
      return;
    }
    setErrors({});
    startTransition(async () => {
      try {
        const result = await saveProductFields({ id: product.id, patch: built.patch });
        if (result.ok) {
          form.commit();
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
    <form
      onSubmit={onSubmit}
      noValidate
      data-stock-form="product"
      className="flex max-w-3xl flex-col gap-5"
    >
      <h2 className="text-lg font-semibold">{t.heading}</h2>
      <CheckField
        id="stock-manage"
        label={t.manageStock}
        help={t.manageHelp(storeManagesStock)}
        checked={form.values.manageStock}
        disabled={!editable}
        onChange={(v) => form.set("manageStock", v)}
      />

      {form.values.manageStock ? (
        <>
          <p role="note" className="rounded-md border border-border bg-border/30 p-3 text-sm">
            {t.statusManagedNote}
          </p>
          <CheckField
            id="stock-backorder"
            label={t.allowBackorder}
            help={t.allowBackorderHelp}
            checked={form.values.allowBackorder}
            disabled={!editable}
            onChange={(v) => form.set("allowBackorder", v)}
          />
        </>
      ) : (
        <>
          <p
            role="note"
            data-stock-unmanaged
            className="rounded-md border border-border bg-border/30 p-3 text-sm"
          >
            {t.unmanagedNote}
          </p>
          <Field
            id="stock-status"
            label={t.stockStatus}
            help={t.stockStatusHelp}
            error={errors["stockStatus"]}
          >
            {(control) => (
              <Select
                {...control}
                value={form.values.stockStatus}
                onChange={(ev) => form.set("stockStatus", ev.target.value)}
                disabled={!editable}
              >
                {STATUS_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {m.stock[value]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </>
      )}

      <Field
        id="stock-lead-time"
        label={t.leadTime}
        help={t.leadTimeHelp}
        error={errors["leadTimeDays"]}
      >
        {(control) => (
          <Input
            {...control}
            value={form.values.leadTimeDays}
            onChange={(ev) => form.set("leadTimeDays", ev.target.value)}
            inputMode="numeric"
            autoComplete="off"
            disabled={!editable}
          />
        )}
      </Field>
      <p data-stock-lead-now className="-mt-3 text-sm text-muted-foreground">
        {t.leadTimeNow(daysText(effective.days), effective.origin, effective.brandName)}
      </p>

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

function VariantStockForm({
  product,
  variants,
  caps,
}: {
  product: EditorProduct;
  variants: readonly EditorVariant[];
  caps: EditorCaps;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const initial: Record<string, string> = {};
  for (const v of variants) {
    initial[variantKey(v.id, "manage")] = manageChoice(v.manageStock);
    initial[variantKey(v.id, "status")] = v.stockStatus ?? "";
  }
  const form = useTabForm(initial, "stock-variants");
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const editable = caps.canWrite;
  const v = t.variants;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);
    setProblem(null);
    setFailed({});
    if (!form.dirty) {
      setStatus(e.common.unchanged);
      return;
    }
    const targets = variants
      .map((variant) => {
        const fields = (["manage", "status"] as const).filter((field) =>
          form.changed.includes(variantKey(variant.id, field)),
        );
        return { variant, fields };
      })
      .filter((entry) => entry.fields.length > 0);

    startTransition(async () => {
      let done = 0;
      const problems: Record<string, string> = {};
      const saved: Record<string, string> = {};
      for (const { variant, fields } of targets) {
        const patch = buildVariantStockPatch(
          {
            manage: form.values[variantKey(variant.id, "manage")] as VariantManage,
            status: form.values[variantKey(variant.id, "status")] ?? "",
          },
          fields,
        );
        try {
          const result = await saveVariantFields({ variantId: variant.id, patch });
          if (result.ok) {
            done += 1;
            for (const field of fields) {
              const key = variantKey(variant.id, field);
              saved[key] = form.values[key] ?? "";
            }
          } else {
            const view = describeFailure(result, m.errors, {
              generic: e.common.generic,
              formError: e.common.formError,
            });
            problems[variant.id] = view.form ?? e.common.generic;
          }
        } catch {
          problems[variant.id] = e.common.generic;
        }
      }
      // ce s-a salvat devine valoare de bază; rândurile cu eroare rămân modificate
      form.commit({ ...form.baseline, ...saved });
      setFailed(problems);
      if (Object.keys(problems).length === 0) {
        setStatus(v.saved);
        router.refresh();
      } else {
        setProblem(v.partial(done, targets.length));
        if (done > 0) router.refresh();
      }
    });
  };

  const productStatusLabel = m.stock[product.stockStatus as (typeof STATUS_OPTIONS)[number]];

  return (
    <form onSubmit={onSubmit} noValidate data-stock-form="variants" className="flex flex-col gap-4">
      <div>
        <h3 className="text-base font-semibold">{v.heading}</h3>
        <p className="text-sm text-muted-foreground">{v.help}</p>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="border-b border-border bg-border/30">
            <tr>
              <th scope="col" className="p-3 font-medium">
                {v.variant}
              </th>
              <th scope="col" className="p-3 font-medium">
                {v.manage}
              </th>
              <th scope="col" className="p-3 font-medium">
                {v.status}
              </th>
            </tr>
          </thead>
          <tbody>
            {variants.map((variant) => {
              const manage = (form.values[variantKey(variant.id, "manage")] ??
                "inherit") as VariantManage;
              const manageId = `stock-variant-manage-${variant.id}`;
              const statusId = `stock-variant-status-${variant.id}`;
              const managed = effectiveManage(product.manageStock, manage);
              const name = variant.label ? `${variant.sku} (${variant.label})` : variant.sku;
              return (
                <tr
                  key={variant.id}
                  data-variant-stock-row={variant.sku}
                  className="border-t border-border/60"
                >
                  <th scope="row" className="p-3 align-top font-normal">
                    <span className="font-medium">{variant.sku}</span>
                    {variant.label && (
                      <span className="block text-muted-foreground">{variant.label}</span>
                    )}
                    {failed[variant.id] && (
                      <span data-problem className="block text-sm text-danger">
                        {failed[variant.id]}
                      </span>
                    )}
                  </th>
                  <td className="p-3 align-top">
                    <Select
                      id={manageId}
                      aria-label={v.aria(name, v.manage)}
                      value={manage}
                      onChange={(ev) => form.set(variantKey(variant.id, "manage"), ev.target.value)}
                      disabled={!editable}
                    >
                      <option value="inherit">{v.inherit(product.manageStock)}</option>
                      <option value="managed">{v.managed}</option>
                      <option value="unmanaged">{v.unmanaged}</option>
                    </Select>
                  </td>
                  <td className="p-3 align-top">
                    <Select
                      id={statusId}
                      aria-label={v.aria(name, v.status)}
                      value={form.values[variantKey(variant.id, "status")] ?? ""}
                      onChange={(ev) => form.set(variantKey(variant.id, "status"), ev.target.value)}
                      disabled={!editable || managed}
                    >
                      <option value="">{v.inheritStatus(productStatusLabel ?? "")}</option>
                      {STATUS_OPTIONS.map((value) => (
                        <option key={value} value={value}>
                          {m.stock[value]}
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SaveBar
        pending={pending}
        canSave={editable}
        dirty={form.dirty}
        status={status}
        problem={problem}
        labels={{ save: v.save, saving: e.common.saving, unsavedMark: e.unsavedMark }}
      />
    </form>
  );
}
