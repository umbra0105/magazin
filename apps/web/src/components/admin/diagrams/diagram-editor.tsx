"use client";

import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { Button, Dialog, Input } from "@ecom/ui";
import {
  attachDiagramProduct,
  deleteDiagram,
  deleteDiagramHotspot,
  detachDiagramProduct,
  saveDiagramHotspot,
  searchDiagramProducts,
  updateDiagram,
} from "@/app/(admin)/admin/produse/fise-explodate/actions";
import { Field } from "@/components/admin/products/editor-ui";
import { UnsavedChangesProvider, useDirtyFlag } from "@/components/admin/products/unsaved-changes";
import {
  basisPointsToPercent,
  clampBasisPoints,
  percentToBasisPoints,
  pixelsToBasisPoints,
} from "@/lib/basis-points";
import type { ProductActionFailure } from "@/lib/product-action-support";
import { getMessages } from "@/messages";
import { MediaPicker } from "../media/media-picker";

const m = getMessages().admin.diagrams;
const e = m.editor;

interface ProductSummary {
  id: string;
  title: string;
  sku: string | null;
  status: string;
  deleted: boolean;
}

export interface DiagramEditorData {
  id: string;
  title: string;
  image: {
    mediaId: string;
    name: string;
    alt: string;
    url: string | null;
    width: number | null;
    height: number | null;
  };
  hotspots: {
    id: string;
    number: number;
    xBp: number | null;
    yBp: number | null;
    label: string | null;
    product: ProductSummary | null;
  }[];
  products: ProductSummary[];
}

/** Un rând editabil: valorile din formular (text) + starea față de server. */
interface Row {
  /** `id` din baza de date, sau `new-N` pentru un hotspot încă nesalvat. */
  key: string;
  saved: boolean;
  number: string;
  label: string;
  x: string;
  y: string;
  product: ProductSummary | null;
  /** Modificat față de ultima salvare. */
  dirty: boolean;
  error: string | null;
}

const failureText = (result: ProductActionFailure): string => {
  const errors = m.errors as Record<string, string>;
  return result.message ?? errors[result.code] ?? m.errors.generic;
};

function toRow(h: DiagramEditorData["hotspots"][number]): Row {
  return {
    key: h.id,
    saved: true,
    number: String(h.number),
    label: h.label ?? "",
    x: h.xBp === null ? "" : basisPointsToPercent(h.xBp),
    y: h.yBp === null ? "" : basisPointsToPercent(h.yBp),
    product: h.product,
    dirty: false,
    error: null,
  };
}

/**
 * Editorul unei fișe explodate. Imaginea vine din biblioteca media. Hotspot-urile au număr unic,
 * produs (piesa) și/sau etichetă, și poziție în procente cu 2 zecimale (= puncte de bază exacte).
 * Poziția se poate seta în trei moduri echivalente: click pe imagine (hotspot ales), săgeți pe
 * marcajul focusat (1%, Shift 0,1%, Ctrl 10%) sau câmpuri numerice în tabel (fără mouse). Orice
 * modificare nesalvată declanșează avertismentul la părăsirea paginii. Fără `canWrite`: doar citire.
 */
export function DiagramEditor({
  diagram,
  canWrite,
}: {
  diagram: DiagramEditorData;
  canWrite: boolean;
}) {
  return (
    <UnsavedChangesProvider message={getMessages().admin.products.editor.unsavedConfirm}>
      <Editor diagram={diagram} canWrite={canWrite} />
    </UnsavedChangesProvider>
  );
}

function Editor({ diagram, canWrite }: { diagram: DiagramEditorData; canWrite: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState(diagram.title);
  const [savedTitle, setSavedTitle] = useState(diagram.title);
  const [rows, setRows] = useState<Row[]>(() => diagram.hotspots.map(toRow));
  const [selected, setSelected] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductSummary[]>(diagram.products);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const counter = useRef(0);

  const anyDirty = rows.some((r) => r.dirty || !r.saved) || title.trim() !== savedTitle;
  useDirtyFlag("diagram", anyDirty);

  const savedCount = rows.filter((r) => r.saved).length;

  const patchRow = (key: string, patch: Partial<Row>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const setPosition = (key: string, xBp: number, yBp: number) =>
    patchRow(key, {
      x: basisPointsToPercent(xBp),
      y: basisPointsToPercent(yBp),
      dirty: true,
      error: null,
    });

  const saveTitle = () => {
    setProblem(null);
    setStatus(null);
    startTransition(async () => {
      try {
        const result = await updateDiagram({ id: diagram.id, patch: { title: title.trim() } });
        if (result.ok) {
          setSavedTitle(title.trim());
          setStatus(e.titleSaved);
          router.refresh();
        } else setProblem(failureText(result));
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  const addRow = () => {
    counter.current += 1;
    const used = rows.map((r) => Number(r.number)).filter((n) => Number.isInteger(n));
    const next = (used.length > 0 ? Math.max(...used) : 0) + 1;
    const key = `new-${counter.current}`;
    setRows((current) => [
      ...current,
      {
        key,
        saved: false,
        number: String(next),
        label: "",
        x: "",
        y: "",
        product: null,
        dirty: true,
        error: null,
      },
    ]);
    setSelected(key);
  };

  /** Validează un rând și îl trimite la server. */
  const saveRow = (row: Row) => {
    const number = /^\d{1,4}$/.test(row.number.trim()) ? Number(row.number) : NaN;
    const xs = row.x.trim();
    const ys = row.y.trim();
    const xBp = xs === "" ? null : percentToBasisPoints(xs);
    const yBp = ys === "" ? null : percentToBasisPoints(ys);
    let error: string | null = null;
    if (!Number.isInteger(number) || number < 1 || number > 9999) error = e.numberInvalid;
    else if ((xs !== "" && xBp === null) || (ys !== "" && yBp === null)) error = e.positionInvalid;
    else if ((xs === "") !== (ys === "")) error = e.positionPair;
    else if (!row.product && row.label.trim() === "") error = e.needProductOrLabel;
    if (error) {
      patchRow(row.key, { error });
      return;
    }
    setProblem(null);
    setStatus(null);
    startTransition(async () => {
      try {
        const result = await saveDiagramHotspot({
          diagramId: diagram.id,
          hotspot: {
            ...(row.saved && { id: row.key }),
            number,
            xBp,
            yBp,
            productId: row.product?.id ?? null,
            label: row.label.trim() === "" ? null : row.label.trim(),
          },
        });
        if (result.ok) {
          setRows((current) =>
            current.map((r) =>
              r.key === row.key
                ? {
                    ...r,
                    key: result.id,
                    saved: true,
                    dirty: false,
                    error: null,
                    number: String(result.number),
                  }
                : r,
            ),
          );
          if (selected === row.key) setSelected(result.id);
          setStatus(e.saved(result.number));
          setAnnouncement(e.saved(result.number));
          router.refresh();
        } else {
          patchRow(row.key, { error: failureText(result) });
        }
      } catch {
        patchRow(row.key, { error: m.errors.generic });
      }
    });
  };

  const removeRow = (row: Row) => {
    if (!row.saved) {
      setRows((current) => current.filter((r) => r.key !== row.key));
      return;
    }
    setProblem(null);
    startTransition(async () => {
      try {
        const result = await deleteDiagramHotspot({ diagramId: diagram.id, hotspotId: row.key });
        if (result.ok) {
          setRows((current) => current.filter((r) => r.key !== row.key));
          setStatus(e.removed(Number(row.number)));
          setAnnouncement(e.removed(Number(row.number)));
          router.refresh();
        } else setProblem(failureText(result));
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  // click pe imagine: pune poziția hotspot-ului ales
  const onImageClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!canWrite || !selected) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const xBp = pixelsToBasisPoints(event.clientX - rect.left, rect.width);
    const yBp = pixelsToBasisPoints(event.clientY - rect.top, rect.height);
    setPosition(selected, xBp, yBp);
    const row = rows.find((r) => r.key === selected);
    setAnnouncement(
      e.announceMoved(
        Number(row?.number ?? 0),
        basisPointsToPercent(xBp),
        basisPointsToPercent(yBp),
      ),
    );
  };

  // săgeți pe marcaj
  const onMarkerKey = (event: KeyboardEvent<HTMLButtonElement>, row: Row) => {
    if (!canWrite) return;
    const step = event.ctrlKey ? 1000 : event.shiftKey ? 10 : 100;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = delta[event.key];
    if (move) {
      event.preventDefault();
      const x = percentToBasisPoints(row.x) ?? 0;
      const y = percentToBasisPoints(row.y) ?? 0;
      const nx = clampBasisPoints(x, move[0]);
      const ny = clampBasisPoints(y, move[1]);
      setPosition(row.key, nx, ny);
      setAnnouncement(
        e.announceMoved(Number(row.number), basisPointsToPercent(nx), basisPointsToPercent(ny)),
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      saveRow(row);
    }
  };

  const image = diagram.image;
  const markers = useMemo(
    () =>
      rows
        .map((r) => ({ row: r, x: percentToBasisPoints(r.x), y: percentToBasisPoints(r.y) }))
        .filter((r) => r.x !== null && r.y !== null),
    [rows],
  );

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <Link
          href="/admin/produse/fise-explodate"
          className="text-sm text-primary underline-offset-2 hover:underline"
        >
          {e.back}
        </Link>
        <h1 className="text-2xl font-semibold">{savedTitle}</h1>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[16rem] flex-1">
            <Field id="diagram-title" label={e.titleField}>
              {(control) => (
                <Input
                  {...control}
                  value={title}
                  onChange={(ev) => setTitle(ev.target.value)}
                  maxLength={200}
                  disabled={!canWrite}
                />
              )}
            </Field>
          </div>
          {canWrite && (
            <Button
              type="button"
              variant="outline"
              disabled={pending || title.trim() === "" || title.trim() === savedTitle}
              onClick={saveTitle}
            >
              {e.saveTitle}
            </Button>
          )}
        </div>
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
        {problem && (
          <p
            role="alert"
            data-problem
            className="rounded-md border border-danger p-3 text-sm text-danger"
          >
            {problem}
          </p>
        )}
      </header>

      <section aria-labelledby="diagram-image" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="diagram-image" className="text-lg font-semibold">
            {e.image}
          </h2>
          {canWrite && (
            <Button type="button" variant="outline" onClick={() => setPickerOpen(true)}>
              {e.changeImage}
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{e.canvasHelp}</p>
        {/* click pe imagine = alternativă la mouse-ul-doar; tastatura: marcajele (săgeți) și câmpurile numerice */}
        {image.url ? (
          <div
            data-diagram-canvas
            onClick={onImageClick}
            className="relative w-full max-w-3xl select-none overflow-hidden rounded-md border border-border"
            style={{ cursor: canWrite && selected ? "crosshair" : "default" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- imagine din /media (variante generate) */}
            <img
              src={image.url}
              alt={image.alt || e.imageAlt(image.name)}
              className="block h-auto w-full"
              draggable={false}
            />
            {markers.map(({ row, x, y }) => {
              const name = row.product?.title ?? row.label;
              const isSelected = selected === row.key;
              return (
                <button
                  key={row.key}
                  type="button"
                  data-marker={row.number}
                  aria-label={e.marker(
                    Number(row.number),
                    name,
                    basisPointsToPercent(x as number),
                    basisPointsToPercent(y as number),
                  )}
                  aria-pressed={isSelected}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setSelected(row.key);
                    setAnnouncement(e.selected(Number(row.number)));
                  }}
                  onKeyDown={(ev) => onMarkerKey(ev, row)}
                  className={
                    "absolute flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary " +
                    (isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-primary bg-background text-foreground")
                  }
                  style={{ left: `${(x as number) / 100}%`, top: `${(y as number) / 100}%` }}
                >
                  {row.number}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{e.noImage}</p>
        )}
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </section>

      <section aria-labelledby="diagram-hotspots" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="diagram-hotspots" className="text-lg font-semibold">
            {e.hotspots}
          </h2>
          {canWrite && (
            <Button type="button" variant="outline" onClick={addRow}>
              {e.addHotspot}
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{e.hotspotsHelp}</p>
        <p className="text-xs text-muted-foreground">{e.positionHelp}</p>

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{e.noHotspots}</p>
        ) : (
          <ul className="flex flex-col gap-3" aria-label={e.tableLabel}>
            {rows.map((row) => (
              <HotspotRow
                key={row.key}
                row={row}
                selected={selected === row.key}
                canWrite={canWrite}
                pending={pending}
                onSelect={() => {
                  setSelected(row.key);
                  setAnnouncement(e.selected(Number(row.number)));
                }}
                onChange={(patch) => patchRow(row.key, { ...patch, dirty: true, error: null })}
                onSave={() => saveRow(row)}
                onRemove={() => removeRow(row)}
              />
            ))}
          </ul>
        )}
      </section>

      <ProductsSection
        diagramId={diagram.id}
        products={products}
        canWrite={canWrite}
        onChange={(next, message) => {
          setProducts(next);
          setStatus(message);
          router.refresh();
        }}
        onError={setProblem}
      />

      {canWrite && (
        <section className="border-t border-border pt-6">
          <Button type="button" variant="outline" onClick={() => setDeleting(true)}>
            <Trash2 aria-hidden className="mr-2 h-4 w-4" />
            {e.delete}
          </Button>
        </section>
      )}

      {pickerOpen && (
        <MediaPicker
          open
          mode="single"
          title={m.create.pickerTitle}
          initialSelectedIds={[image.mediaId]}
          onClose={() => setPickerOpen(false)}
          onConfirm={(ids) => {
            setPickerOpen(false);
            const next = ids[0];
            if (!next || next === image.mediaId) return;
            startTransition(async () => {
              try {
                const result = await updateDiagram({ id: diagram.id, patch: { mediaId: next } });
                if (result.ok) {
                  setStatus(e.imageChanged);
                  router.refresh();
                } else setProblem(failureText(result));
              } catch {
                setProblem(m.errors.generic);
              }
            });
          }}
        />
      )}

      {deleting && (
        <DeleteDialog
          diagramId={diagram.id}
          title={savedTitle}
          hotspotCount={savedCount}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  );
}

function HotspotRow({
  row,
  selected,
  canWrite,
  pending,
  onSelect,
  onChange,
  onSave,
  onRemove,
}: {
  row: Row;
  selected: boolean;
  canWrite: boolean;
  pending: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<Row>) => void;
  onSave: () => void;
  onRemove: () => void;
}) {
  const n = Number(row.number) || 0;
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<
    { id: string; title: string; sku: string | null; status: string }[] | null
  >(null);
  const [searching, setSearching] = useState(false);
  const [searchProblem, setSearchProblem] = useState<string | null>(null);
  const id = (name: string) => `hotspot-${row.key}-${name}`;

  const search = async () => {
    setSearching(true);
    setSearchProblem(null);
    try {
      const result = await searchDiagramProducts({ q: query.trim() });
      if (result.ok) setHits(result.results);
      else setSearchProblem(failureText(result));
    } catch {
      setSearchProblem(m.errors.generic);
    } finally {
      setSearching(false);
    }
  };

  return (
    <li
      data-hotspot-row={row.number}
      className={
        "flex flex-col gap-3 rounded-md border p-3 " +
        (selected ? "border-primary bg-border/20" : "border-border")
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={e.select(n)}
          className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-primary text-xs font-bold"
        >
          {row.number}
        </button>
        <span className="min-w-0 flex-1 text-sm">
          {row.product ? (
            <>
              <span className="font-medium">{row.product.title}</span>
              {row.product.sku && (
                <span className="text-muted-foreground"> · {row.product.sku}</span>
              )}
              {row.product.deleted && <span className="text-danger"> · {e.productDeleted}</span>}
            </>
          ) : (
            <span className="text-muted-foreground">{e.noProduct}</span>
          )}
        </span>
      </div>

      {row.product?.deleted && (
        <p role="note" className="text-xs text-danger">
          {e.productMissingWarning}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-[6rem_1fr_8rem_8rem]">
        <Field id={id("number")} label={e.columns.number}>
          {(control) => (
            <Input
              {...control}
              aria-label={e.number(n)}
              value={row.number}
              inputMode="numeric"
              disabled={!canWrite}
              onChange={(ev) => onChange({ number: ev.target.value })}
            />
          )}
        </Field>
        <Field id={id("label")} label={e.columns.label}>
          {(control) => (
            <Input
              {...control}
              aria-label={e.labelOf(n)}
              value={row.label}
              maxLength={200}
              disabled={!canWrite}
              onChange={(ev) => onChange({ label: ev.target.value })}
            />
          )}
        </Field>
        <Field id={id("x")} label={e.columns.x}>
          {(control) => (
            <Input
              {...control}
              aria-label={e.xOf(n)}
              value={row.x}
              inputMode="decimal"
              autoComplete="off"
              disabled={!canWrite}
              onChange={(ev) => onChange({ x: ev.target.value })}
            />
          )}
        </Field>
        <Field id={id("y")} label={e.columns.y}>
          {(control) => (
            <Input
              {...control}
              aria-label={e.yOf(n)}
              value={row.y}
              inputMode="decimal"
              autoComplete="off"
              disabled={!canWrite}
              onChange={(ev) => onChange({ y: ev.target.value })}
            />
          )}
        </Field>
      </div>

      {canWrite && (
        <div className="flex flex-col gap-2 rounded-md border border-border p-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1">
              <Field id={id("search")} label={e.productSearch}>
                {(control) => (
                  <Input
                    {...control}
                    value={query}
                    autoComplete="off"
                    maxLength={100}
                    onChange={(ev) => setQuery(ev.target.value)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") {
                        ev.preventDefault();
                        if (query.trim().length >= 2) void search();
                      }
                    }}
                  />
                )}
              </Field>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={searching || query.trim().length < 2}
              onClick={() => void search()}
            >
              {e.productSearchButton}
            </Button>
            {row.product && (
              <Button type="button" variant="outline" onClick={() => onChange({ product: null })}>
                {e.productClear}
              </Button>
            )}
          </div>
          {searchProblem && (
            <p data-problem className="text-sm text-danger">
              {searchProblem}
            </p>
          )}
          {hits !== null &&
            (hits.length === 0 ? (
              <p className="text-sm text-muted-foreground">{e.noResults}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {hits.map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      aria-label={e.productResult(hit.title)}
                      onClick={() => {
                        onChange({
                          product: {
                            id: hit.id,
                            title: hit.title,
                            sku: hit.sku,
                            status: hit.status,
                            deleted: false,
                          },
                        });
                        setHits(null);
                        setQuery("");
                      }}
                      className="w-full rounded-md px-2 py-1 text-left text-sm hover:bg-border/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      {hit.title}
                      <span className="text-muted-foreground">
                        {hit.sku ? ` · ${hit.sku}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      )}

      {row.error && (
        <p role="alert" data-problem className="text-sm text-danger">
          {row.error}
        </p>
      )}

      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={pending || (!row.dirty && row.saved)}
            aria-label={e.save(n)}
            onClick={onSave}
          >
            {getMessages().admin.products.editor.common.save}
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-label={e.remove(n)}
            disabled={pending}
            onClick={onRemove}
          >
            <Trash2 aria-hidden className="h-4 w-4" />
          </Button>
        </div>
      )}
    </li>
  );
}

function ProductsSection({
  diagramId,
  products,
  canWrite,
  onChange,
  onError,
}: {
  diagramId: string;
  products: ProductSummary[];
  canWrite: boolean;
  onChange: (next: ProductSummary[], message: string) => void;
  onError: (message: string | null) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<
    { id: string; title: string; sku: string | null; status: string }[] | null
  >(null);

  const search = () => {
    onError(null);
    startTransition(async () => {
      try {
        const result = await searchDiagramProducts({ q: query.trim() });
        if (result.ok) setHits(result.results.filter((h) => !products.some((p) => p.id === h.id)));
        else onError(failureText(result));
      } catch {
        onError(m.errors.generic);
      }
    });
  };

  const run = (
    action: () => Promise<{ ok: true } | ProductActionFailure>,
    next: ProductSummary[],
    message: string,
  ) => {
    onError(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) onChange(next, message);
        else onError(failureText(result));
      } catch {
        onError(m.errors.generic);
      }
    });
  };

  return (
    <section aria-labelledby="diagram-products" className="flex flex-col gap-3">
      <h2 id="diagram-products" className="text-lg font-semibold">
        {e.productsHeading}
      </h2>
      <p className="text-sm text-muted-foreground">{e.productsHelp}</p>

      {products.length === 0 ? (
        <p className="text-sm text-muted-foreground">{e.noProducts}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {products.map((p) => (
            <li
              key={p.id}
              data-diagram-product={p.title}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border p-2"
            >
              <span className="min-w-0 flex-1 text-sm">
                <Link
                  href={`/admin/produse/${p.id}`}
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  {p.title}
                </Link>
                <span className="text-muted-foreground">{p.sku ? ` · ${p.sku}` : ""}</span>
                {p.deleted && <span className="text-danger"> · {e.productDeleted}</span>}
              </span>
              {canWrite && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  aria-label={e.detach(p.title)}
                  onClick={() =>
                    run(
                      () => detachDiagramProduct({ diagramId, productId: p.id }),
                      products.filter((x) => x.id !== p.id),
                      e.detached,
                    )
                  }
                >
                  <Trash2 aria-hidden className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1">
              <Field id="diagram-attach-search" label={e.attachSearch}>
                {(control) => (
                  <Input
                    {...control}
                    value={query}
                    autoComplete="off"
                    maxLength={100}
                    onChange={(ev) => setQuery(ev.target.value)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") {
                        ev.preventDefault();
                        if (query.trim().length >= 2) search();
                      }
                    }}
                  />
                )}
              </Field>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={pending || query.trim().length < 2}
              onClick={search}
            >
              {e.productSearchButton}
            </Button>
          </div>
          {hits !== null &&
            (hits.length === 0 ? (
              <p className="text-sm text-muted-foreground">{e.noResults}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {hits.map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      aria-label={e.attach(hit.title)}
                      disabled={pending}
                      onClick={() => {
                        run(
                          () => attachDiagramProduct({ diagramId, productId: hit.id }),
                          [
                            ...products,
                            {
                              id: hit.id,
                              title: hit.title,
                              sku: hit.sku,
                              status: hit.status,
                              deleted: false,
                            },
                          ],
                          e.attached,
                        );
                        setHits(null);
                        setQuery("");
                      }}
                      className="w-full rounded-md px-2 py-1 text-left text-sm hover:bg-border/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      {hit.title}
                      <span className="text-muted-foreground">
                        {hit.sku ? ` · ${hit.sku}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      )}
    </section>
  );
}

function DeleteDialog({
  diagramId,
  title,
  hotspotCount,
  onClose,
}: {
  diagramId: string;
  title: string;
  hotspotCount: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setProblem(null);
  }, [hotspotCount]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={e.deleteTitle(title)}
      description={e.deleteDescription(hotspotCount)}
      closeLabel={e.close}
    >
      <div className="flex flex-col gap-4">
        {problem && (
          <p
            role="alert"
            data-problem
            className="rounded-md border border-danger p-3 text-sm text-danger"
          >
            {problem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {e.cancel}
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                try {
                  const result = await deleteDiagram({
                    id: diagramId,
                    expectedHotspots: hotspotCount,
                  });
                  if (result.ok) router.push("/admin/produse/fise-explodate");
                  else setProblem(failureText(result));
                } catch {
                  setProblem(m.errors.generic);
                }
              })
            }
          >
            {pending ? e.deleting : e.deleteConfirm}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
