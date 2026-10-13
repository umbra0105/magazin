"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog } from "@ecom/ui";
import { getMessages } from "@/messages";
import { getMediaStatuses, listPickerMedia } from "@/app/(admin)/admin/media/actions";
import { effectiveMax, normalizeInitial, toggleSelection } from "@/lib/media-selection";
import { MediaCard } from "./media-card";
import { MediaFilterFields } from "./media-filter-fields";
import { MediaGrid } from "./media-grid";
import { MEDIA_ACCEPT, MEDIA_TYPES_LABEL } from "./media-library";
import type { LibraryFolder, LibraryItem } from "./media-types";
import { UploadPanel } from "./upload-panel";
import { useMediaUploads } from "./use-media-uploads";
import { useStatusPolling } from "./use-status-polling";

const m = getMessages().admin.media;

export interface MediaPickerProps {
  open: boolean;
  /** Închis fără alegere (Escape, „Anulează”, click pe fundal). */
  onClose: () => void;
  /**
   * Alegerea confirmată: DOAR id-urile fișierelor, în ordinea în care au fost alese. Cheile de
   * storage și adresele originalelor nu ajung niciodată la apelant.
   */
  onConfirm: (ids: string[]) => void;
  mode?: "single" | "multiple";
  /** Numărul maxim la selecție multiplă (implicit 10, între 1 și 50). Ignorat la selecție unică. */
  max?: number;
  /** Id-uri deja alese (ex. imaginile unui produs), în ordine. */
  initialSelectedIds?: readonly string[];
  title?: string;
}

interface Listing {
  items: LibraryItem[];
  folders: LibraryFolder[];
  total: number;
  page: number;
  pageCount: number;
  canWrite: boolean;
  maxUploadMb: number;
}

/**
 * Selectorul reutilizabil de fișiere media, într-un dialog modal (focus capturat, Escape,
 * tastatură). Arată DOAR fișiere `ready`, cu varianta `thumb`; selecția păstrează ordinea alegerii
 * și un maxim; încărcarea din selector apare doar cu `media.write`. Reutilizează grid-ul, câmpurile
 * de căutare, coada de încărcări și interogarea de status ale bibliotecii.
 */
export function MediaPicker({
  open,
  onClose,
  onConfirm,
  mode = "multiple",
  max,
  initialSelectedIds,
  title,
}: MediaPickerProps) {
  const limit = effectiveMax(mode, max);
  const [q, setQ] = useState("");
  const [folder, setFolder] = useState("");
  const [applied, setApplied] = useState({ q: "", folder: "", page: 1 });
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [known, setKnown] = useState<Map<string, LibraryItem>>(new Map());
  const [rejected, setRejected] = useState(false);
  const [awaiting, setAwaiting] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const requestId = useRef(0);

  const remember = useCallback((items: readonly LibraryItem[]) => {
    setKnown((current) => {
      const next = new Map(current);
      for (const item of items) next.set(item.id, item);
      return next;
    });
  }, []);

  const load = useCallback(
    async (query: { q: string; folder: string; page: number }) => {
      const mine = ++requestId.current;
      setLoading(true);
      setError(false);
      try {
        const result = await listPickerMedia({
          ...(query.q && { q: query.q }),
          ...(query.folder && { folder: query.folder }),
          page: query.page,
        });
        if (mine !== requestId.current) return;
        if (result.ok) {
          setListing({
            items: result.items,
            folders: result.folders,
            total: result.total,
            page: result.page,
            pageCount: result.pageCount,
            canWrite: result.canWrite,
            maxUploadMb: result.maxUploadMb,
          });
          remember(result.items);
        } else {
          setError(true);
        }
      } catch {
        if (mine === requestId.current) setError(true);
      } finally {
        if (mine === requestId.current) setLoading(false);
      }
    },
    [remember],
  );

  // La deschidere: selecția inițială și prima pagină.
  const initialKey = (initialSelectedIds ?? []).join(",");
  useEffect(() => {
    if (!open) return;
    const initial = normalizeInitial(initialSelectedIds, limit);
    setSelected(initial);
    setQ("");
    setFolder("");
    setApplied({ q: "", folder: "", page: 1 });
    setRejected(false);
    setAwaiting([]);
    setAnnouncement("");
    void load({ q: "", folder: "", page: 1 });
    if (initial.length > 0) {
      void getMediaStatuses(initial)
        .then((res) => {
          if (!res.ok) return;
          remember(res.items);
          // numai fișierele `ready` rămân în selecție
          const ready = new Set(res.items.filter((i) => i.status === "ready").map((i) => i.id));
          setSelected((current) => current.filter((id) => ready.has(id)));
        })
        .catch(() => undefined);
    }
    // se reia doar la (re)deschidere sau când se schimbă selecția inițială
  }, [open, initialKey]);

  // Fișierele încărcate din selector: cât se procesează, se interoghează; când sunt gata apar în listă.
  useStatusPolling(awaiting, (items) => {
    const ready = items.filter((i) => i.status === "ready").map((i) => i.id);
    const failed = items.filter((i) => i.status === "failed").map((i) => i.id);
    if (ready.length === 0 && failed.length === 0) return;
    setAwaiting((current) => current.filter((id) => !ready.includes(id) && !failed.includes(id)));
    if (ready.length > 0) {
      setAnnouncement(m.picker.becameReady);
      void load({ ...applied, page: 1 });
    }
  });

  const uploader = useMediaUploads({
    folderId: applied.folder && applied.folder !== "root" ? applied.folder : null,
    onUploaded: (item) => {
      if (item.mediaId) setAwaiting((current) => [...current, item.mediaId as string]);
    },
  });

  const toggle = (id: string) => {
    const result = toggleSelection(selected, id, limit);
    setSelected(result.ids);
    setRejected(result.rejected);
  };

  const submitFilters = () => {
    const next = { q: q.trim(), folder, page: 1 };
    setApplied(next);
    void load(next);
  };

  const goToPage = (page: number) => {
    const next = { ...applied, page };
    setApplied(next);
    void load(next);
  };

  const tray = useMemo(() => selected.map((id) => known.get(id) ?? null), [selected, known]);
  const heading = title ?? (mode === "single" ? m.picker.titleSingle : m.picker.titleMultiple);
  const description =
    mode === "single" ? m.picker.descriptionSingle : m.picker.descriptionMultiple(limit);
  const atLimit = limit > 1 && selected.length >= limit;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={heading}
      description={description}
      closeLabel={m.detail.close}
      className="max-w-5xl"
    >
      <div data-testid="media-picker" className="flex flex-col gap-4">
        <form
          role="search"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submitFilters();
          }}
        >
          <MediaFilterFields
            idPrefix="picker"
            folders={listing?.folders ?? []}
            q={q}
            folder={folder}
            showStatus={false}
            onQChange={setQ}
            onFolderChange={(value) => {
              setFolder(value);
              const next = { q: q.trim(), folder: value, page: 1 };
              setApplied(next);
              void load(next);
            }}
          />
          <Button type="submit">{m.picker.applyFilters}</Button>
        </form>
        <p className="text-xs text-muted-foreground">{m.picker.onlyReady}</p>

        {listing?.canWrite && (
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">{m.picker.uploadTitle}</summary>
            <div className="mt-3">
              <UploadPanel
                items={uploader.uploads}
                rules={m.upload.rules(listing.maxUploadMb, MEDIA_TYPES_LABEL)}
                accept={MEDIA_ACCEPT}
                onFiles={uploader.add}
                onRetry={uploader.retry}
                onRemove={uploader.remove}
                onClear={uploader.clearFinished}
              />
              {awaiting.length > 0 && (
                <p role="status" className="mt-2 text-sm">
                  {m.picker.processingNew(awaiting.length)}
                </p>
              )}
            </div>
          </details>
        )}

        <div aria-busy={loading} className="min-h-40">
          {error ? (
            <div role="alert" className="flex flex-col items-start gap-2 text-sm">
              <p>{m.picker.loadError}</p>
              <Button variant="outline" onClick={() => void load(applied)}>
                {m.picker.retry}
              </Button>
            </div>
          ) : !listing ? (
            <p className="text-sm text-muted-foreground">{m.picker.loading}</p>
          ) : listing.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              {m.picker.empty}
            </p>
          ) : (
            <MediaGrid label={m.grid.label}>
              {listing.items.map((item) => {
                const index = selected.indexOf(item.id);
                return (
                  <MediaCard
                    key={item.id}
                    item={item}
                    onOpen={toggle}
                    selection={{ order: index >= 0 ? index + 1 : null, blocked: atLimit }}
                  />
                );
              })}
            </MediaGrid>
          )}
        </div>

        {listing && listing.pageCount > 1 && (
          <nav
            aria-label={m.grid.pagination}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <Button
              variant="outline"
              disabled={listing.page <= 1}
              onClick={() => goToPage(listing.page - 1)}
            >
              {m.grid.previous}
            </Button>
            <span
              className="order-last w-full text-center text-sm sm:order-none sm:w-auto"
              aria-current="page"
            >
              {m.grid.pageOf(listing.page, listing.pageCount)}
            </span>
            <Button
              variant="outline"
              disabled={listing.page >= listing.pageCount}
              onClick={() => goToPage(listing.page + 1)}
            >
              {m.grid.next}
            </Button>
          </nav>
        )}

        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>

        <section
          aria-label={m.picker.tray}
          className="flex flex-col gap-2 border-t border-border pt-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p
              data-testid="picker-count"
              role="status"
              aria-live="polite"
              className="text-sm font-medium"
            >
              {m.picker.selectedCount(selected.length, limit)}
            </p>
            {rejected && (
              <p role="alert" className="text-sm text-danger">
                {m.picker.maxReached(limit)}
              </p>
            )}
          </div>
          {tray.length > 0 && (
            <ol className="flex flex-wrap gap-2">
              {tray.map((item, i) => {
                const id = selected[i] as string;
                const name = item?.originalName ?? m.picker.unknownItem;
                return (
                  <li
                    key={id}
                    className="flex items-center gap-1 rounded-md border border-border py-1 pl-2 pr-1 text-xs"
                  >
                    <span className="font-semibold">{i + 1}.</span>
                    <span className="max-w-32 truncate">{name}</span>
                    <button
                      type="button"
                      onClick={() => toggle(id)}
                      aria-label={m.picker.removeFromSelection(name)}
                      className="inline-flex size-8 items-center justify-center rounded-md hover:bg-border/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <X aria-hidden="true" className="size-4" />
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {m.picker.cancel}
            </Button>
            <Button disabled={selected.length === 0} onClick={() => onConfirm([...selected])}>
              {m.picker.confirm(selected.length)}
            </Button>
          </div>
        </section>
      </div>
    </Dialog>
  );
}
