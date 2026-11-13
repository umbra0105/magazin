"use client";

import { useEffect, useState, useTransition } from "react";
import { Badge, Button, Dialog, Input, Label, Select, Textarea } from "@ecom/ui";
import { getMessages } from "@/messages";
import { deleteMedia, regenerateMedia, updateMedia } from "@/app/(admin)/admin/media/actions";
import {
  actionErrorMessage,
  flattenFolders,
  formatBytes,
  formatDate,
  type LibraryFolder,
  type LibraryItem,
  type MediaUsage,
} from "./media-types";

const m = getMessages().admin.media;

interface Props {
  item: LibraryItem | null;
  folders: readonly LibraryFolder[];
  canWrite: boolean;
  onClose: () => void;
  onChanged: (item: LibraryItem) => void;
  onDeleted: (id: string) => void;
  onRegenerated: (id: string) => void;
}

/**
 * Detalii, editare (alt-text, taguri, folder), regenerare și ștergere pentru un fișier.
 * Utilizatorul doar cu `media.read` vede informațiile, dar nu și câmpurile editabile sau butoanele de
 * scriere; serverul refuză oricum orice scriere fără `media.write`.
 */
export function MediaDetailDialog({
  item,
  folders,
  canWrite,
  onClose,
  onChanged,
  onDeleted,
  onRegenerated,
}: Props) {
  const [alt, setAlt] = useState("");
  const [tags, setTags] = useState("");
  const [folderId, setFolderId] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [usages, setUsages] = useState<readonly MediaUsage[] | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!item) return;
    setAlt(item.alt);
    setTags(item.tags.join(", "));
    setFolderId(item.folderId ?? "");
    setMessage(null);
    setConfirmDelete(false);
    setUsages(null);
  }, [item?.id]); // resetăm doar la schimbarea fișierului

  if (!item)
    return (
      <Dialog open={false} onClose={onClose} title="" closeLabel={m.detail.close}>
        {null}
      </Dialog>
    );

  const save = () => {
    startTransition(async () => {
      setMessage(null);
      try {
        const result = await updateMedia({
          id: item.id,
          alt,
          tags: tags.split(",").map((t) => t.trim()),
          folderId: folderId === "" ? null : folderId,
        });
        if (result.ok) {
          onChanged(result.item);
          setMessage({ kind: "ok", text: m.detail.saved });
        } else {
          setMessage({ kind: "error", text: actionErrorMessage(result) });
        }
      } catch {
        setMessage({ kind: "error", text: m.errors.generic });
      }
    });
  };

  const regenerate = () => {
    startTransition(async () => {
      setMessage(null);
      try {
        const result = await regenerateMedia({ id: item.id });
        if (result.ok) {
          onRegenerated(item.id);
          setMessage({ kind: "ok", text: m.detail.regenerated });
        } else {
          setMessage({ kind: "error", text: actionErrorMessage(result) });
        }
      } catch {
        setMessage({ kind: "error", text: m.errors.generic });
      }
    });
  };

  const remove = () => {
    startTransition(async () => {
      try {
        const result = await deleteMedia({ id: item.id });
        if (result.ok) {
          setConfirmDelete(false);
          onDeleted(item.id);
        } else if (result.code === "IN_USE" && result.usages) {
          setUsages(result.usages);
        } else {
          setConfirmDelete(false);
          setMessage({ kind: "error", text: actionErrorMessage(result) });
        }
      } catch {
        setConfirmDelete(false);
        setMessage({ kind: "error", text: m.errors.generic });
      }
    });
  };

  const failedReason =
    item.status === "failed" && item.processingError
      ? ((m.processingErrors as Record<string, string>)[item.processingError] ??
        m.processingErrors.UNEXPECTED)
      : null;
  const folderOptions = flattenFolders(folders);
  const status = item.status as keyof typeof m.status;

  return (
    <>
      <Dialog
        open={!confirmDelete}
        onClose={onClose}
        title={item.originalName}
        description={m.detail.description}
        closeLabel={m.detail.close}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex flex-col gap-2 sm:w-56 sm:shrink-0">
              <div
                className="aspect-[4/3] w-full overflow-hidden rounded-lg border border-line-subtle bg-surface-subtle"
                style={
                  item.placeholder
                    ? { backgroundImage: `url(${item.placeholder})`, backgroundSize: "cover" }
                    : undefined
                }
              >
                {item.thumb && (
                  // eslint-disable-next-line @next/next/no-img-element -- thumb generat de worker
                  <img
                    src={item.thumb.url}
                    alt={item.alt}
                    width={item.thumb.width}
                    height={item.thumb.height}
                    className="size-full object-cover"
                  />
                )}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body">
                <dt className="text-ink-secondary">{m.detail.dimensions}</dt>
                <dd>{item.width && item.height ? `${item.width} × ${item.height}` : "—"}</dd>
                <dt className="text-ink-secondary">{m.detail.size}</dt>
                <dd>{formatBytes(item.sizeBytes)}</dd>
                <dt className="text-ink-secondary">{m.detail.type}</dt>
                <dd>{item.mime}</dd>
                <dt className="text-ink-secondary">{m.detail.uploaded}</dt>
                <dd>{formatDate(item.createdAt)}</dd>
              </dl>
              <Badge
                variant={
                  item.status === "ready"
                    ? "success"
                    : item.status === "failed"
                      ? "danger"
                      : item.status === "processing"
                        ? "info"
                        : "neutral"
                }
                className="self-start"
              >
                {m.status[status] ?? item.status}
              </Badge>
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-4">
              {failedReason && (
                <div
                  role="alert"
                  className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
                >
                  <p className="font-medium">{m.detail.failedTitle}</p>
                  <p>{failedReason}</p>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="media-alt">{m.detail.alt}</Label>
                <Textarea
                  id="media-alt"
                  value={alt}
                  onChange={(e) => setAlt(e.target.value)}
                  readOnly={!canWrite}
                  maxLength={300}
                  aria-describedby="media-alt-hint"
                />
                <p id="media-alt-hint" className="text-label text-ink-secondary">
                  {alt.trim() === "" && <strong>{m.detail.altMissing} </strong>}
                  {m.detail.altHint}
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="media-tags">{m.detail.tags}</Label>
                <Input
                  id="media-tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  readOnly={!canWrite}
                  aria-describedby="media-tags-hint"
                />
                <p id="media-tags-hint" className="text-label text-ink-secondary">
                  {m.detail.tagsHint}
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="media-folder">{m.detail.folder}</Label>
                <Select
                  id="media-folder"
                  value={folderId}
                  onChange={(e) => setFolderId(e.target.value)}
                  disabled={!canWrite}
                >
                  <option value="">{m.filters.noFolder}</option>
                  {folderOptions.map(({ folder, depth }) => (
                    <option key={folder.id} value={folder.id}>
                      {`${"  ".repeat(depth)}${folder.name}`}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </div>

          <p role="status" aria-live="polite" className="text-body empty:hidden">
            {message && (
              <span
                className={
                  message.kind === "error" ? "text-tone-problem-fg" : "text-tone-success-fg"
                }
              >
                {message.text}
              </span>
            )}
          </p>

          {canWrite && (
            <div data-media-actions className="flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="ghost"
                onClick={() => setConfirmDelete(true)}
                disabled={pending}
                className="text-tone-problem-fg"
              >
                {m.detail.delete}
              </Button>
              <div className="ml-auto flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={regenerate} disabled={pending}>
                  {m.detail.regenerate}
                </Button>
                <Button onClick={save} disabled={pending}>
                  {pending ? m.detail.saving : m.detail.save}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Dialog>

      <Dialog
        open={confirmDelete}
        onClose={() => {
          setConfirmDelete(false);
          setUsages(null);
        }}
        title={usages ? m.delete.inUseTitle : m.delete.title}
        description={usages ? m.delete.inUseDescription : m.delete.description}
        closeLabel={m.detail.close}
        className="max-w-md"
      >
        {usages ? (
          <ul className="flex flex-col gap-1 text-body">
            {usages.map((u, i) => (
              <li key={`${u.kind}-${i}`} className="rounded-lg border border-line-subtle p-2">
                {u.href ? (
                  <a href={u.href} className="text-link underline">
                    {u.label}
                  </a>
                ) : (
                  u.label
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body">
            <strong>{item.originalName}</strong>
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setConfirmDelete(false);
              setUsages(null);
            }}
          >
            {m.delete.cancel}
          </Button>
          {!usages && (
            <Button variant="destructive" onClick={remove} disabled={pending}>
              {pending ? m.delete.deleting : m.delete.confirm}
            </Button>
          )}
        </div>
      </Dialog>
    </>
  );
}
