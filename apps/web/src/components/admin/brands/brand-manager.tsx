"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  Button,
  Dialog,
  EmptyState,
  Input,
  Label,
  RowHeader,
  TBody,
  THead,
  Table,
  Td,
  Textarea,
  Th,
  Tr,
} from "@ecom/ui";
import {
  createBrand,
  deleteBrand,
  updateBrand,
} from "@/app/(admin)/admin/produse/branduri/actions";
import { getMediaStatuses } from "@/app/(admin)/admin/media/actions";
import { MediaPicker } from "@/components/admin/media/media-picker";
import { parseLeadTimeInput, type StockTexts } from "@/components/admin/products/stock-form";
import { daysText } from "@/lib/stock-view";
import { getMessages } from "@/messages";

const m = getMessages().admin.brands;
const stockErrors = getMessages().admin.products.editor.stock.errors;

const LEAD_TEXTS: StockTexts = {
  leadTimeInvalid: stockErrors.leadTimeInvalid,
  leadTimeTooLong: stockErrors.leadTimeTooLong,
  labelTooLong: "",
};

export interface BrandRow {
  id: string;
  name: string;
  slug: string;
  productCount: number;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  logoMediaId: string | null;
  /** Termenul implicit «La comandă» (zile) al produselor brandului; `null` = setarea magazinului. */
  defaultLeadTimeDays: number | null;
  legacyId: string | null;
  legacyUrl: string | null;
}

export interface BrandCapabilities {
  structure: boolean;
  content: boolean;
  legacy: boolean;
  pickMedia: boolean;
}

interface Props {
  rows: BrandRow[];
  capabilities: BrandCapabilities;
  thumbs: Record<string, string>;
  editId: string | null;
}

/** Lista brandurilor cu creare, editare și ștergere (același model de permisiuni ca la categorii). */
export function BrandManager({ rows, capabilities, thumbs, editId }: Props) {
  const router = useRouter();
  const [target, setTarget] = useState<BrandRow | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BrandRow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pending, startTransition] = useTransition();
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current || !editId) return;
    const row = rows.find((r) => r.id === editId);
    if (row) {
      opened.current = true;
      setTarget(row);
    }
  });

  const errorText = (result: { code: string; message?: string }): string =>
    (m.errors as Record<string, string>)[result.code] ?? result.message ?? m.errors.generic;

  const runDelete = (row: BrandRow) => {
    startTransition(async () => {
      try {
        const result = await deleteBrand({ id: row.id });
        setDeleteTarget(null);
        if (result.ok) {
          setProblem(null);
          setAnnouncement(m.live.deleted(row.name));
          router.refresh();
        } else {
          setProblem(errorText(result));
        }
      } catch {
        setDeleteTarget(null);
        setProblem(m.errors.generic);
      }
    });
  };

  const canEdit = capabilities.content || capabilities.structure;
  return (
    <div className="flex flex-col gap-4">
      {capabilities.structure && rows.length > 0 && (
        <div className="flex justify-end">
          <Button onClick={() => setTarget("new")}>{m.create}</Button>
        </div>
      )}
      {problem && (
        <p
          role="alert"
          data-problem
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {problem}
        </p>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {rows.length === 0 ? (
        <EmptyState
          title={m.empty}
          {...(capabilities.structure && {
            action: <Button onClick={() => setTarget("new")}>{m.create}</Button>,
          })}
        />
      ) : (
        <Table stacked aria-label={m.listLabel}>
          <THead>
            <Tr>
              <Th>{m.columns.name}</Th>
              <Th priority="secondary">{m.columns.slug}</Th>
              <Th numeric>{m.columns.products}</Th>
              <Th priority="tertiary">{m.columns.leadTime}</Th>
              {canEdit && <Th numeric>{m.columns.actions}</Th>}
            </Tr>
          </THead>
          <TBody>
            {rows.map((row) => (
              <Tr key={row.id} data-brand-row={row.id}>
                <RowHeader className="font-medium">{row.name}</RowHeader>
                <Td
                  priority="secondary"
                  className="whitespace-nowrap text-ink-secondary"
                  data-cell="slug"
                >
                  <span data-cell-text title={row.slug} className="block max-w-44 truncate">
                    {row.slug}
                  </span>
                </Td>
                <Td numeric className="whitespace-nowrap" data-cell="products">
                  {m.products(row.productCount)}
                </Td>
                <Td
                  priority="tertiary"
                  className="whitespace-nowrap text-ink-secondary"
                  data-cell="lead-time"
                >
                  {row.defaultLeadTimeDays === null
                    ? m.leadTimeCell.none
                    : daysText(row.defaultLeadTimeDays)}
                </Td>
                {canEdit && (
                  <Td stack="actions" data-cell="actions">
                    <div className="flex justify-end gap-1 group-data-[stacked]/table:@max-2xl/table:justify-start">
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={m.actions.edit(row.name)}
                        title={m.actions.editLabel}
                        onClick={() => setTarget(row)}
                      >
                        <Pencil aria-hidden="true" className="size-4" />
                      </Button>
                      {capabilities.structure && (
                        <Button
                          variant="outline"
                          size="icon"
                          aria-label={m.actions.delete(row.name)}
                          title={m.actions.deleteLabel}
                          onClick={() => setDeleteTarget(row)}
                        >
                          <Trash2 aria-hidden="true" className="size-4" />
                        </Button>
                      )}
                    </div>
                  </Td>
                )}
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      <BrandFormDialog
        target={target}
        capabilities={capabilities}
        thumbs={thumbs}
        onClose={() => setTarget(null)}
        onSaved={(message) => {
          setTarget(null);
          setProblem(null);
          setAnnouncement(message);
          router.refresh();
        }}
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
            variant="destructive"
            disabled={pending}
            onClick={() => deleteTarget && runDelete(deleteTarget)}
          >
            {pending ? m.delete.deleting : m.delete.confirm}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function BrandFormDialog({
  target,
  capabilities,
  thumbs,
  onClose,
  onSaved,
}: {
  target: BrandRow | "new" | null;
  capabilities: BrandCapabilities;
  thumbs: Readonly<Record<string, string>>;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const editing = target !== null && target !== "new" ? target : null;
  const isNew = target === "new";
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");
  const [logoMediaId, setLogoMediaId] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [legacyId, setLegacyId] = useState("");
  const [legacyUrl, setLegacyUrl] = useState("");
  const [leadTime, setLeadTime] = useState("");
  const [leadTimeError, setLeadTimeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (target === null) return;
    const row = target === "new" ? null : target;
    setName(row?.name ?? "");
    setSlug(row?.slug ?? "");
    setDescription(row?.description ?? "");
    setSeoTitle(row?.seoTitle ?? "");
    setSeoDescription(row?.seoDescription ?? "");
    setLogoMediaId(row?.logoMediaId ?? null);
    setLogoUrl(row?.logoMediaId ? (thumbs[row.logoMediaId] ?? null) : null);
    setLegacyId(row?.legacyId ?? "");
    setLegacyUrl(row?.legacyUrl ?? "");
    setLeadTime(row?.defaultLeadTimeDays == null ? "" : String(row.defaultLeadTimeDays));
    setLeadTimeError(null);
    setError(null);
  }, [target]);

  if (target === null) {
    return (
      <Dialog open={false} onClose={onClose} title="" closeLabel={m.form.close}>
        {null}
      </Dialog>
    );
  }

  const canEditContent = capabilities.content || capabilities.structure;
  const errorText = (result: { code: string; message?: string }): string =>
    (m.errors as Record<string, string>)[result.code] ?? result.message ?? m.errors.generic;

  const pick = async (ids: string[]) => {
    setPickerOpen(false);
    const id = ids[0];
    if (!id) return;
    setLogoMediaId(id);
    setLogoUrl(null);
    try {
      const result = await getMediaStatuses([id]);
      if (result.ok) setLogoUrl(result.items[0]?.thumb?.url ?? null);
    } catch {
      // previzualizarea e opțională
    }
  };

  const submit = () => {
    if (name.trim() === "") {
      setError(m.errors.nameRequired);
      document.getElementById("brand-name")?.focus();
      return;
    }
    // termenul (doar cine poate gestiona produsele îl vede editabil): validat înainte de trimitere, cu mesaj în română
    const lead = parseLeadTimeInput(leadTime, LEAD_TEXTS);
    if (capabilities.structure && !lead.ok) {
      setLeadTimeError(lead.message);
      document.getElementById("brand-lead-time")?.focus();
      return;
    }
    setLeadTimeError(null);
    startTransition(async () => {
      setError(null);
      const nullable = (value: string) => (value.trim() === "" ? null : value.trim());
      try {
        if (isNew) {
          const result = await createBrand({
            name,
            ...(slug.trim() && { slug: slug.trim() }),
            ...(description.trim() && { description }),
            ...(seoTitle.trim() && { seoTitle: seoTitle.trim() }),
            ...(seoDescription.trim() && { seoDescription: seoDescription.trim() }),
            ...(logoMediaId && { logoMediaId }),
            ...(capabilities.structure &&
              lead.ok &&
              lead.value !== null && { defaultLeadTimeDays: lead.value }),
            ...(capabilities.legacy && legacyId.trim() && { legacyId: legacyId.trim() }),
            ...(capabilities.legacy && legacyUrl.trim() && { legacyUrl: legacyUrl.trim() }),
          });
          if (result.ok) onSaved(m.live.created(name));
          else setError(errorText(result));
          return;
        }
        if (!editing) return;
        const result = await updateBrand({
          id: editing.id,
          ...(canEditContent && {
            name,
            description: nullable(description),
            seoTitle: nullable(seoTitle),
            seoDescription: nullable(seoDescription),
            logoMediaId,
          }),
          ...(capabilities.structure && { slug: slug.trim() }),
          ...(capabilities.structure &&
            lead.ok &&
            lead.value !== (editing.defaultLeadTimeDays ?? null) && {
              defaultLeadTimeDays: lead.value,
            }),
          ...(capabilities.legacy && {
            legacyId: nullable(legacyId),
            legacyUrl: nullable(legacyUrl),
          }),
        });
        if (result.ok) onSaved(m.form.saved);
        else setError(errorText(result));
      } catch {
        setError(m.errors.generic);
      }
    });
  };

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={editing ? m.form.editTitle(editing.name) : m.form.createTitle}
        closeLabel={m.form.close}
        className="max-w-xl"
      >
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="brand-name">{m.form.name}</Label>
            <Input
              id="brand-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={150}
              disabled={!canEditContent}
            />
          </div>
          {(isNew || capabilities.structure) && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="brand-slug">{m.form.slug}</Label>
              <Input
                id="brand-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                maxLength={80}
                aria-describedby="brand-slug-help"
                disabled={!capabilities.structure}
              />
              <p id="brand-slug-help" className="text-label text-ink-secondary">
                {m.form.slugHelp}
              </p>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="brand-description">{m.form.description}</Label>
            <Textarea
              id="brand-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              disabled={!canEditContent}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="brand-lead-time">{m.form.leadTime}</Label>
            <Input
              id="brand-lead-time"
              value={leadTime}
              onChange={(e) => setLeadTime(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              aria-describedby="brand-lead-time-help"
              aria-invalid={leadTimeError ? true : undefined}
              disabled={!capabilities.structure}
            />
            <p id="brand-lead-time-help" className="text-label text-ink-secondary">
              {m.form.leadTimeHelp}
            </p>
            {leadTimeError && (
              <p data-problem className="text-body text-tone-problem-fg">
                {leadTimeError}
              </p>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="brand-seo-title">{m.form.seoTitle}</Label>
              <Input
                id="brand-seo-title"
                value={seoTitle}
                onChange={(e) => setSeoTitle(e.target.value)}
                maxLength={255}
                disabled={!canEditContent}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="brand-seo-description">{m.form.seoDescription}</Label>
              <Input
                id="brand-seo-description"
                value={seoDescription}
                onChange={(e) => setSeoDescription(e.target.value)}
                maxLength={500}
                disabled={!canEditContent}
              />
            </div>
          </div>

          <fieldset className="flex flex-col gap-2 rounded-lg bg-surface-subtle p-3">
            <legend className="float-left mb-1 w-full p-0 text-body font-medium">
              {m.form.logo}
            </legend>
            {logoMediaId ? (
              logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- miniatura din /media
                <img
                  src={logoUrl}
                  alt={m.form.logoAlt}
                  className="h-16 w-16 rounded-md border border-line-subtle object-contain"
                />
              ) : (
                <span className="text-body text-ink-secondary">{m.form.logoAlt}</span>
              )
            ) : (
              <p className="text-body text-ink-secondary">{m.form.logoNone}</p>
            )}
            {canEditContent && capabilities.pickMedia && (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => setPickerOpen(true)}>
                  {logoMediaId ? m.form.logoChange : m.form.logoPick}
                </Button>
                {logoMediaId && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setLogoMediaId(null);
                      setLogoUrl(null);
                    }}
                  >
                    {m.form.logoRemove}
                  </Button>
                )}
              </div>
            )}
          </fieldset>

          {capabilities.legacy && (
            <fieldset className="flex flex-col gap-3 rounded-lg bg-surface-subtle p-3">
              <legend className="float-left mb-1 w-full p-0 text-body font-medium">
                {m.form.legacyTitle}
              </legend>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="brand-legacy-id">{m.form.legacyId}</Label>
                <Input
                  id="brand-legacy-id"
                  value={legacyId}
                  onChange={(e) => setLegacyId(e.target.value)}
                  maxLength={100}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="brand-legacy-url">{m.form.legacyUrl}</Label>
                <Input
                  id="brand-legacy-url"
                  value={legacyUrl}
                  onChange={(e) => setLegacyUrl(e.target.value)}
                  maxLength={1000}
                />
              </div>
              <p className="text-label text-ink-secondary">{m.form.legacyHelp}</p>
            </fieldset>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
            >
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {m.form.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? m.form.saving : m.form.save}
            </Button>
          </div>
        </form>
      </Dialog>

      {pickerOpen && (
        <MediaPicker
          open
          mode="single"
          initialSelectedIds={logoMediaId ? [logoMediaId] : []}
          onClose={() => setPickerOpen(false)}
          onConfirm={(ids) => void pick(ids)}
        />
      )}
    </>
  );
}
