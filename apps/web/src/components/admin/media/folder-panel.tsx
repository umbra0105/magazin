"use client";

import { Folder, FolderPlus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { Button, Dialog, Input, Label, Select, cn } from "@ecom/ui";
import { getMessages } from "@/messages";
import {
  createMediaFolder,
  moveMediaFolder,
  renameMediaFolder,
} from "@/app/(admin)/admin/media/actions";
import {
  actionErrorMessage,
  flattenFolders,
  movableTargets,
  type LibraryFolder,
} from "./media-types";

const m = getMessages().admin.media;

type Mode =
  | { kind: "create" }
  | { kind: "rename"; folder: LibraryFolder }
  | { kind: "move"; folder: LibraryFolder }
  | null;

/**
 * Arborele de foldere: navigarea e prin linkuri (filtrul din URL), iar crearea, redenumirea și
 * mutarea prin dialoguri. Fără `media.write` nu există butoane de scriere.
 */
export function FolderPanel({
  folders,
  current,
  totalCount,
  hrefFor,
  canWrite,
  onChanged,
}: {
  folders: readonly LibraryFolder[];
  /** `null` = toate, `"root"` = fără folder, altfel id-ul folderului. */
  current: string | null;
  totalCount: number | null;
  hrefFor: (folder: string | null) => string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setError(null);
    if (mode?.kind === "create") {
      setName("");
      setParentId(current && current !== "root" ? current : "");
    } else if (mode?.kind === "rename") {
      setName(mode.folder.name);
    } else if (mode?.kind === "move") {
      setParentId(mode.folder.parentId ?? "");
    }
  }, [mode, current]);

  const flat = flattenFolders(folders);

  const submit = () => {
    if (!mode) return;
    startTransition(async () => {
      setError(null);
      try {
        const result =
          mode.kind === "create"
            ? await createMediaFolder({ name, parentId: parentId === "" ? null : parentId })
            : mode.kind === "rename"
              ? await renameMediaFolder({ id: mode.folder.id, name })
              : await moveMediaFolder({
                  id: mode.folder.id,
                  parentId: parentId === "" ? null : parentId,
                });
        if (result.ok) {
          setMode(null);
          onChanged();
        } else {
          setError(actionErrorMessage(result));
        }
      } catch {
        setError(m.errors.generic);
      }
    });
  };

  const itemClass = (active: boolean) =>
    cn(
      "flex min-h-11 flex-1 items-center gap-2 rounded-md px-2 text-sm hover:bg-border/50 " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
      active && "bg-border/60 font-semibold",
    );

  return (
    <nav aria-label={m.folders.nav} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{m.folders.title}</h2>
        {canWrite && (
          <Button size="sm" variant="outline" onClick={() => setMode({ kind: "create" })}>
            <FolderPlus aria-hidden="true" className="size-4" />
            {m.folders.create}
          </Button>
        )}
      </div>
      <ul className="flex flex-col gap-0.5">
        <li>
          <Link
            href={hrefFor(null)}
            aria-current={current === null ? "page" : undefined}
            className={itemClass(current === null)}
          >
            <Folder aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{m.filters.allFolders}</span>
            {totalCount !== null && (
              <span className="ml-auto text-xs text-muted-foreground">{totalCount}</span>
            )}
          </Link>
        </li>
        <li>
          <Link
            href={hrefFor("root")}
            aria-current={current === "root" ? "page" : undefined}
            className={itemClass(current === "root")}
          >
            <Folder aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{m.filters.noFolder}</span>
          </Link>
        </li>
        {flat.map(({ folder, depth }) => (
          <li
            key={folder.id}
            className="flex items-center gap-1"
            style={{ paddingLeft: depth * 12 }}
          >
            <Link
              href={hrefFor(folder.id)}
              aria-current={current === folder.id ? "page" : undefined}
              className={itemClass(current === folder.id)}
            >
              <Folder aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">{folder.name}</span>
              <span className="ml-auto text-xs text-muted-foreground">{folder.mediaCount}</span>
            </Link>
            {canWrite && (
              <span className="flex shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setMode({ kind: "rename", folder })}
                  aria-label={`${m.folders.rename}: ${folder.name}`}
                >
                  {m.folders.rename}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setMode({ kind: "move", folder })}
                  aria-label={`${m.folders.move}: ${folder.name}`}
                >
                  {m.folders.move}
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>

      <Dialog
        open={mode !== null}
        onClose={() => setMode(null)}
        title={
          mode?.kind === "rename"
            ? m.folders.rename
            : mode?.kind === "move"
              ? m.folders.move
              : m.folders.createIn
        }
        closeLabel={m.detail.close}
        className="max-w-md"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {mode?.kind !== "move" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="folder-name">{m.folders.name}</Label>
              <Input
                id="folder-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                autoFocus
                required
              />
            </div>
          )}
          {mode?.kind !== "rename" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="folder-parent">{m.folders.parent}</Label>
              <Select
                id="folder-parent"
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
              >
                <option value="">{m.folders.noParent}</option>
                {(mode?.kind === "move" ? movableTargets(folders, mode.folder.id) : flat).map(
                  ({ folder, depth }) => (
                    <option key={folder.id} value={folder.id}>
                      {`${"  ".repeat(depth)}${folder.name}`}
                    </option>
                  ),
                )}
              </Select>
            </div>
          )}
          <p role="alert" className="min-h-5 text-sm text-danger">
            {error}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setMode(null)}>
              {m.folders.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {m.folders.save}
            </Button>
          </div>
        </form>
      </Dialog>
    </nav>
  );
}
