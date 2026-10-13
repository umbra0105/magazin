import type { Metadata } from "next";
import Link from "next/link";
import { MEDIA_STATUSES, can, type MediaListStatus } from "@ecom/core";
import { Button, Input, Label, Select, buttonVariants } from "@ecom/ui";
import { MediaLibrary } from "@/components/admin/media/media-library";
import { flattenFolders } from "@/components/admin/media/media-types";
import { requireAdmin } from "@/lib/admin-page";
import { getMediaLibrary } from "@/lib/media";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.media;

export const metadata: Metadata = { title: m.title };

type SearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? "";

/**
 * Biblioteca media. Pagina cere `media.read`; butoanele de scriere apar doar cu `media.write`
 * (serverul refuză oricum). Căutarea, filtrele și pagina sunt în URL (formular GET), deci merg și
 * fără JavaScript și se pot trimite ca link.
 */
export default async function MediaPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const subject = await requireAdmin({ permission: "media.read" });
  const params = await searchParams;

  const q = first(params["q"]).trim().slice(0, 100);
  const folderParam = first(params["folder"]);
  const statusParam = first(params["status"]);
  const status = (MEDIA_STATUSES as readonly string[]).includes(statusParam)
    ? (statusParam as MediaListStatus)
    : undefined;
  const page = Math.max(Number.parseInt(first(params["page"]), 10) || 1, 1);

  const library = getMediaLibrary();
  const [result, folders, maxUploadBytes] = await Promise.all([
    library.list(subject, {
      page,
      ...(q && { q }),
      ...(folderParam && { folder: folderParam }),
      ...(status && { status }),
    }),
    library.folders(subject),
    getSettings().get("media.maxUploadBytes"),
  ]);

  const canWrite = can(subject, "media.write");
  const hrefWith = (overrides: { folder?: string | null; page?: number }) => {
    const search = new URLSearchParams();
    if (q) search.set("q", q);
    if (status) search.set("status", status);
    const folder = overrides.folder === undefined ? folderParam : (overrides.folder ?? "");
    if (folder) search.set("folder", folder);
    if (overrides.page && overrides.page > 1) search.set("page", String(overrides.page));
    const query = search.toString();
    return `/admin/media${query ? `?${query}` : ""}`;
  };

  const folderHrefs: Record<string, string> = {
    all: hrefWith({ folder: null }),
    root: hrefWith({ folder: "root" }),
    ...Object.fromEntries(folders.map((f) => [f.id, hrefWith({ folder: f.id })])),
  };
  const filtered = Boolean(q || folderParam || status);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{m.title}</h1>
        <p className="text-sm text-muted-foreground">{m.description}</p>
        {!canWrite && (
          <p role="note" className="mt-2 rounded-md border border-border bg-border/30 p-3 text-sm">
            {m.readOnly}
          </p>
        )}
      </header>

      <form
        method="get"
        action="/admin/media"
        role="search"
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor="media-q">{m.search.label}</Label>
          <Input
            id="media-q"
            name="q"
            type="search"
            defaultValue={q}
            placeholder={m.search.placeholder}
            maxLength={100}
          />
        </div>
        <div className="flex min-w-40 flex-col gap-1.5">
          <Label htmlFor="media-folder-filter">{m.filters.folder}</Label>
          <Select id="media-folder-filter" name="folder" defaultValue={folderParam}>
            <option value="">{m.filters.allFolders}</option>
            <option value="root">{m.filters.noFolder}</option>
            {flattenFolders(folders).map(({ folder, depth }) => (
              <option key={folder.id} value={folder.id}>
                {`${"  ".repeat(depth)}${folder.name}`}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex min-w-36 flex-col gap-1.5">
          <Label htmlFor="media-status-filter">{m.filters.status}</Label>
          <Select id="media-status-filter" name="status" defaultValue={status ?? ""}>
            <option value="">{m.filters.allStatuses}</option>
            {MEDIA_STATUSES.map((s) => (
              <option key={s} value={s}>
                {m.status[s]}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit">{m.search.submit}</Button>
        {filtered && (
          <Link href="/admin/media" className={buttonVariants({ variant: "outline" })}>
            {m.search.reset}
          </Link>
        )}
      </form>

      <p className="text-sm text-muted-foreground">{m.total(result.total)}</p>

      <MediaLibrary
        items={result.items}
        folders={folders}
        canWrite={canWrite}
        currentFolder={folderParam ? folderParam : null}
        totalCount={result.total}
        maxUploadMb={Math.max(Math.round(maxUploadBytes / (1024 * 1024)), 1)}
        folderHrefs={folderHrefs}
      />

      {result.pageCount > 1 && (
        <nav aria-label={m.grid.pagination} className="flex items-center justify-between gap-3">
          {result.page > 1 ? (
            <Link
              href={hrefWith({ page: result.page - 1 })}
              rel="prev"
              className={buttonVariants({ variant: "outline" })}
            >
              {m.grid.previous}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm" aria-current="page">
            {m.grid.pageOf(result.page, result.pageCount)}
          </span>
          {result.page < result.pageCount ? (
            <Link
              href={hrefWith({ page: result.page + 1 })}
              rel="next"
              className={buttonVariants({ variant: "outline" })}
            >
              {m.grid.next}
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
