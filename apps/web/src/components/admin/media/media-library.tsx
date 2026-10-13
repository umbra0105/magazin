"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getMessages } from "@/messages";
import { getMediaStatuses } from "@/app/(admin)/admin/media/actions";
import { UploadQueue, xhrSend, type UploadItem } from "@/lib/media-uploader";
import { MediaDetailDialog } from "./detail-dialog";
import { FolderPanel } from "./folder-panel";
import { MediaCard } from "./media-card";
import type { LibraryFolder, LibraryItem } from "./media-types";
import { UploadPanel } from "./upload-panel";

const m = getMessages().admin.media;

const POLL_MS = 3000;
const ACCEPT = "image/jpeg,image/png,image/webp,image/avif";

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
 * actualizarea automată a statusului și încărcările cu progres.
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
  const [uploads, setUploads] = useState<readonly UploadItem[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const grid = useRef<HTMLUListElement>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lista de la server înlocuiește starea locală la fiecare navigare / refresh.
  useEffect(() => setItems(initialItems), [initialItems]);

  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => router.refresh(), 400);
  }, [router]);

  const queue = useMemo(
    () =>
      new UploadQueue({
        concurrency: 2,
        send: xhrSend,
        onChange: (all) => setUploads([...all]),
        onUploaded: () => refreshSoon(),
      }),
    [refreshSoon],
  );

  // Statusul pending/processing se actualizează singur.
  const pendingIds = items
    .filter((i) => i.status === "pending" || i.status === "processing")
    .map((i) => i.id);
  const pendingKey = pendingIds.join(",");
  useEffect(() => {
    if (pendingIds.length === 0) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const result = await getMediaStatuses(pendingIds);
        if (cancelled || !result.ok) return;
        const fresh = new Map(result.items.map((i) => [i.id, i]));
        let becameReady = false;
        setItems((current) =>
          current.map((item) => {
            const next = fresh.get(item.id);
            if (!next) return item;
            if (next.status === "ready" && item.status !== "ready") becameReady = true;
            return next;
          }),
        );
        if (becameReady) setAnnouncement(m.live.ready);
      } catch {
        // o interogare ratată nu strică pagina; următoarea încearcă din nou
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingKey]);

  useEffect(() => {
    const done = uploads.filter((u) => u.status === "done").length;
    if (done > 0) setAnnouncement(m.live.uploaded(done));
  }, [uploads]);

  const onFiles = (files: File[]) => {
    queue.add(files, {
      folderId: currentFolder && currentFolder !== "root" ? currentFolder : null,
      alt: "",
    });
  };

  // Navigare cu săgețile între carduri (tab rămâne pe un singur card, ca în orice grilă).
  const onGridKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const cards = [
      ...(grid.current?.querySelectorAll<HTMLButtonElement>("[data-media-card]") ?? []),
    ];
    const index = cards.findIndex((c) => c === document.activeElement);
    if (index < 0 || cards.length === 0) return;
    const firstTop = cards[0]?.offsetTop ?? 0;
    const columns = Math.max(cards.filter((c) => c.offsetTop === firstTop).length, 1);
    const delta: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -columns,
      ArrowDown: columns,
    };
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? cards.length - 1
          : Math.min(Math.max(index + (delta[event.key] ?? 0), 0), cards.length - 1);
    event.preventDefault();
    cards[target]?.focus();
  };

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const types = "JPEG, PNG, WebP, AVIF";

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
            items={uploads}
            rules={m.upload.rules(maxUploadMb, types)}
            accept={ACCEPT}
            onFiles={onFiles}
            onRetry={(id) => queue.retry(id)}
            onRemove={(id) => queue.remove(id)}
            onClear={() => queue.clearFinished()}
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
          <ul
            ref={grid}
            aria-label={m.grid.label}
            onKeyDown={onGridKeyDown}
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
          >
            {items.map((item) => (
              <MediaCard key={item.id} item={item} onOpen={setSelectedId} />
            ))}
          </ul>
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
