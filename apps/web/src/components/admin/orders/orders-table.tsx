"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition, type FormEvent } from "react";
import {
  Badge,
  Button,
  Dialog,
  Drawer,
  DrawerSection,
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
} from "@ecom/ui";
import {
  bulkCancelAction,
  bulkProcessAction,
  bulkResendAction,
  bulkSupplierAction,
  previewOrderAction,
  type BulkResult,
  type BulkRow,
  type OrderPreview,
} from "@/app/(admin)/admin/comenzi/lista-actions";
import { formatQuantity, quantityFromTicks } from "@ecom/shared/quantity";
import { BULK_LIMIT } from "@/lib/order-bulk";
import { FULFILLMENT_STATUS_TONE, ORDER_STATUS_TONE, PAYMENT_STATUS_TONE } from "@/lib/order-tones";
import { getMessages } from "@/messages";

const t = getMessages().admin.orders;

export interface OrderRowDto {
  id: string;
  number: string;
  dateText: string;
  customer: string | null;
  email: string | null;
  totalText: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  paymentMethod: string;
  delivery: "courier" | "pickup";
  supplier: boolean;
  installationStatus: string | null;
  attention: boolean;
  needsRefund: boolean;
}

export interface OrdersTableProps {
  rows: OrderRowDto[];
  caps: { process: boolean; cancel: boolean; supplier: boolean; resend: boolean };
  resendTemplates: readonly { key: string; label: string }[];
  /** Formatarea sumei și a datei din previzualizare (aceleași setări regionale ca în listă). */
  locale: string;
  currency: string;
  timeZone: string;
}

type BulkKind = "processing" | "cancel" | "supplierMark" | "supplierClear" | "resend" | null;

/**
 * Tabelul comenzilor: selecție cu casete (cel mult 50), banda de acțiuni în masă (fiecare cu dialog de confirmare și rezultat pe
 * comandă, cu motivul refuzului) și panoul lateral de consultare rapidă. Permisiunile se verifică din nou pe server la fiecare
 * acțiune; aici ele doar ascund butoanele fără drept.
 */
export function OrdersTable(props: OrdersTableProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState<BulkKind>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const allSelected = props.rows.length > 0 && props.rows.every((row) => selected.includes(row.id));
  const anyBulk =
    props.caps.process || props.caps.cancel || props.caps.supplier || props.caps.resend;

  // la schimbarea paginii sau a filtrelor (alte rânduri) selecția veche nu mai are sens
  const rowKey = props.rows.map((row) => row.id).join(",");
  useEffect(() => setSelected([]), [rowKey]);

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : current.length >= BULK_LIMIT
          ? current
          : [...current, id],
    );

  return (
    <div className="flex flex-col gap-3">
      {selected.length > 0 && anyBulk && (
        <div
          role="region"
          aria-label={t.bulk.selected(selected.length)}
          data-bulk-bar
          className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-subtle p-3"
        >
          <span className="text-body font-medium">{t.bulk.selected(selected.length)}</span>
          {selected.length >= BULK_LIMIT && (
            <span className="text-label text-ink-secondary">{t.bulk.limit}</span>
          )}
          {props.caps.process && (
            <Button type="button" variant="outline" size="sm" onClick={() => setBulk("processing")}>
              {t.bulk.processing}
            </Button>
          )}
          {props.caps.supplier && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setBulk("supplierMark")}
              >
                {t.bulk.markSupplier}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setBulk("supplierClear")}
              >
                {t.bulk.clearSupplier}
              </Button>
            </>
          )}
          {props.caps.resend && (
            <Button type="button" variant="outline" size="sm" onClick={() => setBulk("resend")}>
              {t.bulk.resendEmail}
            </Button>
          )}
          {props.caps.cancel && (
            <Button type="button" variant="outline" size="sm" onClick={() => setBulk("cancel")}>
              {t.bulk.dialogCancel}
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelected([])}>
            {t.bulk.clear}
          </Button>
        </div>
      )}

      <Table stacked aria-label={t.title}>
        <THead>
          <Tr>
            {anyBulk && (
              <Th priority="primary" className="w-10">
                <input
                  type="checkbox"
                  className="size-4 accent-brand"
                  aria-label={t.bulk.selectAll}
                  checked={allSelected}
                  onChange={() =>
                    setSelected(
                      allSelected ? [] : props.rows.slice(0, BULK_LIMIT).map((row) => row.id),
                    )
                  }
                />
              </Th>
            )}
            <Th priority="primary">{t.columns.order}</Th>
            <Th priority="primary">{t.columns.customer}</Th>
            <Th priority="primary" numeric>
              {t.columns.total}
            </Th>
            <Th priority="primary">{t.columns.status}</Th>
            <Th priority="tertiary">{t.columns.payment}</Th>
            <Th priority="tertiary">{t.columns.delivery}</Th>
            <Th priority="primary">
              <span className="sr-only">{t.columns.actions}</span>
            </Th>
          </Tr>
        </THead>
        <TBody>
          {props.rows.map((row) => {
            const checked = selected.includes(row.id);
            return (
              <Tr key={row.id} selected={checked} data-order-row={row.number}>
                {anyBulk && (
                  <Td priority="primary" stack="lead" className="w-10">
                    <input
                      type="checkbox"
                      className="size-5 accent-brand md:size-4"
                      aria-label={t.bulk.selectRow(row.number)}
                      checked={checked}
                      onChange={() => toggle(row.id)}
                    />
                  </Td>
                )}
                <RowHeader stack="lead" className="font-medium">
                  <Link
                    href={`/admin/comenzi/${row.id}`}
                    className="text-link underline-offset-2 hover:underline"
                  >
                    {row.number}
                  </Link>
                  <span className="block text-label font-normal text-ink-secondary">
                    {row.dateText}
                  </span>
                </RowHeader>
                <Td
                  priority="primary"
                  stack="title"
                  className="max-w-56 truncate"
                  title={row.customer ?? undefined}
                >
                  {row.customer ?? <span className="text-ink-secondary">{t.piiHidden}</span>}
                  {row.email && (
                    <span className="block truncate text-label text-ink-secondary">
                      {row.email}
                    </span>
                  )}
                </Td>
                <Td priority="primary" numeric className="whitespace-nowrap tabular-nums">
                  {row.totalText}
                </Td>
                <Td priority="primary">
                  <span className="flex flex-wrap gap-1">
                    <Badge variant={ORDER_STATUS_TONE[row.status] ?? "neutral"} dot>
                      {t.statuses[row.status] ?? row.status}
                    </Badge>
                    {row.needsRefund && <Badge variant="warning">{t.badges.needsRefund}</Badge>}
                    {row.attention && !row.needsRefund && (
                      <Badge variant="warning">{t.badges.attention}</Badge>
                    )}
                    {row.supplier && <Badge variant="info">{t.badges.supplier}</Badge>}
                    {row.installationStatus && (
                      <Badge variant="neutral">{t.badges.installation}</Badge>
                    )}
                  </span>
                </Td>
                <Td priority="tertiary">
                  <span className="flex flex-col gap-1">
                    <Badge variant={PAYMENT_STATUS_TONE[row.paymentStatus] ?? "neutral"} dot>
                      {t.paymentStatuses[row.paymentStatus] ?? row.paymentStatus}
                    </Badge>
                    <span className="text-label text-ink-secondary">
                      {t.methods[row.paymentMethod] ?? row.paymentMethod}
                    </span>
                  </span>
                </Td>
                <Td priority="tertiary">
                  <span className="flex flex-col gap-1">
                    <Badge
                      variant={FULFILLMENT_STATUS_TONE[row.fulfillmentStatus] ?? "neutral"}
                      dot
                    >
                      {t.fulfillmentStatuses[row.fulfillmentStatus] ?? row.fulfillmentStatus}
                    </Badge>
                    <span className="text-label text-ink-secondary">
                      {t.deliveryKinds[row.delivery] ?? row.delivery}
                    </span>
                  </span>
                </Td>
                <Td priority="primary" stack="actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-h-11 md:min-h-0"
                    onClick={() => setPreviewId(row.id)}
                    aria-label={`${t.drawer.open}: ${row.number}`}
                  >
                    {t.drawer.open}
                  </Button>
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>

      {bulk && (
        <BulkDialog
          kind={bulk}
          ids={selected}
          rows={props.rows}
          templates={props.resendTemplates}
          onClose={() => setBulk(null)}
          onDone={() => {
            setSelected([]);
            router.refresh();
          }}
        />
      )}
      <PreviewDrawer
        orderId={previewId}
        locale={props.locale}
        currency={props.currency}
        timeZone={props.timeZone}
        onClose={() => setPreviewId(null)}
      />
    </div>
  );
}

// --- acțiuni în masă ---------------------------------------------------------------------------------------------------------

function BulkDialog({
  kind,
  ids,
  rows,
  templates,
  onClose,
  onDone,
}: {
  kind: Exclude<BulkKind, null>;
  ids: string[];
  rows: OrderRowDto[];
  templates: readonly { key: string; label: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState(templates[0]?.key ?? "");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkRow[] | null>(null);
  const [pending, start] = useTransition();
  const number = (orderId: string) => rows.find((row) => row.id === orderId)?.number ?? orderId;

  const title =
    kind === "processing"
      ? t.bulk.processing
      : kind === "cancel"
        ? t.bulk.dialogCancel
        : kind === "supplierMark"
          ? t.bulk.markSupplier
          : kind === "supplierClear"
            ? t.bulk.clearSupplier
            : t.bulk.resendEmail;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (kind === "cancel" && reason.trim().length < 3) {
      setError(t.bulk.reasonRequired);
      return document.getElementById(`${id}-reason`)?.focus();
    }
    setError(null);
    start(async () => {
      const response: BulkResult =
        kind === "processing"
          ? await bulkProcessAction({ ids })
          : kind === "cancel"
            ? await bulkCancelAction({ ids, reason })
            : kind === "supplierMark"
              ? await bulkSupplierAction({ ids, mode: "mark", name })
              : kind === "supplierClear"
                ? await bulkSupplierAction({ ids, mode: "clear", name: "" })
                : await bulkResendAction({ ids, template });
      if (!response.ok) {
        setError(response.code === "tooMany" ? t.bulk.limit : t.actions.failed);
        return;
      }
      setResult(response.rows);
      onDone();
    });
  };

  const okCount = result?.filter((row) => row.outcome !== "refused").length ?? 0;
  const refused = result?.filter((row) => row.outcome === "refused").length ?? 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={result ? t.bulk.done(okCount, refused) : t.bulk.dialogGeneric(title, ids.length)}
      closeLabel={t.actions.close}
      className="max-w-xl"
    >
      {result ? (
        <div className="flex flex-col gap-3" data-bulk-result>
          <ul className="flex flex-col gap-1 text-body" aria-label={t.bulk.results}>
            {result.map((row) => (
              <li key={row.orderId} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{row.number}</span>
                <Badge
                  variant={
                    row.outcome === "ok"
                      ? "success"
                      : row.outcome === "unchanged"
                        ? "neutral"
                        : "danger"
                  }
                  dot
                >
                  {row.outcome === "ok"
                    ? t.bulk.ok
                    : row.outcome === "unchanged"
                      ? t.bulk.unchanged
                      : t.bulk.refused}
                </Badge>
                {row.reason && (
                  <span className="text-label text-ink-secondary">
                    {t.bulk.refusals[row.reason] ?? row.reason}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button type="button" onClick={onClose}>
              {t.actions.close}
            </Button>
          </div>
        </div>
      ) : (
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <ul className="flex flex-wrap gap-1 text-label text-ink-secondary">
            {ids.map((orderId) => (
              <li key={orderId}>{number(orderId)}</li>
            ))}
          </ul>
          {kind === "cancel" && (
            <>
              <p className="text-body text-ink-secondary">{t.bulk.dialogCancelBody(ids.length)}</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-reason`}>{t.bulk.reason}</Label>
                <Input
                  id={`${id}-reason`}
                  maxLength={300}
                  autoComplete="off"
                  value={reason}
                  aria-invalid={error ? true : undefined}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
            </>
          )}
          {kind === "supplierMark" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>{t.bulk.supplierName}</Label>
              <Input
                id={`${id}-name`}
                maxLength={200}
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          )}
          {kind === "resend" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-template`}>{t.bulk.template}</Label>
              <Select
                id={`${id}-template`}
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
              >
                {templates.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t.bulk.cancel}
            </Button>
            <Button
              type="submit"
              variant={kind === "cancel" ? "destructive" : "default"}
              disabled={pending}
            >
              {t.bulk.confirm}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// --- panou lateral de consultare rapidă -----------------------------------------------------------------------------------

function PreviewDrawer({
  orderId,
  locale,
  currency,
  timeZone,
  onClose,
}: {
  orderId: string | null;
  locale: string;
  currency: string;
  timeZone: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<{
    id: string;
    preview: OrderPreview | null;
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!orderId) return;
    let cancelled = false;
    void previewOrderAction({ orderId }).then((result) => {
      if (cancelled) return;
      setState({ id: orderId, preview: result.ok ? result.preview : null, failed: !result.ok });
    });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  const current = state && state.id === orderId ? state : null;
  const preview = current?.preview ?? null;
  const money = (minor: number) =>
    new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);

  return (
    <Drawer
      open={orderId !== null}
      onClose={onClose}
      title={preview ? t.drawer.title(preview.number) : t.drawer.loading}
      closeLabel={t.drawer.close}
      status={
        preview ? (
          <Badge variant={ORDER_STATUS_TONE[preview.status] ?? "neutral"} dot>
            {t.statuses[preview.status] ?? preview.status}
          </Badge>
        ) : undefined
      }
      footer={
        preview ? (
          <Link
            href={`/admin/comenzi/${preview.id}`}
            className="inline-flex h-(--control-h) items-center rounded-md bg-action px-4 text-body font-medium text-action-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            {t.drawer.full}
          </Link>
        ) : undefined
      }
    >
      {!current && (
        <DrawerSection>
          <p role="status" className="text-ink-secondary">
            {t.drawer.loading}
          </p>
        </DrawerSection>
      )}
      {current?.failed && (
        <DrawerSection>
          <p role="alert" className="text-tone-problem-fg">
            {t.drawer.failed}
          </p>
        </DrawerSection>
      )}
      {preview && (
        <>
          <DrawerSection title={t.drawer.lines}>
            <ul className="flex flex-col gap-1">
              {preview.lines.map((line, index) => (
                <li key={`${line.title}-${index}`}>
                  {line.title}
                  {line.variantTitle ? ` (${line.variantTitle})` : ""}
                  <span className="text-ink-secondary">
                    {" "}
                    × {formatTicks(line.quantityTicks)} {line.unitSymbol}
                  </span>
                </li>
              ))}
            </ul>
            <p className="font-semibold tabular-nums">{money(preview.totalMinor)}</p>
          </DrawerSection>
          <DrawerSection title={t.drawer.payment}>
            <p>
              {t.methods[preview.paymentMethod] ?? preview.paymentMethod} ·{" "}
              {t.paymentStatuses[preview.paymentStatus] ?? preview.paymentStatus}
            </p>
            <p className="text-ink-secondary">
              {new Intl.DateTimeFormat(locale, {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone,
              }).format(new Date(preview.placedAt))}
            </p>
          </DrawerSection>
          <DrawerSection title={t.drawer.delivery}>
            <p>
              {preview.delivery.kind === "pickup"
                ? t.deliveryKinds["pickup"]
                : t.deliveryKinds["courier"]}
              {preview.delivery.text ? `: ${preview.delivery.text}` : ""}
            </p>
            {preview.email && <p className="break-all text-ink-secondary">{preview.email}</p>}
            {preview.supplier && <Badge variant="info">{t.badges.supplier}</Badge>}
          </DrawerSection>
        </>
      )}
    </Drawer>
  );
}

/** Cantitatea din zecimi de miime, pentru afișare scurtă («2», «6,09»), prin modulul comun de cantități. */
function formatTicks(ticks: string): string {
  return formatQuantity(quantityFromTicks(BigInt(ticks)));
}
