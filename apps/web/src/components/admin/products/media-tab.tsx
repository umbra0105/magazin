"use client";

import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@ecom/ui";
import { saveProductMedia } from "@/app/(admin)/admin/produse/editor-actions";
import { getMessages } from "@/messages";
import { MediaPicker } from "../media/media-picker";
import { describeFailure } from "./editor-support";
import type { EditorCaps, EditorMediaItem } from "./editor-types";
import { SaveBar } from "./editor-ui";
import { useDirtyFlag } from "./unsaved-changes";

const m = getMessages().admin.products;
const e = m.editor;

/** Câte imagini poate avea un produs (aceeași limită ca pe server). */
const MAX_PRODUCT_MEDIA = 30;

/**
 * Tabul Media: imaginile produsului din biblioteca media. Prima e cea principală. Adăugarea din
 * selector se salvează imediat (confirmarea selectorului e acțiunea explicită); reordonarea și
 * scoaterea sunt locale până la „Salvează” (cu avertisment la părăsirea paginii). Reordonarea merge
 * cu butoane (tastatură) și e anunțată prin `aria-live`. Doar `thumb`, niciodată originalul.
 * Cere `products.content.write`.
 */
export function MediaTab({
  productId,
  initial,
  caps,
}: {
  productId: string;
  initial: readonly EditorMediaItem[];
  caps: EditorCaps;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [items, setItems] = useState<EditorMediaItem[]>([...initial]);
  const [savedIds, setSavedIds] = useState<string[]>(initial.map((i) => i.mediaId));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const editable = caps.canContent;

  const ids = items.map((i) => i.mediaId);
  const dirty = ids.join("|") !== savedIds.join("|");
  useDirtyFlag("media", dirty);

  const persist = (nextIds: string[], message: string) => {
    setStatus(null);
    setProblem(null);
    startTransition(async () => {
      try {
        const result = await saveProductMedia({ id: productId, mediaIds: nextIds });
        if (result.ok) {
          setItems(
            result.items.map((item) => ({
              id: item.id,
              mediaId: item.mediaId,
              name: item.name,
              alt: item.alt,
              status: item.status,
              thumb: item.thumb,
            })),
          );
          setSavedIds(result.items.map((i) => i.mediaId));
          setStatus(message);
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

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    setItems(next);
    setAnnouncement(e.media.moved(moved.name, target + 1, next.length));
  };

  const remove = (index: number) => {
    const target = items[index];
    if (!target) return;
    setItems(items.filter((_, i) => i !== index));
    setAnnouncement(e.media.removed(target.name));
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) {
      setStatus(e.common.unchanged);
      return;
    }
    persist(ids, e.common.saved);
  };

  return (
    <>
      <form onSubmit={onSubmit} className="flex max-w-3xl flex-col gap-4">
        <h2 className="text-lg font-semibold">{e.media.heading}</h2>
        <p className="text-sm text-muted-foreground">{e.media.help}</p>

        {editable && (
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={pending || items.length >= MAX_PRODUCT_MEDIA}
              onClick={() => setPickerOpen(true)}
            >
              {e.media.add}
            </Button>
            {items.length >= MAX_PRODUCT_MEDIA && (
              <p className="mt-1 text-xs text-muted-foreground">
                {e.media.limit(MAX_PRODUCT_MEDIA)}
              </p>
            )}
          </div>
        )}

        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{e.media.empty}</p>
        ) : (
          <ol className="flex flex-col gap-2" aria-label={e.media.heading}>
            {items.map((item, index) => (
              <li
                key={item.mediaId}
                data-media-item
                className="flex flex-wrap items-center gap-3 rounded-md border border-border p-2"
              >
                {item.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element -- miniatură din /media (variante generate)
                  <img
                    src={item.thumb}
                    alt={item.alt || item.name}
                    className="h-16 w-16 rounded-md border border-border object-cover"
                  />
                ) : (
                  <span className="flex h-16 w-16 items-center justify-center rounded-md border border-border text-center text-[10px] text-muted-foreground">
                    {e.media.noPreview}
                  </span>
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{item.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {index === 0 ? e.media.main : e.media.position(index + 1, items.length)}
                  </span>
                </div>
                {editable && (
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={index === 0 || pending}
                      onClick={() => move(index, -1)}
                      aria-label={e.media.moveUp(item.name)}
                    >
                      <ArrowUp aria-hidden className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={index === items.length - 1 || pending}
                      onClick={() => move(index, 1)}
                      aria-label={e.media.moveDown(item.name)}
                    >
                      <ArrowDown aria-hidden className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pending}
                      onClick={() => remove(index)}
                      aria-label={e.media.remove(item.name)}
                    >
                      <X aria-hidden className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}

        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>

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
      {/* în afara <form>: selectorul are formulare și butoane proprii (formulare imbricate = defect) */}
      {pickerOpen && (
        <MediaPicker
          open
          mode="multiple"
          max={MAX_PRODUCT_MEDIA}
          title={e.media.pickerTitle}
          initialSelectedIds={ids}
          onClose={() => setPickerOpen(false)}
          onConfirm={(picked) => {
            setPickerOpen(false);
            persist(picked, e.media.updated);
          }}
        />
      )}
    </>
  );
}
