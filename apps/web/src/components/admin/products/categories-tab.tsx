"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type FormEvent } from "react";
import { saveProductCategories } from "@/app/(admin)/admin/produse/editor-actions";
import { getMessages } from "@/messages";
import { describeFailure } from "./editor-support";
import type { EditorCaps } from "./editor-types";
import { SaveBar } from "./editor-ui";
import { useDirtyFlag } from "./unsaved-changes";

const m = getMessages().admin.products;
const e = m.editor;

export interface CategoryOption {
  id: string;
  name: string;
  depth: number;
}

interface Selection {
  ids: string[];
  primaryId: string | null;
}

const keyOf = (s: Selection) => `${[...s.ids].sort().join("|")}#${s.primaryId ?? ""}`;

/**
 * Tabul Categorii: bifezi categoriile produsului (arborele, cu indentare) și alegi una principală.
 * Prima bifată devine principală dacă nu alegi tu. Modificarea cere `products.write`.
 */
export function CategoriesTab({
  productId,
  options,
  initial,
  caps,
}: {
  productId: string;
  options: readonly CategoryOption[];
  initial: Selection;
  caps: EditorCaps;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selection, setSelection] = useState<Selection>(initial);
  const [baseline, setBaseline] = useState<Selection>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const editable = caps.canWrite;

  const dirty = useMemo(() => keyOf(selection) !== keyOf(baseline), [selection, baseline]);
  useDirtyFlag("categories", dirty);

  const toggle = (id: string, checked: boolean) => {
    setSelection((current) => {
      const ids = checked ? [...current.ids, id] : current.ids.filter((x) => x !== id);
      let primaryId = current.primaryId;
      if (!checked && primaryId === id) primaryId = ids[0] ?? null;
      if (checked && primaryId === null) primaryId = id;
      return { ids, primaryId };
    });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);
    setProblem(null);
    if (!dirty) {
      setStatus(e.common.unchanged);
      return;
    }
    startTransition(async () => {
      try {
        const result = await saveProductCategories({
          id: productId,
          categories: { categoryIds: selection.ids, primaryId: selection.primaryId },
        });
        if (result.ok) {
          setBaseline(selection);
          setStatus(e.common.saved);
          router.refresh();
          return;
        }
        setProblem(
          describeFailure(result, m.errors, {
            generic: e.common.generic,
            formError: e.common.formError,
          }).form,
        );
      } catch {
        setProblem(e.common.generic);
      }
    });
  };

  return (
    <form onSubmit={onSubmit} className="flex max-w-3xl flex-col gap-4">
      <h2 className="text-lg font-semibold">{e.categories.heading}</h2>
      <p className="text-sm text-muted-foreground">{e.categories.help}</p>

      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">{e.categories.none}</p>
      ) : (
        <fieldset className="flex flex-col gap-1 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">{e.categories.heading}</legend>
          {options.map((option) => {
            const checked = selection.ids.includes(option.id);
            return (
              <div
                key={option.id}
                className="flex min-h-9 flex-wrap items-center gap-3"
                style={{ paddingLeft: `${option.depth * 1.25}rem` }}
              >
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!editable}
                    onChange={(ev) => toggle(option.id, ev.target.checked)}
                    className="h-4 w-4"
                  />
                  {option.name}
                </label>
                {checked && (
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="radio"
                      name="primary-category"
                      checked={selection.primaryId === option.id}
                      disabled={!editable}
                      onChange={() => setSelection((c) => ({ ...c, primaryId: option.id }))}
                      aria-label={e.categories.primaryFor(option.name)}
                    />
                    {e.categories.primary}
                  </label>
                )}
              </div>
            );
          })}
        </fieldset>
      )}
      <p className="text-sm text-muted-foreground">{e.categories.selected(selection.ids.length)}</p>

      {!editable && <p className="text-sm text-muted-foreground">{e.common.readOnlyTab}</p>}
      <SaveBar
        pending={pending}
        canSave={editable}
        dirty={dirty}
        status={status}
        problem={problem}
        labels={{ ...e.common, unsavedMark: e.unsavedMark }}
      />
    </form>
  );
}
