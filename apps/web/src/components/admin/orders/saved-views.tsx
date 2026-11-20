"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Button, Dialog, Input, Label } from "@ecom/ui";
import {
  deleteViewAction,
  renameViewAction,
  saveViewAction,
  type ViewResult,
} from "@/app/(admin)/admin/comenzi/lista-actions";
import { getMessages } from "@/messages";

const t = getMessages().admin.orders;

export interface SavedViewItem {
  id: string;
  name: string;
  query: string;
}

const failureText = (result: Extract<ViewResult, { ok: false }>): string =>
  result.code === "name"
    ? t.saved.nameRequired
    : result.code === "duplicate"
      ? t.saved.duplicate
      : result.code === "limit"
        ? t.saved.limit
        : t.saved.failed;

/**
 * Vederile proprii ale utilizatorului: salvarea filtrelor de acum, redenumirea și ștergerea. Fiecare operație se face pe server
 * doar pentru utilizatorul curent (nu se pot atinge vederile altuia); aici nu există nicio verificare de drepturi în plus.
 */
export function SavedViewsManager({
  views,
  currentQuery,
}: {
  views: SavedViewItem[];
  currentQuery: string;
}) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SavedViewItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<SavedViewItem | null>(null);
  const [pending, start] = useTransition();

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setStatus(null);
    if (name.trim() === "" || name.trim().length > 40) {
      setError(t.saved.nameRequired);
      return document.getElementById(`${id}-name`)?.focus();
    }
    setError(null);
    start(async () => {
      const result = await saveViewAction({ name, query: currentQuery });
      if (result.ok) {
        setName("");
        setStatus(t.saved.done);
        router.refresh();
      } else setError(failureText(result));
    });
  };

  const rename = (event: FormEvent) => {
    event.preventDefault();
    if (!renaming || pending) return;
    if (renameValue.trim() === "" || renameValue.trim().length > 40) {
      setError(t.saved.nameRequired);
      return;
    }
    const target = renaming;
    start(async () => {
      const result = await renameViewAction({ id: target.id, name: renameValue });
      if (result.ok) {
        setRenaming(null);
        setError(null);
        router.refresh();
      } else setError(failureText(result));
    });
  };

  const remove = () => {
    if (!deleting) return;
    const target = deleting;
    start(async () => {
      const result = await deleteViewAction({ id: target.id });
      setDeleting(null);
      if (result.ok) router.refresh();
      else setError(failureText(result));
    });
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t.saved.title}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t.saved.title}
        closeLabel={t.actions.close}
        className="max-w-lg"
      >
        <div className="flex flex-col gap-4">
          {views.length === 0 ? (
            <p className="text-body text-ink-secondary">{t.saved.empty}</p>
          ) : (
            <ul className="flex flex-col gap-2" data-saved-views>
              {views.map((view) => (
                <li
                  key={view.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-subtle p-2"
                >
                  <Link
                    href={view.query ? `/admin/comenzi?${view.query}` : "/admin/comenzi"}
                    className="min-w-0 flex-1 truncate text-link underline-offset-2 hover:underline"
                    onClick={() => setOpen(false)}
                  >
                    {view.name}
                  </Link>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setRenaming(view);
                      setRenameValue(view.name);
                      setError(null);
                    }}
                  >
                    {t.saved.rename}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setDeleting(view)}>
                    {t.saved.delete}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form noValidate onSubmit={save} className="flex flex-col gap-2">
            <Label htmlFor={`${id}-name`}>{t.saved.name}</Label>
            <Input
              id={`${id}-name`}
              maxLength={40}
              autoComplete="off"
              value={name}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${id}-help`}
              onChange={(event) => setName(event.target.value)}
            />
            <span id={`${id}-help`} className="text-label text-ink-secondary">
              {t.saved.nameHelp}
            </span>
            {error && (
              <p role="alert" className="text-label text-tone-problem-fg">
                {error}
              </p>
            )}
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={pending}>
                {t.saved.save}
              </Button>
              <span role="status" aria-live="polite" className="text-body text-ink-secondary">
                {status}
              </span>
            </div>
          </form>
        </div>
      </Dialog>
      <Dialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title={t.saved.renameTitle}
        closeLabel={t.actions.close}
        className="max-w-md"
      >
        <form noValidate onSubmit={rename} className="flex flex-col gap-3">
          <Label htmlFor={`${id}-rename`}>{t.saved.name}</Label>
          <Input
            id={`${id}-rename`}
            maxLength={40}
            autoComplete="off"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
          />
          {error && (
            <p role="alert" className="text-label text-tone-problem-fg">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRenaming(null)}>
              {t.saved.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {t.saved.rename}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t.saved.deleteTitle}
        description={deleting ? t.saved.deleteBody(deleting.name) : undefined}
        closeLabel={t.actions.close}
        className="max-w-md"
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setDeleting(null)}>
            {t.saved.cancel}
          </Button>
          <Button type="button" variant="destructive" onClick={remove} disabled={pending}>
            {t.saved.delete}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
