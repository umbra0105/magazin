"use client";

import { Check, Copy, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { describePrice } from "@ecom/shared/price-display";
import { QUANTITY_FACTOR, quantityFromTicks } from "@ecom/shared/quantity";
import {
  Badge,
  Button,
  Dialog,
  Input,
  Label,
  RowHeader,
  Select,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
  buttonVariants,
} from "@ecom/ui";
import { bulkUpdateProducts, updateProductInline } from "@/app/(admin)/admin/produse/actions";
import { duplicateProduct } from "@/app/(admin)/admin/produse/lifecycle-actions";
import { formatMoney, formatMoneyInput, parseMoneyInput } from "@/lib/money-input";
import { priceLines, type PriceLines } from "@/lib/price-view";
import { badgeVariant, type SummaryView } from "@/lib/stock-view";
import { getMessages } from "@/messages";
import { useProductSelection } from "./product-selection";
import { statusVariant } from "./status-variant";
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
  /** Configurarea de vânzare pentru afișarea prețului (vezi `ProductListRow.sale`). */
  sale: {
    unitSymbol: string | null;
    priceBasis: "unit" | "step";
    saleStep: number | null;
    saleStepLabel: string | null;
    showStepPrice: boolean;
  };
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
  /** `products.export`: coloana de bife există și pentru export (butonul «Exportă» e în bara de unelte a paginii). */
  canExport: boolean;
  /** Starea de stoc a fiecărui produs (după id), calculată pe server; lipsește la produsele din coșul de gunoi. */
  stock?: Record<string, SummaryView>;
}

type InlineField = "title" | "status" | "stockStatus" | "price";
type BulkKind =
  "status" | "shippingClass" | "stockStatus" | "brand" | "addCategory" | "priceAdjust";

/** Imaginea produsului (și locul ei gol): 32 px, rază de 8 px (docs/17 §3, Tabel). */
const THUMB = "size-8 rounded-md";

/** Un SKU mai lung de atâtea caractere se taie cu «…» în coloană și are textul întreg în title. */
const SKU_TITLE_FROM = 24;

/**
 * Creionul de editare (docs/17 §3, interacțiuni): pe dispozitive cu cursor (`hover: hover`) apare doar la hover sau la focus pe
 * rând; pe ecrane tactile rămâne vizibil. Numele accesibile ale butoanelor nu se schimbă (opacitatea nu le scoate din arborele de
 * accesibilitate). `VALUE_ICON` e pentru creionul din interiorul unei valori-buton: pe telefon (card) valoarea însăși e butonul și
 * creionul nu mai ocupă loc.
 */
const EDIT_ICON =
  "size-3.5 shrink-0 text-ink-secondary transition-opacity duration-(--motion) hover-device:opacity-0 " +
  "hover-device:group-hover/row:opacity-100 hover-device:group-focus-within/row:opacity-100";
const VALUE_ICON = `${EDIT_ICON} group-data-[stacked]/table:@max-2xl/table:hidden`;
const EDIT_VALUE =
  "-mx-1.5 -my-1.5 inline-flex min-h-(--control-h-compact) items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-left " +
  "transition-colors duration-(--motion) hover:bg-surface-hover " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

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
  canExport,
  stock = {},
}: ProductTableProps) {
  const router = useRouter();
  // selecția e ținută deasupra tabelului: o vede și «Exportă» din bara de unelte a paginii
  const { selected, setSelected } = useProductSelection();
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
  const selectable = canWrite || canExport;

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
          // Se închide doar editorul care s-a salvat. Dacă utilizatorul a început între timp altă editare (cererea
          // era lentă), aceea rămâne deschisă, cu ce a scris: răspunsul întârziat nu o mai șterge.
          setEditing((current) =>
            current && current.id === row.id && current.field === field ? null : current,
          );
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

  /** Prețul pe unitate/pas, doar la produsele cu unitate sau pas propriu (la bucată rămâne afișarea de azi). */
  const priceView = (row: ProductTableRow): PriceLines | null => {
    const sale = row.sale;
    if (row.priceMin === null) return null;
    if (sale.unitSymbol === null && sale.saleStep === null && sale.priceBasis === "unit")
      return null;
    return priceLines(
      describePrice({
        priceMinor: row.priceMin,
        basis: sale.priceBasis,
        step: quantityFromTicks(sale.saleStep ?? QUANTITY_FACTOR),
        unitSymbol: sale.unitSymbol ?? getMessages().admin.priceDisplay.defaultUnit,
        stepLabel: sale.saleStepLabel,
        showStepPrice: sale.showStepPrice,
      }),
      { currency, locale },
    );
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

  /** Creionul titlului (titlul e o legătură, deci creionul rămâne buton separat); ținta e de 44 px pe telefon. */
  const editButton = (row: ProductTableRow, field: InlineField, what: string) => (
    <button
      type="button"
      onClick={() => startEdit(row, field)}
      aria-label={m.inline.edit(what, row.title)}
      className={`${buttonVariants({ variant: "ghost", size: "icon" })} -my-1.5 shrink-0`}
    >
      <Pencil aria-hidden="true" data-edit-icon className={EDIT_ICON} />
    </button>
  );

  /**
   * Valoarea (prețul, starea) ca buton de editare: același nume accesibil «Editează …» ca înainte; creionul din interior apare la
   * hover sau focus pe rând, iar pe telefon dispare (valoarea însăși e ținta de 44 px).
   */
  const editValue = (
    row: ProductTableRow,
    field: InlineField,
    what: string,
    content: ReactNode,
  ) => (
    <button
      type="button"
      onClick={() => startEdit(row, field)}
      aria-label={m.inline.edit(what, row.title)}
      className={EDIT_VALUE}
    >
      {content}
      <Pencil aria-hidden="true" data-edit-icon className={VALUE_ICON} />
    </button>
  );

  const isEditing = (row: ProductTableRow, field: InlineField) =>
    editing?.id === row.id && editing.field === field;

  return (
    <div className="flex flex-col gap-3">
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {canWrite && selectedRows.length > 0 && (
        <section
          aria-label={m.bulk.region}
          data-bulk-bar
          className="flex flex-col gap-3 rounded-lg bg-surface-subtle p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-body font-medium">{m.bulk.selected(selectedRows.length)}</p>
            <p className="text-label text-ink-secondary">{m.bulk.limit(maxBulk)}</p>
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
              <div className="flex flex-col gap-1.5">
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
                <div className="flex flex-col gap-1.5">
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
                    <p id="bulk-percent-help" className="text-label text-ink-secondary">
                      {m.bulk.percent}
                    </p>
                  )}
                </div>
              )}
              <Button
                variant="outline"
                onClick={requestApply}
                disabled={pending || bulkKind === ""}
              >
                {m.bulk.apply}
              </Button>
            </div>
          )}
          {bulkError && (
            <p role="alert" data-problem className="text-body text-tone-problem-fg">
              {bulkError}
            </p>
          )}
        </section>
      )}

      {rowError && (
        <p
          role="alert"
          data-problem
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {rowError}
        </p>
      )}

      <Table stacked aria-label={m.table.label}>
        <THead>
          <Tr>
            {selectable && (
              <Th>
                <label className="flex size-11 items-center justify-center md:size-8">
                  <input
                    type="checkbox"
                    aria-label={m.table.selectPage}
                    checked={allSelected}
                    onChange={() =>
                      setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
                    }
                    className="size-4 accent-brand"
                  />
                </label>
              </Th>
            )}
            <Th>
              <span className="sr-only">{m.table.image}</span>
            </Th>
            {/* coloana Produs ia tot restul lățimii: celelalte (SKU, Preț, Stare …) au lățimea conținutului, deci Produs cedează lățime, nu invers */}
            <Th className="w-full">{m.table.product}</Th>
            <Th priority="secondary">{m.table.sku}</Th>
            <Th numeric>{m.table.price}</Th>
            <Th>{m.table.status}</Th>
            <Th priority="secondary">{m.table.stock}</Th>
            <Th priority="detail">{m.table.shipping}</Th>
            <Th priority="detail">{m.table.updated}</Th>
            <Th>
              <span className="sr-only">{m.table.actions}</span>
            </Th>
          </Tr>
        </THead>
        <TBody>
          {rows.map((row) => {
            const stockSummary = stock[row.id];
            const stockText = stockSummary
              ? [stockSummary.detail, stockSummary.quantity].filter(Boolean).join(" · ")
              : row.manageStock
                ? m.table.managedStock
                : "";
            const stockPill = stockSummary ? (
              <Badge
                variant={badgeVariant(stockSummary.tone)}
                dot
                data-stock-pill
                className="whitespace-nowrap"
              >
                {stockSummary.label}
              </Badge>
            ) : (
              <span data-stock-pill>{label(m.stock, row.stockStatus)}</span>
            );
            const subtitle = [
              row.brandName,
              ...row.categoryNames.slice(0, 2),
              m.table.variants(row.variantCount),
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <Tr
                key={row.id}
                data-product-row={row.id}
                data-product-title={row.title}
                className="group/row"
              >
                {selectable && (
                  <Td className="w-10">
                    <label className="flex size-11 items-center justify-center md:size-8">
                      <input
                        type="checkbox"
                        aria-label={m.table.select(row.title)}
                        checked={selected.has(row.id)}
                        onChange={() => toggle(row.id)}
                        className="size-4 accent-brand"
                      />
                    </label>
                  </Td>
                )}
                <Td className="w-8">
                  {row.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element -- miniatura generată (thumb), nu originalul
                    <img
                      src={row.thumb}
                      alt=""
                      width={32}
                      height={32}
                      loading="lazy"
                      data-product-thumb
                      className={`${THUMB} object-cover`}
                    />
                  ) : (
                    <span
                      role="img"
                      aria-label={m.table.noImage}
                      data-product-thumb
                      className={`${THUMB} flex items-center justify-center bg-surface-subtle text-label text-ink-secondary`}
                    >
                      —
                    </span>
                  )}
                </Td>
                <RowHeader stack="lead" className="@2xl/table:max-w-0">
                  {isEditing(row, "title") ? (
                    cellEditor(row, "title")
                  ) : (
                    <div className="flex flex-col">
                      <span className="flex items-center gap-1">
                        {trash ? (
                          <span className="font-medium">{row.title}</span>
                        ) : (
                          <Link
                            href={`/admin/produse/${row.id}`}
                            aria-label={m.editor.editLink(row.title)}
                            className="font-medium text-ink underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                          >
                            {row.title}
                          </Link>
                        )}
                        {!trash &&
                          (canEditContent || canWrite) &&
                          editButton(row, "title", m.inline.title)}
                      </span>
                      {/* o singură linie: ce nu încape se taie cu «…», iar textul întreg e în title */}
                      <span
                        data-product-subtitle
                        title={subtitle}
                        className="block truncate text-label text-ink-secondary"
                      >
                        {subtitle}
                      </span>
                    </div>
                  )}
                </RowHeader>
                <Td priority="secondary" className="text-ink-secondary" data-cell="sku">
                  {/* o linie, fără rupere în mijlocul codului; un SKU lung (peste 24 de caractere) se taie cu «…» și are textul întreg în title */}
                  <span
                    data-sku-text
                    {...(row.sku && row.sku.length > SKU_TITLE_FROM && { title: row.sku })}
                    className="block max-w-44 truncate whitespace-nowrap"
                  >
                    {row.sku ?? "—"}
                  </span>
                </Td>
                <Td numeric className="whitespace-nowrap" data-cell="price">
                  {isEditing(row, "price") ? (
                    cellEditor(row, "price")
                  ) : (
                    <>
                      {/* «10,00 RON / kg» e o singură valoare: același buton de editare, cu eticheta unității lipită de preț */}
                      {(() => {
                        const value = (
                          <>
                            {priceText(row)}
                            {priceView(row) && (
                              <span className="whitespace-nowrap text-ink-secondary" data-price-per>
                                / {priceView(row)!.per}
                              </span>
                            )}
                          </>
                        );
                        return (
                          <span className="inline-flex items-center gap-1">
                            {!trash && canWrite && row.singleVariantId
                              ? editValue(row, "price", m.inline.price, value)
                              : value}
                          </span>
                        );
                      })()}
                      {row.priceMin === row.priceMax && priceView(row)?.perUnit && (
                        <span className="block text-label text-ink-secondary" data-price-unit>
                          {priceView(row)!.perUnit}
                        </span>
                      )}
                      {row.priceMin === row.priceMax && priceView(row)?.stepPrice && (
                        <span className="block text-label text-ink-secondary" data-price-step>
                          {priceView(row)!.stepPrice}
                        </span>
                      )}
                    </>
                  )}
                </Td>
                <Td data-cell="status">
                  {isEditing(row, "status")
                    ? cellEditor(row, "status")
                    : (() => {
                        const pill = (
                          <Badge
                            variant={statusVariant(row.status)}
                            dot
                            data-status-pill
                            className="whitespace-nowrap"
                          >
                            {label(m.statuses, row.status)}
                          </Badge>
                        );
                        return !trash && canWrite
                          ? editValue(row, "status", m.inline.status, pill)
                          : pill;
                      })()}
                </Td>
                <Td priority="secondary" data-cell="stock" className="max-w-44">
                  {isEditing(row, "stockStatus") ? (
                    cellEditor(row, "stockStatus")
                  ) : (
                    <>
                      {/* linia 1: pastila și creionul, fără rupere; linia 2: textul (Digital, Negestionat, Disponibil …) */}
                      <span className="flex items-center gap-1 whitespace-nowrap">
                        {!trash && canWrite && !row.manageStock
                          ? editValue(row, "stockStatus", m.inline.stock, stockPill)
                          : stockPill}
                      </span>
                      {stockText && (
                        <span
                          data-stock-text
                          title={stockText}
                          className="block truncate text-label text-ink-secondary"
                        >
                          {stockText}
                        </span>
                      )}
                    </>
                  )}
                </Td>
                <Td priority="detail">{label(m.shipping, row.shippingClass)}</Td>
                <Td priority="detail" className="whitespace-nowrap text-ink-secondary">
                  {trash && row.deletedAt
                    ? m.views.deletedAt(
                        new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(
                          new Date(row.deletedAt),
                        ),
                      )
                    : new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(
                        new Date(row.updatedAt),
                      )}
                </Td>
                <Td stack="end" data-cell="actions">
                  {canWrite && (
                    <div className="flex justify-end gap-1 group-data-[stacked]/table:@max-2xl/table:justify-start">
                      {!trash && (
                        <Button
                          variant="outline"
                          size="icon"
                          disabled={pending}
                          onClick={() => duplicate(row)}
                          aria-label={m.lifecycle.duplicateFor(row.title)}
                          title={m.lifecycle.duplicate}
                          data-duplicate={row.id}
                        >
                          <Copy aria-hidden="true" className="size-4" />
                        </Button>
                      )}
                      {trash && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={pending}
                            onClick={() => setLifecycle({ operation: "restore", ids: [row.id] })}
                            aria-label={`${m.lifecycle.actions.restore}: ${row.title}`}
                            data-restore={row.id}
                          >
                            <RotateCcw aria-hidden="true" className="size-4" />
                            {m.lifecycle.actions.restore}
                          </Button>
                          <Button
                            variant="destructive"
                            size="icon"
                            disabled={pending}
                            onClick={() => setPurging({ id: row.id, title: row.title })}
                            aria-label={`${m.lifecycle.actions.purge} ${row.title}`}
                            title={m.lifecycle.actions.purge}
                            data-purge={row.id}
                          >
                            <Trash2 aria-hidden="true" className="size-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>

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
        <p className="rounded-lg bg-surface-subtle p-3 text-body" data-bulk-summary>
          {summary()}
        </p>
        <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-body">
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
