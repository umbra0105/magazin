"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { getMessages } from "@/messages";
import { MediaDetailDialog } from "./detail-dialog";
import { FolderPanel } from "./folder-panel";
import { MediaCard } from "./media-card";
import { MediaGrid } from "./media-grid";
import type { LibraryFolder, LibraryItem } from "./media-types";
import { UploadPanel } from "./upload-panel";
import { useMediaUploads } from "./use-media-uploads";
import { useStatusPolling } from "./use-status-polling";

const m = getMessages().admin.media;

export const MEDIA_ACCEPT = "image/jpeg,image/png,image/webp,image/avif";
export const MEDIA_TYPES_LABEL = "JPEG, PNG, WebP, AVIF";

export interface MediaLibraryProps {
  items: LibraryItem[];
  folders: LibraryFolder[];
  canWrite: boolean;
  /** Filtrul de folder din URL: `null` = toate, `"root"` = fără folder, altfel id. */
  currentFolder: string | null;
  totalCount: number;
  maxUploadMb: number;
  /** Adresele de navigare pe folder, păstrând căutarea și starea (calculate pe server). */
  folderHrefs: Record<string, string>;
}

/**
 * Biblioteca media (partea interactivă): grid, încărcări, detalii, foldere. Lista vine de la server
 * (filtrare, căutare și paginare sunt în URL, deci funcționează și fără JS); aici se adaugă
 * actualizarea automată a statusului și încărcările cu progres. Grid-ul, coada de încărcări și
 * interogarea de status sunt aceleași ca în selectorul `MediaPicker`.
 */
export function MediaLibrary({
  items: initialItems,
  folders,
  canWrite,
  currentFolder,
  totalCount,
  maxUploadMb,
  folderHrefs,
}: MediaLibraryProps) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lista de la server înlocuiește starea locală la fiecare navigare / refresh.
  useEffect(() => setItems(initialItems), [initialItems]);

  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => router.refresh(), 400);
  }, [router]);

  const uploader = useMediaUploads({
    folderId: currentFolder && currentFolder !== "root" ? currentFolder : null,
    onUploaded: refreshSoon,
  });

  // Statusul pending/processing se actualizează singur.
  const pendingIds = items
    .filter((i) => i.status === "pending" || i.status === "processing")
    .map((i) => i.id);
  useStatusPolling(pendingIds, (fresh) => {
    const byId = new Map(fresh.map((i) => [i.id, i]));
    let becameReady = false;
    setItems((current) =>
      current.map((item) => {
        const next = byId.get(item.id);
        if (!next) return item;
        if (next.status === "ready" && item.status !== "ready") becameReady = true;
        return next;
      }),
    );
    if (becameReady) setAnnouncement(m.live.ready);
  });

  useEffect(() => {
    const done = uploader.uploads.filter((u) => u.status === "done").length;
    if (done > 0) setAnnouncement(m.live.uploaded(done));
  }, [uploader.uploads]);

  const selected = items.find((i) => i.id === selectedId) ?? null;

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <aside className="flex flex-col gap-6">
        <FolderPanel
          folders={folders}
          current={currentFolder}
          totalCount={totalCount}
          hrefFor={(folder) => folderHrefs[folder ?? "all"] ?? "/admin/media"}
          canWrite={canWrite}
          onChanged={() => router.refresh()}
        />
        {canWrite && (
          <UploadPanel
            items={uploader.uploads}
            rules={m.upload.rules(maxUploadMb, MEDIA_TYPES_LABEL)}
            accept={MEDIA_ACCEPT}
            onFiles={uploader.add}
            onRetry={uploader.retry}
            onRemove={uploader.remove}
            onClear={uploader.clearFinished}
          />
        )}
      </aside>

      <div className="flex min-w-0 flex-col gap-4">
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {canWrite && totalCount === 0 ? m.grid.empty : m.grid.emptyFiltered}
          </p>
        ) : (
          <MediaGrid label={m.grid.label}>
            {items.map((item) => (
              <MediaCard key={item.id} item={item} onOpen={setSelectedId} />
            ))}
          </MediaGrid>
        )}
      </div>

      <MediaDetailDialog
        item={selected}
        folders={folders}
        canWrite={canWrite}
        onClose={() => setSelectedId(null)}
        onChanged={(updated) => {
          setItems((current) => current.map((i) => (i.id === updated.id ? updated : i)));
          router.refresh();
        }}
        onRegenerated={(id) => {
          setItems((current) =>
            current.map((i) =>
              i.id === id ? { ...i, status: "pending", processingError: null } : i,
            ),
          );
        }}
        onDeleted={(id) => {
          setSelectedId(null);
          setItems((current) => current.filter((i) => i.id !== id));
          setAnnouncement(m.delete.deleted);
          router.refresh();
        }}
      />
    </div>
  );
}
