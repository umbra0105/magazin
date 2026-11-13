import type { Metadata } from "next";
import Link from "next/link";
import { MEDIA_STATUSES, can, type MediaListStatus } from "@ecom/core";
import { Button, buttonVariants, cn } from "@ecom/ui";
import { MediaFilterFields } from "@/components/admin/media/media-filter-fields";
import { MediaLibrary } from "@/components/admin/media/media-library";
import { PageHeader } from "@/components/admin/page-header";
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
      <PageHeader
        title={m.title}
        count={result.total}
        description={m.description}
        notes={canWrite ? [] : [m.readOnly]}
      />

      <form
        method="get"
        action="/admin/media"
        role="search"
        className="grid grid-cols-4 items-end gap-3 sm:flex sm:flex-wrap"
      >
        <MediaFilterFields
          idPrefix="media-filter"
          folders={folders}
          q={q}
          folder={folderParam}
          status={status ?? ""}
        />
        <Button
          type="submit"
          variant="outline"
          className="col-start-4 row-start-1 px-3 sm:col-auto sm:row-auto sm:px-4"
        >
          {m.search.submit}
        </Button>
        {filtered && (
          <Link
            href="/admin/media"
            className={cn(
              // pe telefon: acțiune mică sub filtre; de la `sm` în sus: aceeași mărime ca «Caută», pe același rând
              buttonVariants({ variant: "outline", size: "sm" }),
              "col-span-4 justify-self-start sm:col-auto sm:h-(--control-h) sm:px-4 sm:text-(length:--button-text)",
            )}
          >
            {m.search.reset}
          </Link>
        )}
      </form>

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
        <nav
          aria-label={m.grid.pagination}
          className="flex flex-wrap items-center justify-between gap-2"
        >
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
          <span
            className="order-last w-full text-center text-body sm:order-none sm:w-auto"
            aria-current="page"
          >
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
