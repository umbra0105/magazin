"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type FormEvent } from "react";
import { formatDecimalDisplay, parseDecimalInput } from "@ecom/shared/decimal";
import { Input, Select } from "@ecom/ui";
import { saveProductAttributes } from "@/app/(admin)/admin/produse/editor-actions";
import { getMessages } from "@/messages";
import { describeFailure } from "./editor-support";
import type { EditorAttribute, EditorCaps } from "./editor-types";
import { Field, SaveBar } from "./editor-ui";
import { useDirtyFlag } from "./unsaved-changes";

const m = getMessages().admin.products;
const e = m.editor;
const a = e.attributes;

/** Valoarea din formular: tot text (numerele rămân exact cum le tastează adminul până la salvare). */
function toDraft(attribute: EditorAttribute): string {
  const v = attribute.value;
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return attribute.type === "number" ? formatDecimalDisplay(v) : v;
}

/**
 * Tabul Atribute. Fiecare atribut definit apare cu controlul potrivit tipului: text, număr (virgulă
 * sau punct, unitatea lângă câmp), da/nu sau listă. Numerele se trimit ca text și se stochează EXACT
 * (NUMERIC, fără float). Se trimit doar atributele modificate; gol = valoarea se șterge. Cere
 * `products.write` (verificat pe server).
 */
export function AttributesTab({
  productId,
  attributes,
  caps,
}: {
  productId: string;
  attributes: readonly EditorAttribute[];
  caps: EditorCaps;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const initial = useMemo(
    () => Object.fromEntries(attributes.map((attr) => [attr.id, toDraft(attr)])),
    [attributes],
  );
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [baseline, setBaseline] = useState<Record<string, string>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const editable = caps.canWrite;

  const changedIds = attributes
    .filter((attr) => values[attr.id] !== baseline[attr.id])
    .map((x) => x.id);
  const dirty = changedIds.length > 0;
  useDirtyFlag("attributes", dirty);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);
    setProblem(null);
    if (!dirty) {
      setStatus(e.common.unchanged);
      return;
    }
    const found: Record<string, string> = {};
    const payload: { attributeId: string; value: string | boolean | null }[] = [];
    for (const attr of attributes) {
      if (!changedIds.includes(attr.id)) continue;
      const raw = (values[attr.id] ?? "").trim();
      if (raw === "") {
        payload.push({ attributeId: attr.id, value: null });
        continue;
      }
      if (attr.type === "number") {
        if (parseDecimalInput(raw) === null) {
          found[attr.id] = a.numberInvalid;
          continue;
        }
        payload.push({ attributeId: attr.id, value: raw });
      } else if (attr.type === "bool") {
        payload.push({ attributeId: attr.id, value: raw === "true" });
      } else if (attr.type === "text" && raw.length > 500) {
        found[attr.id] = a.textTooLong;
      } else {
        payload.push({ attributeId: attr.id, value: raw });
      }
    }
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
        const result = await saveProductAttributes({ id: productId, values: payload });
        if (result.ok) {
          const next = { ...values };
          // valorile canonice întoarse de server (ex. „12.50” → „12,5”)
          for (const saved of result.values) {
            const attr = attributes.find((x) => x.id === saved.attributeId);
            if (!attr || !changedIds.includes(attr.id)) continue;
            next[attr.id] = toDraft({ ...attr, value: saved.value });
          }
          setValues(next);
          setBaseline(next);
          setErrors({});
          setStatus(e.common.saved);
          router.refresh();
          return;
        }
        const view = describeFailure(result, m.errors, {
          generic: e.common.generic,
          formError: e.common.formError,
        });
        setProblem(view.form);
      } catch {
        setProblem(e.common.generic);
      }
    });
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex max-w-3xl flex-col gap-5">
      <h2 className="text-lg font-semibold">{a.heading}</h2>
      <p className="text-sm text-muted-foreground">
        {a.help}{" "}
        <Link href="/admin/atribute" className="text-primary underline-offset-2 hover:underline">
          {a.manage}
        </Link>
      </p>

      {attributes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{a.empty}</p>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          {attributes.map((attr) => {
            const id = `attr-${attr.code}`;
            const label = attr.unit ? `${attr.name} (${attr.unit})` : attr.name;
            const value = values[attr.id] ?? "";
            const set = (next: string) => setValues((c) => ({ ...c, [attr.id]: next }));
            return (
              <Field
                key={attr.id}
                id={id}
                label={label}
                help={attr.type === "number" ? a.number : undefined}
                error={errors[attr.id]}
              >
                {(control) => {
                  if (attr.type === "select") {
                    return (
                      <Select
                        {...control}
                        value={value}
                        disabled={!editable}
                        onChange={(ev) => set(ev.target.value)}
                      >
                        <option value="">{a.notSet}</option>
                        {attr.options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.value}
                          </option>
                        ))}
                      </Select>
                    );
                  }
                  if (attr.type === "bool") {
                    return (
                      <Select
                        {...control}
                        value={value}
                        disabled={!editable}
                        onChange={(ev) => set(ev.target.value)}
                      >
                        <option value="">{a.notSet}</option>
                        <option value="true">{a.yes}</option>
                        <option value="false">{a.no}</option>
                      </Select>
                    );
                  }
                  return (
                    <Input
                      {...control}
                      value={value}
                      disabled={!editable}
                      inputMode={attr.type === "number" ? "decimal" : "text"}
                      autoComplete="off"
                      maxLength={attr.type === "number" ? 24 : 500}
                      onChange={(ev) => set(ev.target.value)}
                    />
                  );
                }}
              </Field>
            );
          })}
        </div>
      )}

      {!editable && <p className="text-sm text-muted-foreground">{e.common.readOnlyTab}</p>}
      <SaveBar
        pending={pending}
        canSave={editable && attributes.length > 0}
        dirty={dirty}
        status={status}
        problem={problem}
        labels={{ ...e.common, unsavedMark: e.unsavedMark }}
      />
    </form>
  );
}
