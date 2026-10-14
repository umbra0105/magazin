"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Input, Textarea } from "@ecom/ui";
import { saveProductFields } from "@/app/(admin)/admin/produse/editor-actions";
import { getMessages } from "@/messages";
import { describeFailure, focusFirstInvalid } from "./editor-support";
import type { EditorCaps, EditorProduct } from "./editor-types";
import { Field, SaveBar } from "./editor-ui";
import { useTabForm } from "./use-tab-form";

const m = getMessages().admin.products;
const e = m.editor;

const RECOMMENDED_TITLE = 60;
const RECOMMENDED_DESCRIPTION = 160;

/** Tabul SEO: titlu și descriere pentru motoarele de căutare (conținut: `products.content.write`). */
export function SeoTab({ product, caps }: { product: EditorProduct; caps: EditorCaps }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const form = useTabForm(
    { seoTitle: product.seoTitle ?? "", seoDescription: product.seoDescription ?? "" },
    "seo",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const editable = caps.canContent;
  const { values } = form;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);
    setProblem(null);
    if (!form.dirty) {
      setStatus(e.common.unchanged);
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const key of form.changed) patch[key] = values[key].trim() === "" ? null : values[key];
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
      <h2 className="text-lg font-semibold">{e.seo.heading}</h2>
      <Field
        id="seo-title"
        label={e.seo.seoTitle}
        help={`${e.seo.seoTitleHelp} ${e.seo.counter(values.seoTitle.length, RECOMMENDED_TITLE)}`}
        error={errors["seoTitle"]}
      >
        {(control) => (
          <Input
            {...control}
            value={values.seoTitle}
            onChange={(ev) => form.set("seoTitle", ev.target.value)}
            maxLength={255}
            disabled={!editable}
          />
        )}
      </Field>
      <Field
        id="seo-description"
        label={e.seo.seoDescription}
        help={`${e.seo.seoDescriptionHelp} ${e.seo.counter(
          values.seoDescription.length,
          RECOMMENDED_DESCRIPTION,
        )}`}
        error={errors["seoDescription"]}
      >
        {(control) => (
          <Textarea
            {...control}
            value={values.seoDescription}
            onChange={(ev) => form.set("seoDescription", ev.target.value)}
            rows={3}
            maxLength={500}
            disabled={!editable}
          />
        )}
      </Field>

      <figure className="flex flex-col gap-1 rounded-md border border-border p-4">
        <figcaption className="text-xs font-medium text-muted-foreground">
          {e.seo.preview}
        </figcaption>
        <p className="text-lg text-primary">{values.seoTitle.trim() || product.title}</p>
        <p className="text-sm text-muted-foreground">
          {values.seoDescription.trim() || (product.description ?? "").slice(0, 160)}
        </p>
      </figure>

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
