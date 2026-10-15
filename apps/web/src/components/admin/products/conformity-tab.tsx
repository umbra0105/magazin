"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Input, Select, Textarea } from "@ecom/ui";
import { saveProductFields } from "@/app/(admin)/admin/produse/editor-actions";
import { getMessages } from "@/messages";
import { describeFailure, focusFirstInvalid } from "./editor-support";
import type { EditorCaps, EditorProduct } from "./editor-types";
import { Field, SaveBar } from "./editor-ui";
import { useTabForm } from "./use-tab-form";

const m = getMessages().admin.products;
const e = m.editor;
const c = e.conformity;

/** Clasele energetice ale scării vechi (A+++ … D) și ale celei noi (A … G), în ordinea afișării. */
const ENERGY_CLASSES = ["A+++", "A++", "A+", "A", "B", "C", "D", "E", "F", "G"] as const;

/**
 * Tabul Conformitate: clasa energetică, linkul EPREL și datele GPSR (producător, persoană
 * responsabilă din UE, avertismente). Sunt câmpuri de produs restricționate: cer `products.write`
 * (Editorul le vede doar pentru citire; serverul respinge oricum). Linkul EPREL se validează doar ca
 * `https://`; serverul nu îl urmează niciodată (fără cereri de ieșire, deci fără SSRF).
 */
export function ConformityTab({ product, caps }: { product: EditorProduct; caps: EditorCaps }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const form = useTabForm(
    {
      energyClass: product.energyClass ?? "",
      eprelUrl: product.eprelUrl ?? "",
      gpsrManufacturerName: product.gpsrManufacturerName ?? "",
      gpsrManufacturerContact: product.gpsrManufacturerContact ?? "",
      gpsrResponsibleName: product.gpsrResponsibleName ?? "",
      gpsrResponsibleContact: product.gpsrResponsibleContact ?? "",
      safetyWarnings: product.safetyWarnings ?? "",
    },
    "conformity",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const editable = caps.canWrite;
  const { values } = form;

  const LIMITS: Record<string, number> = {
    eprelUrl: 500,
    gpsrManufacturerName: 200,
    gpsrManufacturerContact: 1000,
    gpsrResponsibleName: 200,
    gpsrResponsibleContact: 1000,
    safetyWarnings: 5000,
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);
    setProblem(null);
    if (!form.dirty) {
      setStatus(e.common.unchanged);
      return;
    }
    const found: Record<string, string> = {};
    for (const key of form.changed) {
      const value = String(values[key]);
      if (key === "eprelUrl" && value.trim() !== "" && !/^https:\/\/\S+$/.test(value.trim())) {
        found[key] = c.eprelInvalid;
      }
      const max = LIMITS[key as string];
      if (max && value.length > max) found[key as string] = c.tooLong(max);
    }
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setProblem(e.common.formError);
      focusFirstInvalid();
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const key of form.changed) {
      const value = String(values[key]).trim();
      patch[key] = value === "" ? null : value;
    }
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
    <form onSubmit={onSubmit} noValidate className="flex max-w-3xl flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">{c.heading}</h2>
        <p className="text-sm text-muted-foreground">{c.help}</p>
      </div>

      <fieldset className="flex flex-col gap-4 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium">{c.energyHeading}</legend>
        <Field
          id="conf-energy"
          label={c.energyClass}
          help={c.energyHelp}
          error={errors["energyClass"]}
        >
          {(control) => (
            <Select
              {...control}
              value={values.energyClass}
              disabled={!editable}
              onChange={(ev) => form.set("energyClass", ev.target.value)}
            >
              <option value="">{c.energyNone}</option>
              {ENERGY_CLASSES.map((cls) => (
                <option key={cls} value={cls}>
                  {cls}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="conf-eprel" label={c.eprelUrl} help={c.eprelHelp} error={errors["eprelUrl"]}>
          {(control) => (
            <Input
              {...control}
              type="url"
              inputMode="url"
              autoComplete="off"
              value={values.eprelUrl}
              disabled={!editable}
              maxLength={500}
              onChange={(ev) => form.set("eprelUrl", ev.target.value)}
            />
          )}
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-4 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium">{c.gpsrHeading}</legend>
        <Field
          id="conf-man-name"
          label={c.gpsrManufacturerName}
          error={errors["gpsrManufacturerName"]}
        >
          {(control) => (
            <Input
              {...control}
              value={values.gpsrManufacturerName}
              disabled={!editable}
              maxLength={200}
              onChange={(ev) => form.set("gpsrManufacturerName", ev.target.value)}
            />
          )}
        </Field>
        <Field
          id="conf-man-contact"
          label={c.gpsrManufacturerContact}
          error={errors["gpsrManufacturerContact"]}
        >
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              value={values.gpsrManufacturerContact}
              disabled={!editable}
              maxLength={1000}
              onChange={(ev) => form.set("gpsrManufacturerContact", ev.target.value)}
            />
          )}
        </Field>
        <Field
          id="conf-resp-name"
          label={c.gpsrResponsibleName}
          help={c.gpsrResponsibleHelp}
          error={errors["gpsrResponsibleName"]}
        >
          {(control) => (
            <Input
              {...control}
              value={values.gpsrResponsibleName}
              disabled={!editable}
              maxLength={200}
              onChange={(ev) => form.set("gpsrResponsibleName", ev.target.value)}
            />
          )}
        </Field>
        <Field
          id="conf-resp-contact"
          label={c.gpsrResponsibleContact}
          error={errors["gpsrResponsibleContact"]}
        >
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              value={values.gpsrResponsibleContact}
              disabled={!editable}
              maxLength={1000}
              onChange={(ev) => form.set("gpsrResponsibleContact", ev.target.value)}
            />
          )}
        </Field>
        <Field id="conf-safety" label={c.safetyWarnings} error={errors["safetyWarnings"]}>
          {(control) => (
            <Textarea
              {...control}
              rows={5}
              value={values.safetyWarnings}
              disabled={!editable}
              maxLength={5000}
              onChange={(ev) => form.set("safetyWarnings", ev.target.value)}
            />
          )}
        </Field>
      </fieldset>

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
