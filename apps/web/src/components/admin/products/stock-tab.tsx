"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Select } from "@ecom/ui";
import { saveProductFields } from "@/app/(admin)/admin/produse/editor-actions";
import { getMessages } from "@/messages";
import { describeFailure, focusFirstInvalid } from "./editor-support";
import type { EditorCaps, EditorProduct } from "./editor-types";
import { CheckField, Field, SaveBar } from "./editor-ui";
import { useTabForm } from "./use-tab-form";

const m = getMessages().admin.products;
const e = m.editor;

/**
 * Tabul Stoc: bifa `manageStock` (suprascrie setarea magazinului) și starea de disponibilitate
 * (`stockStatus`), folosită când gestiunea e oprită. Cantitățile reale vin cu modulul Stoc; aici nu
 * se simulează cu cantități mari. Modificarea cere `products.write`.
 */
export function StockTab({
  product,
  caps,
  storeManagesStock,
}: {
  product: EditorProduct;
  caps: EditorCaps;
  storeManagesStock: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const form = useTabForm(
    { manageStock: product.manageStock, stockStatus: product.stockStatus },
    "stock",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const editable = caps.canWrite;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);
    setProblem(null);
    if (!form.dirty) {
      setStatus(e.common.unchanged);
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const key of form.changed) patch[key] = form.values[key];
    startTransition(async () => {
      try {
        const result = await saveProductFields({ id: product.id, patch });
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
    <form onSubmit={onSubmit} noValidate className="flex max-w-3xl flex-col gap-5">
      <h2 className="text-lg font-semibold">{e.stock.heading}</h2>
      <CheckField
        id="stock-manage"
        label={e.stock.manageStock}
        help={e.stock.manageHelp(storeManagesStock)}
        checked={form.values.manageStock}
        disabled={!editable}
        onChange={(v) => form.set("manageStock", v)}
      />
      <Field
        id="stock-status"
        label={e.stock.stockStatus}
        help={e.stock.stockStatusHelp}
        error={errors["stockStatus"]}
      >
        {(control) => (
          <Select
            {...control}
            value={form.values.stockStatus}
            onChange={(ev) => form.set("stockStatus", ev.target.value)}
            disabled={!editable}
          >
            {Object.entries(m.stock).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {form.values.manageStock && (
        <p role="note" className="rounded-md border border-border bg-border/30 p-3 text-sm">
          {e.stock.statusManagedNote}
        </p>
      )}
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
