"use client";

import { ArrowDown, ArrowUp, GripVertical, Pencil, Trash2, MoveRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button, Dialog, Label, Select, cn } from "@ecom/ui";
import { deleteCategory, moveCategory } from "@/app/(admin)/admin/produse/categorii/actions";
import {
  dropTarget,
  stepTarget,
  zoneFromOffset,
  type DropTarget,
  type DropZone,
} from "@/lib/category-dnd";
import { getMessages } from "@/messages";
import { CategoryFormDialog } from "./category-form-dialog";
import type { CategoryCapabilities, CategoryRow } from "./category-types";

const m = getMessages().admin.categories;

interface Props {
  rows: CategoryRow[];
  capabilities: CategoryCapabilities;
  maxDepth: number;
  thumbs: Record<string, string>;
  /** Categoria al cărei editor se deschide la încărcare (`?edit=<id>`, ex. din biblioteca media). */
  editId: string | null;
}

interface DragOver {
  id: string;
  zone: DropZone;
}

/**
 * Arborele de categorii: glisare (HTML5 nativ, fără bibliotecă) ȘI alternativă completă de tastatură
 * („Mută sus/jos”, „Mută…” cu alegerea părintelui și a poziției). Serverul validează orice mutare;
 * interfața afișează doar locurile permise. Anunțurile pentru cititoare de ecran merg printr-o zonă
 * `aria-live`.
 */
export function CategoryManager({ rows, capabilities, maxDepth, thumbs, editId }: Props) {
  const router = useRouter();
  const [formTarget, setFormTarget] = useState<CategoryRow | "new" | null>(null);
  const [moveTarget, setMoveTarget] = useState<CategoryRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CategoryRow | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<DragOver | null>(null);
  const [pending, startTransition] = useTransition();
  const openedFromUrl = useRef(false);

  const byId = new Map(rows.map((r) => [r.id, r]));
  const nameOf = (id: string | null): string | null => (id ? (byId.get(id)?.name ?? null) : null);

  // Deschide editorul cerut prin `?edit=<id>` (o singură dată).
  useEffect(() => {
    if (openedFromUrl.current || !editId) return;
    const row = byId.get(editId);
    if (row) {
      openedFromUrl.current = true;
      setFormTarget(row);
    }
  });

  const errorText = (result: { code: string; message?: string }): string =>
    (m.errors as Record<string, string>)[result.code] ?? result.message ?? m.errors.generic;

  const runMove = (row: CategoryRow, target: DropTarget) => {
    startTransition(async () => {
      setProblem(null);
      try {
        const result = await moveCategory({
          id: row.id,
          parentId: target.parentId,
          ...(target.index !== undefined && { index: target.index }),
        });
        if (result.ok) {
          const position = (target.index ?? Number.MAX_SAFE_INTEGER) + 1;
          const parentName = nameOf(target.parentId);
          setAnnouncement(
            row.parentId === target.parentId
              ? m.live.reordered(row.name, Math.min(position, row.siblingCount))
              : m.live.moved(row.name, parentName, Math.min(position, 99)),
          );
          setMoveTarget(null);
          router.refresh();
        } else {
          setProblem(errorText(result));
        }
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  const runDelete = (row: CategoryRow) => {
    startTransition(async () => {
      try {
        const result = await deleteCategory({ id: row.id });
        if (result.ok) {
          setDeleteTarget(null);
          setAnnouncement(m.live.deleted(row.name));
          router.refresh();
        } else {
          setDeleteTarget(null);
          setProblem(errorText(result));
        }
      } catch {
        setDeleteTarget(null);
        setProblem(m.errors.generic);
      }
    });
  };

  const onDrop = (event: React.DragEvent, overRow: CategoryRow) => {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData("text/plain") || dragging;
    const dragged = draggedId ? byId.get(draggedId) : undefined;
    const zone = over?.zone ?? "inside";
    setDragging(null);
    setOver(null);
    if (!dragged) return;
    const target = dropTarget(dragged, overRow, zone);
    if (!target) {
      setProblem(m.errors.NOT_ALLOWED);
      return;
    }
    runMove(dragged, target);
  };

  const onRootDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const draggedId = event.dataTransfer.getData("text/plain") || dragging;
    const dragged = draggedId ? byId.get(draggedId) : undefined;
    setDragging(null);
    setOver(null);
    if (!dragged) return;
    if (!dragged.validParentIds.includes(null)) {
      setProblem(m.errors.NOT_ALLOWED);
      return;
    }
    runMove(dragged, { parentId: null, index: undefined });
  };

  const { structure } = capabilities;
  const canEditAnything = capabilities.content || structure;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {structure && <p className="text-sm text-muted-foreground">{m.dragHint}</p>}
        {structure && (
          <Button onClick={() => setFormTarget("new")} disabled={pending}>
            {m.create}
          </Button>
        )}
      </div>

      {problem && (
        <p
          role="alert"
          data-problem
          className="rounded-md border border-danger p-3 text-sm text-danger"
        >
          {problem}
        </p>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {rows.length === 0 ? (
        <p className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
          {m.empty}
        </p>
      ) : (
        <ul aria-label={m.treeLabel} className="flex flex-col gap-1" data-category-tree>
          {rows.map((row) => {
            const isOver = over?.id === row.id;
            return (
              <li
                key={row.id}
                data-category-row={row.id}
                data-category-name={row.name}
                draggable={structure}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", row.id);
                  e.dataTransfer.effectAllowed = "move";
                  setDragging(row.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onDragOver={(e) => {
                  if (!structure || !dragging) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setOver({ id: row.id, zone: zoneFromOffset(e.clientY - rect.top, rect.height) });
                }}
                onDragLeave={() => setOver((current) => (current?.id === row.id ? null : current))}
                onDrop={(e) => onDrop(e, row)}
                style={{ marginInlineStart: `${row.depth * 1.5}rem` }}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-md border bg-background p-2",
                  dragging === row.id && "opacity-50",
                  isOver && over?.zone === "inside" && "border-primary bg-primary/10",
                  isOver && over?.zone === "before" && "border-t-4 border-t-primary",
                  isOver && over?.zone === "after" && "border-b-4 border-b-primary",
                  !isOver && "border-border",
                )}
              >
                {structure && (
                  <GripVertical
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground"
                  />
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{row.name}</span>
                  {/[>|]/.test(row.name) && (
                    <span role="note" data-category-name-warning className="text-xs text-danger">
                      {m.nameCharsWarning}
                    </span>
                  )}
                  <span className="truncate text-xs text-muted-foreground">
                    /{row.path} · {m.products(row.productCount)} · {m.level(row.depth)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {structure && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={m.actions.up(row.name)}
                        disabled={pending || stepTarget(row, "up") === null}
                        onClick={() => {
                          const t = stepTarget(row, "up");
                          if (t) runMove(row, t);
                        }}
                      >
                        <ArrowUp aria-hidden="true" className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={m.actions.down(row.name)}
                        disabled={pending || stepTarget(row, "down") === null}
                        onClick={() => {
                          const t = stepTarget(row, "down");
                          if (t) runMove(row, t);
                        }}
                      >
                        <ArrowDown aria-hidden="true" className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={m.actions.moveTo(row.name)}
                        onClick={() => setMoveTarget(row)}
                      >
                        <MoveRight aria-hidden="true" className="h-4 w-4" />
                        <span className="ml-1 hidden sm:inline">{m.actions.moveToLabel}</span>
                      </Button>
                    </>
                  )}
                  {canEditAnything && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={m.actions.edit(row.name)}
                      onClick={() => setFormTarget(row)}
                    >
                      <Pencil aria-hidden="true" className="h-4 w-4" />
                      <span className="ml-1 hidden sm:inline">{m.actions.editLabel}</span>
                    </Button>
                  )}
                  {structure && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={m.actions.delete(row.name)}
                      onClick={() => setDeleteTarget(row)}
                    >
                      <Trash2 aria-hidden="true" className="h-4 w-4" />
                      <span className="ml-1 hidden sm:inline">{m.actions.deleteLabel}</span>
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {structure && dragging && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={onRootDrop}
          data-category-root-drop
          className="rounded-md border border-dashed border-primary p-3 text-center text-sm text-primary"
        >
          {m.rootDrop}
        </div>
      )}

      <CategoryFormDialog
        target={formTarget}
        rows={rows}
        capabilities={capabilities}
        maxDepth={maxDepth}
        thumbs={thumbs}
        onClose={() => setFormTarget(null)}
        onSaved={(message) => {
          setFormTarget(null);
          setAnnouncement(message);
          router.refresh();
        }}
      />

      <MoveDialog
        row={moveTarget}
        rows={rows}
        pending={pending}
        onClose={() => setMoveTarget(null)}
        onMove={(row, target) => runMove(row, target)}
      />

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={deleteTarget ? m.delete.title(deleteTarget.name) : ""}
        description={m.delete.description}
        closeLabel={m.form.close}
        className="max-w-md"
      >
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setDeleteTarget(null)}>
            {m.delete.cancel}
          </Button>
          <Button
            disabled={pending}
            onClick={() => deleteTarget && runDelete(deleteTarget)}
            className="bg-danger text-primary-foreground hover:bg-danger/90"
          >
            {pending ? m.delete.deleting : m.delete.confirm}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/** Alternativa de tastatură a glisării: alege părintele permis și poziția între frați. */
function MoveDialog({
  row,
  rows,
  pending,
  onClose,
  onMove,
}: {
  row: CategoryRow | null;
  rows: readonly CategoryRow[];
  pending: boolean;
  onClose: () => void;
  onMove: (row: CategoryRow, target: DropTarget) => void;
}) {
  const [parent, setParent] = useState<string>("");
  const [position, setPosition] = useState<string>("last");

  useEffect(() => {
    if (!row) return;
    setParent(row.parentId ?? "");
    setPosition("last");
  }, [row?.id]);

  if (!row) {
    return (
      <Dialog open={false} onClose={onClose} title="" closeLabel={m.form.close}>
        {null}
      </Dialog>
    );
  }

  const parentId = parent === "" ? null : parent;
  const options = rows.filter((r) => row.validParentIds.includes(r.id));
  const canRoot = row.validParentIds.includes(null);
  // frații noului părinte, fără categoria mutată, în ordinea afișării
  const siblings = rows
    .filter((r) => r.parentId === parentId && r.id !== row.id)
    .sort((a, b) => a.index - b.index);

  const submit = () => {
    let index: number | undefined;
    if (position === "first") index = 0;
    else if (position.startsWith("after:")) {
      const afterId = position.slice("after:".length);
      const at = siblings.findIndex((s) => s.id === afterId);
      index = at === -1 ? undefined : at + 1;
    }
    onMove(row, { parentId, index });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={m.move.title(row.name)}
      description={m.move.description}
      closeLabel={m.form.close}
      className="max-w-md"
    >
      {options.length === 0 && !canRoot ? (
        <p className="text-sm">{m.move.noOptions}</p>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="move-parent">{m.move.parent}</Label>
            <Select
              id="move-parent"
              value={parent}
              onChange={(e) => {
                setParent(e.target.value);
                setPosition("last");
              }}
            >
              {canRoot && <option value="">{m.form.parentRoot}</option>}
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {"  ".repeat(o.depth)}
                  {o.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="move-position">{m.move.position}</Label>
            <Select
              id="move-position"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
            >
              <option value="first">{m.move.first}</option>
              {siblings.map((s) => (
                <option key={s.id} value={`after:${s.id}`}>
                  {m.move.after(s.name)}
                </option>
              ))}
              <option value="last">{m.move.last}</option>
            </Select>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {m.form.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? m.move.moving : m.move.submit}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
