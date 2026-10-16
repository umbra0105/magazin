"use client";

import { Check, Pencil, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Badge, Button, Dialog, Input, Label, Select } from "@ecom/ui";
import { bulkUpdateProducts, updateProductInline } from "@/app/(admin)/admin/produse/actions";
import { duplicateProduct } from "@/app/(admin)/admin/produse/lifecycle-actions";
import { formatMoney, formatMoneyInput, parseMoneyInput } from "@/lib/money-input";
import { getMessages } from "@/messages";
import { ProductExportDialog } from "./product-export-dialog";
import {
  LifecycleConfirmDialog,
  PurgeDialog,
  lifecycleErrorText,
  type LifecycleOperation,
} from "./lifecycle-dialogs";

const m = getMessages().admin.products;

/**
 * Rândul listei, ca JSON simplu. NU conține câmpuri de cost (nici măcar `null`): proiecția serverului
 * nu le are, iar testul de arhitectură interzice acestui fișier să le menționeze.
 */
export interface ProductTableRow {
  id: string;
  title: string;
  status: string;
  brandName: string | null;
  shippingClass: string;
  manageStock: boolean;
  stockStatus: string;
  variantCount: number;
  priceMin: number | null;
  priceMax: number | null;
  sku: string | null;
  singleVariantId: string | null;
  categoryNames: string[];
  thumb: string | null;
  updatedAt: string;
  /** Data mutării în coșul de gunoi (doar în vederea „deleted”). */
  deletedAt: string | null;
}

export interface ProductTableProps {
  rows: ProductTableRow[];
  /** `products.write`: starea, stocul, prețul și acțiunile în masă. */
  canWrite: boolean;
  /** `products.content.write`: titlul. */
  canEditContent: boolean;
  currency: string;
  locale: string;
  maxBulk: number;
  categories: { id: string; label: string }[];
  brands: { id: string; name: string }[];
  /** „active” (implicit) sau „deleted” (coșul de gunoi: restaurare și ștergere definitivă). */
  view: "active" | "deleted";
  /** Prezent doar cu `products.export`: filtrele listei și câte produse respectă filtrele. */
  exportTools?: { filters: Record<string, string>; filteredTotal: number };
}

type InlineField = "title" | "status" | "stockStatus" | "price";
type BulkKind =
  "status" | "shippingClass" | "stockStatus" | "brand" | "addCategory" | "priceAdjust";

const STATUS_VARIANT: Record<string, "neutral" | "success" | "info"> = {
  active: "success",
  draft: "info",
  archived: "neutral",
};

const label = <T extends Record<string, string>>(map: T, key: string): string =>
  (map as Record<string, string>)[key] ?? key;

export function ProductTable({
  rows,
  canWrite,
  canEditContent,
  currency,
  locale,
  maxBulk,
  categories,
  brands,
  view,
  exportTools,
}: ProductTableProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string; field: InlineField } | null>(null);
  const [draft, setDraft] = useState("");
  const [rowError, setRowError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [bulkKind, setBulkKind] = useState<BulkKind | "">("");
  const [bulkValue, setBulkValue] = useState("");
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lifecycle, setLifecycle] = useState<{
    operation: LifecycleOperation;
    ids: string[];
  } | null>(null);
  const [purging, setPurging] = useState<{ id: string; title: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const trash = view === "deleted";

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;

  const errorText = (result: { code: string; message?: string }): string =>
    (m.errors as Record<string, string>)[result.code] ?? result.message ?? m.errors.generic;

  const startEdit = (row: ProductTableRow, field: InlineField) => {
    setRowError(null);
    setEditing({ id: row.id, field });
    if (field === "title") setDraft(row.title);
    if (field === "status") setDraft(row.status);
    if (field === "stockStatus") setDraft(row.stockStatus);
    if (field === "price") setDraft(formatMoneyInput(row.priceMin ?? 0));
  };

  const saveInline = (row: ProductTableRow) => {
    if (!editing) return;
    const { field } = editing;
    let value: string | number = draft;
    if (field === "price") {
      const bani = parseMoneyInput(draft);
      if (bani === null) {
        setRowError(m.inline.priceInvalid);
        return;
      }
      value = bani;
    }
    startTransition(async () => {
      try {
        const result = await updateProductInline({ id: row.id, field, value });
        if (result.ok) {
          setEditing(null);
          setRowError(null);
          setAnnouncement(m.inline.saved(row.title));
          router.refresh();
        } else {
          setRowError(errorText(result));
        }
      } catch {
        setRowError(m.errors.generic);
      }
    });
  };

  const duplicate = (row: ProductTableRow) => {
    setRowError(null);
    startTransition(async () => {
      try {
        const result = await duplicateProduct({ id: row.id });
        if (result.ok) {
          router.push(`/admin/produse/${result.id}?copied=1&docs=${result.skipped.documents}`);
        } else {
          setRowError(lifecycleErrorText(result));
        }
      } catch {
        setRowError(m.errors.generic);
      }
    });
  };

  const lifecycleProducts = (ids: readonly string[]) =>
    rows.filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id, title: r.title }));

  const onLifecycleDone = (operation: LifecycleOperation, count: number) => {
    setLifecycle(null);
    setSelected(new Set());
    setBulkError(null);
    setAnnouncement(m.lifecycle.done[operation](count));
    router.refresh();
  };

  const buildChanges = (): Record<string, unknown> | null => {
    switch (bulkKind) {
      case "status":
      case "shippingClass":
      case "stockStatus":
        return bulkValue ? { [bulkKind]: bulkValue } : null;
      case "brand":
        return { brandId: bulkValue === "" ? null : bulkValue };
      case "addCategory":
        return bulkValue ? { addCategoryId: bulkValue } : null;
      case "priceAdjust": {
        const pct = Number(bulkValue.replace(",", "."));
        if (!bulkValue.trim() || !Number.isFinite(pct) || pct < -90 || pct > 300) return null;
        return { priceAdjustBps: Math.round(pct * 100) };
      }
      default:
        return null;
    }
  };

  const summary = (): string => {
    if (!bulkKind) return "";
    const s = m.bulk.summary;
    switch (bulkKind) {
      case "status":
        return s.status(label(m.statuses, bulkValue));
      case "shippingClass":
        return s.shippingClass(label(m.shipping, bulkValue));
      case "stockStatus":
        return s.stockStatus(label(m.stock, bulkValue));
      case "brand":
        return s.brand(brands.find((b) => b.id === bulkValue)?.name ?? m.bulk.noBrand);
      case "addCategory":
        return s.addCategory(categories.find((c) => c.id === bulkValue)?.label.trim() ?? "");
      case "priceAdjust":
        return s.priceAdjust(bulkValue.trim());
    }
  };

  const requestApply = () => {
    setBulkError(null);
    if (selectedRows.length > maxBulk) {
      setBulkError(m.bulk.overLimit(maxBulk));
      return;
    }
    if (buildChanges() === null) {
      setBulkError(bulkKind === "priceAdjust" ? m.bulk.percentInvalid : m.bulk.choose);
      return;
    }
    setConfirmOpen(true);
  };

  const applyBulk = () => {
    const changes = buildChanges();
    if (!changes) return;
    const ids = selectedRows.map((r) => r.id);
    startTransition(async () => {
      try {
        const result = await bulkUpdateProducts({
          ids,
          confirm: true,
          expectedCount: ids.length,
          changes,
        });
        setConfirmOpen(false);
        if (result.ok) {
          setSelected(new Set());
          setBulkKind("");
          setBulkValue("");
          setBulkError(null);
          setAnnouncement(m.bulk.done(result.updatedProducts));
          router.refresh();
        } else {
          setBulkError(errorText(result));
        }
      } catch {
        setConfirmOpen(false);
        setBulkError(m.errors.generic);
      }
    });
  };

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const priceText = (row: ProductTableRow): string => {
    if (row.priceMin === null) return m.table.noVariants;
    const min = formatMoney(row.priceMin, currency, locale);
    return row.priceMax !== null && row.priceMax !== row.priceMin
      ? `${min} – ${formatMoney(row.priceMax, currency, locale)}`
      : min;
  };

  const cellEditor = (row: ProductTableRow, field: InlineField) => {
    const id = `edit-${row.id}-${field}`;
    return (
      <form
        className="flex flex-wrap items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          saveInline(row);
        }}
      >
        <Label htmlFor={id} className="sr-only">
          {field === "price"
            ? m.inline.priceLabel
            : m.inline.edit(m.inline[field === "stockStatus" ? "stock" : field], row.title)}
        </Label>
        {field === "title" && (
          <Input
            id={id}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={200}
            autoFocus
          />
        )}
        {field === "price" && (
          <Input
            id={id}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            inputMode="decimal"
            className="w-32"
            autoFocus
          />
        )}
        {field === "status" && (
          <Select id={id} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus>
            {Object.entries(m.statuses).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
        )}
        {field === "stockStatus" && (
          <Select id={id} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus>
            {Object.entries(m.stock).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
        )}
        <Button type="submit" size="sm" disabled={pending} aria-label={m.inline.save}>
          <Check aria-hidden="true" className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={m.inline.cancel}
          onClick={() => {
            setEditing(null);
            setRowError(null);
          }}
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </Button>
      </form>
    );
  };

  const editButton = (row: ProductTableRow, field: InlineField, what: string) => (
    <button
      type="button"
      onClick={() => startEdit(row, field)}
      aria-label={m.inline.edit(what, row.title)}
      className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-border/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
    </button>
  );

  const isEditing = (row: ProductTableRow, field: InlineField) =>
    editing?.id === row.id && editing.field === field;

  return (
    <div className="flex flex-col gap-3">
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {exportTools && (
        <div className="flex justify-end" data-export-toolbar>
          <ProductExportDialog
            filters={exportTools.filters}
            filteredTotal={exportTools.filteredTotal}
            selectedIds={selectedRows.map((r) => r.id)}
            trashView={trash}
          />
        </div>
      )}

      {canWrite && selectedRows.length > 0 && (
        <section
          aria-label={m.bulk.region}
          data-bulk-bar
          className="flex flex-col gap-3 rounded-md border border-primary bg-primary/5 p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{m.bulk.selected(selectedRows.length)}</p>
            <p className="text-xs text-muted-foreground">{m.bulk.limit(maxBulk)}</p>
            <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>
              {m.bulk.clear}
            </Button>
          </div>
          <div
            role="group"
            aria-label={m.lifecycle.group}
            className="flex flex-wrap items-center gap-2"
            data-lifecycle-bar
          >
            {trash ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending || selectedRows.length > maxBulk}
                onClick={() =>
                  setLifecycle({ operation: "restore", ids: selectedRows.map((r) => r.id) })
                }
              >
                {m.lifecycle.actions.restore}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    pending ||
                    selectedRows.length > maxBulk ||
                    selectedRows.some((r) => r.status === "archived")
                  }
                  onClick={() =>
                    setLifecycle({ operation: "archive", ids: selectedRows.map((r) => r.id) })
                  }
                >
                  {m.lifecycle.actions.archive}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    pending ||
                    selectedRows.length > maxBulk ||
                    selectedRows.some((r) => r.status !== "archived")
                  }
                  onClick={() =>
                    setLifecycle({ operation: "unarchive", ids: selectedRows.map((r) => r.id) })
                  }
                >
                  {m.lifecycle.actions.unarchive}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending || selectedRows.length > maxBulk}
                  onClick={() =>
                    setLifecycle({ operation: "delete", ids: selectedRows.map((r) => r.id) })
                  }
                >
                  {m.lifecycle.actions.delete}
                </Button>
              </>
            )}
          </div>
          {!trash && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="bulk-kind">{m.bulk.action}</Label>
                <Select
                  id="bulk-kind"
                  value={bulkKind}
                  onChange={(e) => {
                    setBulkKind(e.target.value as BulkKind | "");
                    setBulkValue("");
                    setBulkError(null);
                  }}
                >
                  <option value="">{m.bulk.choose}</option>
                  {Object.entries(m.bulk.actions).map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </Select>
              </div>
              {bulkKind !== "" && (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="bulk-value">{m.bulk.value}</Label>
                  {bulkKind === "priceAdjust" ? (
                    <Input
                      id="bulk-value"
                      value={bulkValue}
                      onChange={(e) => setBulkValue(e.target.value)}
                      inputMode="decimal"
                      placeholder="10"
                      aria-describedby="bulk-percent-help"
                    />
                  ) : (
                    <Select
                      id="bulk-value"
                      value={bulkValue}
                      onChange={(e) => setBulkValue(e.target.value)}
                    >
                      {bulkKind !== "brand" && <option value="">{m.bulk.choose}</option>}
                      {bulkKind === "brand" && <option value="">{m.bulk.noBrand}</option>}
                      {bulkKind === "status" &&
                        Object.entries(m.statuses).map(([v, t]) => (
                          <option key={v} value={v}>
                            {t}
                          </option>
                        ))}
                      {bulkKind === "shippingClass" &&
                        Object.entries(m.shipping).map(([v, t]) => (
                          <option key={v} value={v}>
                            {t}
                          </option>
                        ))}
                      {bulkKind === "stockStatus" &&
                        Object.entries(m.stock).map(([v, t]) => (
                          <option key={v} value={v}>
                            {t}
                          </option>
                        ))}
                      {bulkKind === "brand" &&
                        brands.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      {bulkKind === "addCategory" &&
                        categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                    </Select>
                  )}
                  {bulkKind === "priceAdjust" && (
                    <p id="bulk-percent-help" className="text-xs text-muted-foreground">
                      {m.bulk.percent}
                    </p>
                  )}
                </div>
              )}
              <Button onClick={requestApply} disabled={pending || bulkKind === ""}>
                {m.bulk.apply}
              </Button>
            </div>
          )}
          {bulkError && (
            <p role="alert" data-problem className="text-sm text-danger">
              {bulkError}
            </p>
          )}
        </section>
      )}

      {rowError && (
        <p
          role="alert"
          data-problem
          className="rounded-md border border-danger p-3 text-sm text-danger"
        >
          {rowError}
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[56rem] text-left text-sm" aria-label={m.table.label}>
          <thead className="border-b border-border bg-border/30">
            <tr>
              {(canWrite || exportTools) && (
                <th scope="col" className="w-10 p-3">
                  <input
                    type="checkbox"
                    aria-label={m.table.selectPage}
                    checked={allSelected}
                    onChange={() =>
                      setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
                    }
                    className="h-4 w-4"
                  />
                </th>
              )}
              <th scope="col" className="w-14 p-3">
                <span className="sr-only">{m.table.image}</span>
              </th>
              <th scope="col" className="p-3 font-medium">
                {m.table.product}
              </th>
              <th scope="col" className="p-3 font-medium">
                {m.table.sku}
              </th>
              <th scope="col" className="p-3 font-medium">
                {m.table.price}
              </th>
              <th scope="col" className="p-3 font-medium">
                {m.table.status}
              </th>
              <th scope="col" className="p-3 font-medium">
                {m.table.stock}
              </th>
              <th scope="col" className="p-3 font-medium">
                {m.table.shipping}
              </th>
              <th scope="col" className="p-3 font-medium">
                {m.table.updated}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                data-product-row={row.id}
                data-product-title={row.title}
                className="border-b border-border align-top last:border-0"
              >
                {(canWrite || exportTools) && (
                  <td className="p-3">
                    <input
                      type="checkbox"
                      aria-label={m.table.select(row.title)}
                      checked={selected.has(row.id)}
                      onChange={() => toggle(row.id)}
                      className="h-4 w-4"
                    />
                  </td>
                )}
                <td className="p-3">
                  {row.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element -- miniatura generată (thumb), nu originalul
                    <img
                      src={row.thumb}
                      alt=""
                      width={48}
                      height={48}
                      loading="lazy"
                      className="h-12 w-12 rounded-md border border-border object-cover"
                    />
                  ) : (
                    <span
                      aria-label={m.table.noImage}
                      className="flex h-12 w-12 items-center justify-center rounded-md border border-dashed border-border text-[10px] text-muted-foreground"
                    >
                      —
                    </span>
                  )}
                </td>
                <td className="p-3">
                  {isEditing(row, "title") ? (
                    cellEditor(row, "title")
                  ) : (
                    <div className="flex flex-col">
                      <span className="flex items-center font-medium">
                        {row.title}
                        {!trash &&
                          (canEditContent || canWrite) &&
                          editButton(row, "title", m.inline.title)}
                        {!trash && (
                          <Link
                            href={`/admin/produse/${row.id}`}
                            aria-label={m.editor.editLink(row.title)}
                            className="ml-3 text-xs font-normal text-primary underline-offset-2 hover:underline"
                          >
                            {m.editor.open}
                          </Link>
                        )}
                        {!trash && canWrite && (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => duplicate(row)}
                            aria-label={m.lifecycle.duplicateFor(row.title)}
                            data-duplicate={row.id}
                            className="ml-3 text-xs font-normal text-primary underline-offset-2 hover:underline disabled:opacity-60"
                          >
                            {m.lifecycle.duplicate}
                          </button>
                        )}
                        {trash && canWrite && (
                          <>
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() => setLifecycle({ operation: "restore", ids: [row.id] })}
                              aria-label={`${m.lifecycle.actions.restore}: ${row.title}`}
                              data-restore={row.id}
                              className="ml-3 text-xs font-normal text-primary underline-offset-2 hover:underline disabled:opacity-60"
                            >
                              {m.lifecycle.actions.restore}
                            </button>
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() => setPurging({ id: row.id, title: row.title })}
                              aria-label={`${m.lifecycle.actions.purge} ${row.title}`}
                              data-purge={row.id}
                              className="ml-3 text-xs font-normal text-primary underline-offset-2 hover:underline disabled:opacity-60"
                            >
                              {m.lifecycle.actions.purge}
                            </button>
                          </>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {[
                          row.brandName,
                          ...row.categoryNames.slice(0, 2),
                          m.table.variants(row.variantCount),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  )}
                </td>
                <td className="p-3 text-muted-foreground">{row.sku ?? "—"}</td>
                <td className="p-3">
                  {isEditing(row, "price") ? (
                    cellEditor(row, "price")
                  ) : (
                    <span className="flex items-center">
                      {priceText(row)}
                      {!trash &&
                        canWrite &&
                        row.singleVariantId &&
                        editButton(row, "price", m.inline.price)}
                    </span>
                  )}
                </td>
                <td className="p-3">
                  {isEditing(row, "status") ? (
                    cellEditor(row, "status")
                  ) : (
                    <span className="flex items-center">
                      <Badge variant={STATUS_VARIANT[row.status] ?? "neutral"}>
                        {label(m.statuses, row.status)}
                      </Badge>
                      {!trash && canWrite && editButton(row, "status", m.inline.status)}
                    </span>
                  )}
                </td>
                <td className="p-3">
                  {isEditing(row, "stockStatus") ? (
                    cellEditor(row, "stockStatus")
                  ) : (
                    <span className="flex flex-col">
                      <span className="flex items-center">
                        {label(m.stock, row.stockStatus)}
                        {!trash && canWrite && editButton(row, "stockStatus", m.inline.stock)}
                      </span>
                      {row.manageStock && (
                        <span className="text-xs text-muted-foreground">
                          {m.table.managedStock}
                        </span>
                      )}
                    </span>
                  )}
                </td>
                <td className="p-3">{label(m.shipping, row.shippingClass)}</td>
                <td className="p-3 text-muted-foreground">
                  {trash && row.deletedAt
                    ? m.views.deletedAt(
                        new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(
                          new Date(row.deletedAt),
                        ),
                      )
                    : new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(
                        new Date(row.updatedAt),
                      )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <LifecycleConfirmDialog
        operation={lifecycle?.operation ?? "archive"}
        products={lifecycle ? lifecycleProducts(lifecycle.ids) : []}
        open={lifecycle !== null}
        onClose={() => setLifecycle(null)}
        onDone={(count) => lifecycle && onLifecycleDone(lifecycle.operation, count)}
      />
      <PurgeDialog
        product={purging}
        onClose={() => setPurging(null)}
        onDone={(title) => {
          setPurging(null);
          setAnnouncement(m.lifecycle.done.purge(title));
          router.refresh();
        }}
      />

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={m.bulk.confirmTitle(selectedRows.length)}
        description={m.bulk.confirmDescription}
        closeLabel={m.bulk.close}
        className="max-w-md"
      >
        <p className="rounded-md border border-border p-3 text-sm" data-bulk-summary>
          {summary()}
        </p>
        <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-sm">
          {selectedRows.slice(0, 10).map((r) => (
            <li key={r.id}>{r.title}</li>
          ))}
          {selectedRows.length > 10 && <li>… +{selectedRows.length - 10}</li>}
        </ul>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmOpen(false)}>
            {m.bulk.cancel}
          </Button>
          <Button onClick={applyBulk} disabled={pending}>
            {pending ? m.bulk.applying : m.bulk.confirm}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
