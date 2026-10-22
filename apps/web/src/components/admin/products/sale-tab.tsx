"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Select, Input } from "@ecom/ui";
import { saveProductFields } from "@/app/(admin)/admin/produse/editor-actions";
import { getMessages } from "@/messages";
import { describeFailure, focusFirstInvalid } from "./editor-support";
import type { EditorCaps, EditorProduct } from "./editor-types";
import { CheckField, Field, SaveBar } from "./editor-ui";
import {
  formatMinimum,
  formatStepInput,
  parseMinInput,
  parseStepInput,
  previewQuantities,
  type SaleUnit,
} from "./sale-form";
import { useTabForm } from "./use-tab-form";

const m = getMessages().admin.products;
const e = m.editor;
const t = e.sale;

/** Codul unității implicite («buc»): o unitate nulă pe produs înseamnă exact aceasta. */
const DEFAULT_UNIT_CODE = "buc";

/**
 * Tabul Unitate și pas: în ce se vinde produsul (unitate de măsură), la ce se referă prețul (pe unitate sau pe pas),
 * pasul de vânzare (cantitatea comandată e mereu un multiplu exact), minimul și afișarea prețului pasului. Cere
 * `products.write`. Fără unitate aleasă, produsul se vinde la bucată («buc»); alegerea «buc» se salvează ca „fără
 * unitate”, ca cele două stări să nu existe în paralel.
 */
export function SaleTab({
  product,
  units,
  caps,
}: {
  product: EditorProduct;
  units: readonly SaleUnit[];
  caps: EditorCaps;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const defaultUnit = units.find((u) => u.code === DEFAULT_UNIT_CODE) ?? null;
  const form = useTabForm(
    {
      measureUnitId: product.measureUnitId ?? "",
      priceBasis: product.priceBasis,
      saleStep: formatStepInput(product.saleStep),
      minSteps: product.minSteps === null ? "" : String(product.minSteps),
      showStepPrice: product.showStepPrice,
    },
    "sale",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const editable = caps.canWrite;

  const selected =
    form.values.measureUnitId === ""
      ? defaultUnit
      : (units.find((u) => u.id === form.values.measureUnitId) ?? null);
  const decimals = selected?.decimals ?? 0;
  const symbol = selected?.symbol ?? DEFAULT_UNIT_CODE;

  const stepNow = parseStepInput(form.values.saleStep, decimals, t.errors);
  const minNow = parseMinInput(form.values.minSteps, t.errors);
  const stepValue = stepNow.ok ? stepNow.value : null;
  const minimum = minNow.ok && minNow.value !== null ? minNow.value : 1;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);
    setProblem(null);
    if (!form.dirty) {
      setStatus(e.common.unchanged);
      return;
    }
    const found: Record<string, string> = {};
    const unitChanged = form.changed.includes("measureUnitId");
    if (form.changed.includes("saleStep") || unitChanged) {
      const step = parseStepInput(form.values.saleStep, decimals, t.errors);
      if (!step.ok) found["saleStep"] = step.message;
    }
    if (form.changed.includes("minSteps")) {
      const min = parseMinInput(form.values.minSteps, t.errors);
      if (!min.ok) found["minSteps"] = min.message;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setProblem(e.common.formError);
      focusFirstInvalid();
      return;
    }

    const patch: Record<string, unknown> = {};
    for (const key of form.changed) {
      if (key === "measureUnitId") patch[key] = form.values.measureUnitId || null;
      else if (key === "saleStep") patch[key] = stepValue;
      else if (key === "minSteps") patch[key] = minNow.ok ? minNow.value : null;
      else patch[key] = form.values[key];
    }
    // schimbarea unității cere re-validarea pasului pe server: îl trimitem și pe el, ca eroarea să apară la câmpul lui
    if (unitChanged && !("saleStep" in patch) && stepValue !== null) patch["saleStep"] = stepValue;

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

  const bucOption = defaultUnit ? t.unitDefault(defaultUnit.name, defaultUnit.symbol) : "buc";
  const preview = previewQuantities(stepValue);
  const minimumText = minimum > 1 ? formatMinimum(stepValue, minimum) : null;

  return (
    <form onSubmit={onSubmit} noValidate className="flex max-w-3xl flex-col gap-5">
      <h2 className="text-lg font-semibold">{t.heading}</h2>
      <p className="text-sm text-muted-foreground">{t.intro}</p>

      <Field id="sale-unit" label={t.unit} help={t.unitHelp} error={errors["measureUnitId"]}>
        {(control) => (
          <Select
            {...control}
            value={form.values.measureUnitId}
            onChange={(event) => form.set("measureUnitId", event.target.value)}
            disabled={!editable}
          >
            <option value="">{bucOption}</option>
            {units
              .filter((u) => u.code !== DEFAULT_UNIT_CODE)
              .filter((u) => u.isActive || u.id === product.measureUnitId)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {t.unitOption(u.name, u.symbol)}
                  {u.isActive ? "" : ` — ${t.unitInactive}`}
                </option>
              ))}
          </Select>
        )}
      </Field>

      <Field id="sale-basis" label={t.priceBasis} help={t.basisHelp} error={errors["priceBasis"]}>
        {(control) => (
          <Select
            {...control}
            value={form.values.priceBasis}
            onChange={(event) => form.set("priceBasis", event.target.value)}
            disabled={!editable}
          >
            <option value="unit">{t.basisUnit(symbol)}</option>
            <option value="step">{t.basisStep}</option>
          </Select>
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="sale-step"
          label={t.step}
          help={t.stepHelp(symbol, decimals)}
          error={errors["saleStep"]}
        >
          {(control) => (
            <Input
              {...control}
              value={form.values.saleStep}
              onChange={(event) => form.set("saleStep", event.target.value)}
              inputMode="decimal"
              autoComplete="off"
              disabled={!editable}
            />
          )}
        </Field>
        <Field id="sale-min" label={t.minSteps} help={t.minHelp} error={errors["minSteps"]}>
          {(control) => (
            <Input
              {...control}
              value={form.values.minSteps}
              onChange={(event) => form.set("minSteps", event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              disabled={!editable}
            />
          )}
        </Field>
      </div>

      <CheckField
        id="sale-show-step-price"
        label={t.showStepPrice}
        checked={form.values.showStepPrice}
        disabled={!editable}
        onChange={(v) => form.set("showStepPrice", v)}
      />

      <section
        aria-labelledby="sale-preview-heading"
        data-sale-preview
        className="rounded-md border border-border bg-border/20 p-3 text-sm"
      >
        <h3 id="sale-preview-heading" className="font-medium">
          {t.preview}
        </h3>
        <p data-sale-preview-list>{t.previewList(preview, symbol)}</p>
        {minimum > 1 && minimumText !== null && (
          <p className="text-muted-foreground">{t.previewMin(minimumText, symbol)}</p>
        )}
      </section>

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
