"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Dialog, Input, Label, Select, Textarea } from "@ecom/ui";
import { getMessages } from "@/messages";
import { getMediaStatuses } from "@/app/(admin)/admin/media/actions";
import { MediaPicker } from "@/components/admin/media/media-picker";
import { createCategory, updateCategory } from "@/app/(admin)/admin/categorii/actions";
import type { CategoryCapabilities, CategoryRow } from "./category-types";

const m = getMessages().admin.categories;

interface Props {
  /** `null` = dialog închis; `"new"` = categorie nouă; altfel categoria editată. */
  target: CategoryRow | "new" | null;
  rows: readonly CategoryRow[];
  capabilities: CategoryCapabilities;
  maxDepth: number;
  /** Miniaturile imaginilor deja cunoscute (id fișier → adresă). */
  thumbs: Readonly<Record<string, string>>;
  onClose: () => void;
  onSaved: (message: string) => void;
}

const indent = (depth: number): string => "  ".repeat(depth);

/** Formularul de creare/editare a unei categorii. Trimite doar câmpurile la care utilizatorul are drept. */
export function CategoryFormDialog({
  target,
  rows,
  capabilities,
  maxDepth,
  thumbs,
  onClose,
  onSaved,
}: Props) {
  const editing = target !== null && target !== "new" ? target : null;
  const isNew = target === "new";
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [parentId, setParentId] = useState("");
  const [description, setDescription] = useState("");
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");
  const [imageMediaId, setImageMediaId] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [exclude, setExclude] = useState(false);
  const [legacyId, setLegacyId] = useState("");
  const [legacyUrl, setLegacyUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (target === null) return;
    const row = target === "new" ? null : target;
    setName(row?.name ?? "");
    setSlug(row?.slug ?? "");
    setParentId("");
    setDescription(row?.description ?? "");
    setSeoTitle(row?.seoTitle ?? "");
    setSeoDescription(row?.seoDescription ?? "");
    setImageMediaId(row?.imageMediaId ?? null);
    setImageUrl(row?.imageMediaId ? (thumbs[row.imageMediaId] ?? null) : null);
    setExclude(row?.excludeFromGroupDiscount ?? false);
    setLegacyId(row?.legacyId ?? "");
    setLegacyUrl(row?.legacyUrl ?? "");
    setError(null);
  }, [target]);

  if (target === null) {
    return (
      <Dialog open={false} onClose={onClose} title="" closeLabel={m.form.close}>
        {null}
      </Dialog>
    );
  }

  const canEditContent = capabilities.content || capabilities.structure;
  const canEditStructure = capabilities.structure;
  const parents = rows.filter((r) => r.depth < maxDepth);

  const errorText = (result: { code: string; message?: string }): string => {
    const known = (m.errors as Record<string, string>)[result.code];
    // mesajul serverului (în română, cu nume și numere) când nu avem un text propriu
    return known ?? result.message ?? m.errors.generic;
  };

  const pick = async (ids: string[]) => {
    setPickerOpen(false);
    const id = ids[0];
    if (!id) return;
    setImageMediaId(id);
    setImageUrl(null);
    try {
      const result = await getMediaStatuses([id]);
      if (result.ok) setImageUrl(result.items[0]?.thumb?.url ?? null);
    } catch {
      // previzualizarea e opțională
    }
  };

  const submit = () => {
    if (name.trim() === "") {
      setError(m.errors.nameRequired);
      document.getElementById("cat-name")?.focus();
      return;
    }
    startTransition(async () => {
      setError(null);
      try {
        const nullable = (value: string) => (value.trim() === "" ? null : value.trim());
        if (isNew) {
          const result = await createCategory({
            name,
            ...(slug.trim() && { slug: slug.trim() }),
            parentId: parentId === "" ? null : parentId,
            ...(description.trim() && { description }),
            ...(seoTitle.trim() && { seoTitle: seoTitle.trim() }),
            ...(seoDescription.trim() && { seoDescription: seoDescription.trim() }),
            ...(imageMediaId && { imageMediaId }),
            ...(exclude && { excludeFromGroupDiscount: true }),
            ...(capabilities.legacy && legacyId.trim() && { legacyId: legacyId.trim() }),
            ...(capabilities.legacy && legacyUrl.trim() && { legacyUrl: legacyUrl.trim() }),
          });
          if (result.ok) onSaved(m.live.created(name));
          else setError(errorText(result));
          return;
        }
        if (!editing) return;
        const patch: Record<string, unknown> = {
          id: editing.id,
          ...(canEditContent && {
            name,
            description: nullable(description),
            seoTitle: nullable(seoTitle),
            seoDescription: nullable(seoDescription),
            imageMediaId,
          }),
          ...(canEditStructure && { slug: slug.trim(), excludeFromGroupDiscount: exclude }),
          ...(capabilities.legacy && {
            legacyId: nullable(legacyId),
            legacyUrl: nullable(legacyUrl),
          }),
        };
        const result = await updateCategory(patch);
        if (result.ok) onSaved(m.form.saved);
        else setError(errorText(result));
      } catch {
        setError(m.errors.generic);
      }
    });
  };

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={editing ? m.form.editTitle(editing.name) : m.form.createTitle}
        closeLabel={m.form.close}
        className="max-w-xl"
      >
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-name">{m.form.name}</Label>
            <Input
              id="cat-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={150}
              disabled={!canEditContent}
            />
          </div>

          {(isNew || canEditStructure) && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cat-slug">{m.form.slug}</Label>
              <Input
                id="cat-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                maxLength={80}
                aria-describedby="cat-slug-help"
                disabled={!canEditStructure}
              />
              <p id="cat-slug-help" className="text-xs text-muted-foreground">
                {m.form.slugHelp}
              </p>
            </div>
          )}

          {isNew && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cat-parent">{m.form.parent}</Label>
              <Select
                id="cat-parent"
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
              >
                <option value="">{m.form.parentRoot}</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {indent(p.depth)}
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-description">{m.form.description}</Label>
            <Textarea
              id="cat-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              disabled={!canEditContent}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cat-seo-title">{m.form.seoTitle}</Label>
              <Input
                id="cat-seo-title"
                value={seoTitle}
                onChange={(e) => setSeoTitle(e.target.value)}
                maxLength={255}
                disabled={!canEditContent}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cat-seo-description">{m.form.seoDescription}</Label>
              <Input
                id="cat-seo-description"
                value={seoDescription}
                onChange={(e) => setSeoDescription(e.target.value)}
                maxLength={500}
                disabled={!canEditContent}
              />
            </div>
          </div>

          <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-medium">{m.form.image}</legend>
            {imageMediaId ? (
              <div className="flex items-center gap-3">
                {imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- miniatura din /media (variante generate)
                  <img
                    src={imageUrl}
                    alt={m.form.imageAlt}
                    className="h-16 w-16 rounded-md border border-border object-cover"
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">{m.form.imageAlt}</span>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{m.form.imageNone}</p>
            )}
            {canEditContent && capabilities.pickMedia && (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => setPickerOpen(true)}>
                  {imageMediaId ? m.form.imageChange : m.form.imagePick}
                </Button>
                {imageMediaId && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setImageMediaId(null);
                      setImageUrl(null);
                    }}
                  >
                    {m.form.imageRemove}
                  </Button>
                )}
              </div>
            )}
          </fieldset>

          {canEditStructure && (
            <div className="flex items-start gap-2">
              <input
                id="cat-exclude"
                type="checkbox"
                checked={exclude}
                onChange={(e) => setExclude(e.target.checked)}
                className="mt-1 h-4 w-4"
                aria-describedby="cat-exclude-help"
              />
              <div className="flex flex-col">
                <Label htmlFor="cat-exclude">{m.form.excludeFromGroupDiscount}</Label>
                <p id="cat-exclude-help" className="text-xs text-muted-foreground">
                  {m.form.excludeHelp}
                </p>
              </div>
            </div>
          )}

          {capabilities.legacy && (
            <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium">{m.form.legacyTitle}</legend>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cat-legacy-id">{m.form.legacyId}</Label>
                <Input
                  id="cat-legacy-id"
                  value={legacyId}
                  onChange={(e) => setLegacyId(e.target.value)}
                  maxLength={100}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cat-legacy-url">{m.form.legacyUrl}</Label>
                <Input
                  id="cat-legacy-url"
                  value={legacyUrl}
                  onChange={(e) => setLegacyUrl(e.target.value)}
                  maxLength={1000}
                />
              </div>
              <p className="text-xs text-muted-foreground">{m.form.legacyHelp}</p>
            </fieldset>
          )}

          {error && (
            <p role="alert" className="rounded-md border border-danger p-3 text-sm text-danger">
              {error}
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {m.form.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? m.form.saving : m.form.save}
            </Button>
          </div>
        </form>
      </Dialog>

      {pickerOpen && (
        <MediaPicker
          open
          mode="single"
          initialSelectedIds={imageMediaId ? [imageMediaId] : []}
          onClose={() => setPickerOpen(false)}
          onConfirm={(ids) => void pick(ids)}
        />
      )}
    </>
  );
}
