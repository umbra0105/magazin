"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { ApplyResult, StockReportPreview } from "@ecom/core";
import { Button, Dialog, FileInput, Input, Label, buttonVariants, cn } from "@ecom/ui";
import { saveStockImportWarehouses } from "@/app/(admin)/admin/produse/stoc/import/actions";
import { formatDateTime } from "@/lib/format-date";
import { formatLocalDate, formatLocalTime, parseLocalDateTime } from "@/lib/stock-time";
import { getMessages } from "@/messages";

const m = getMessages().admin.inventory.stockImport;

type ApiError = { code?: string; message?: string };

const errorText = (error: ApiError): string =>
  m.errors[error.code ?? ""] ?? error.message ?? m.errors["generic"] ?? "";

/** Un tabel dintr-o listă a raportului, în `<details>` (deschis când e important). */
function ListSection({
  title,
  total,
  shown,
  open = false,
  tone,
  children,
  id,
}: {
  title: string;
  total: number;
  shown: number;
  open?: boolean;
  tone?: "danger";
  children: React.ReactNode;
  id: string;
}) {
  if (total === 0) return null;
  return (
    <details
      open={open}
      data-list={id}
      className={cn("rounded-md border border-border", tone === "danger" && "border-danger")}
    >
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
        {title} <span className="text-muted-foreground">({total})</span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-border p-3">
        <p className="text-xs text-muted-foreground">{m.lists.showing(shown, total)}</p>
        <div className="overflow-x-auto">{children}</div>
      </div>
    </details>
  );
}

const th = "px-2 py-1.5 text-left text-xs font-medium uppercase text-muted-foreground";
const td = "px-2 py-1.5 align-top";

export function StockImportPanel({
  timeZone,
  locale,
  maxMb,
}: {
  timeZone: string;
  locale: string;
  maxMb: number;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [touched, setTouched] = useState(false);
  const [timeErrors, setTimeErrors] = useState<{ date?: string; time?: string }>({});
  const [preview, setPreview] = useState<StockReportPreview | null>(null);
  const [timeDirty, setTimeDirty] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [zeroConfirm, setZeroConfirm] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<"check" | "apply" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [savedWarehouses, setSavedWarehouses] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [saving, startSaving] = useTransition();

  // ora implicită se completează după montare (altfel ora de pe server ar diferi de cea din browser la hidratare)
  useEffect(() => {
    const now = new Date();
    setDate(formatLocalDate(now, timeZone));
    setTime(formatLocalTime(now, timeZone));
  }, [timeZone]);

  const adopt = (next: StockReportPreview) => {
    setPreview(next);
    setAcknowledge(false);
    setZeroConfirm(false);
    setTimeDirty(false);
    setSavedWarehouses(false);
    const initial: Record<string, boolean> = {};
    for (const w of next.warehousesInFile) initial[w.name] = w.chosen;
    for (const name of next.chosenWarehouses) {
      if (!(name in initial) && !next.warehousesInFile.some((w) => w.name === name)) {
        initial[name] = true;
      }
    }
    setPicked(initial);
    if (next.takenAt && !touched) {
      const moment = new Date(next.takenAt);
      setDate(formatLocalDate(moment, timeZone));
      setTime(formatLocalTime(moment, timeZone));
    }
  };

  const request = async (
    target: File,
    query: URLSearchParams,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: ApiError }> => {
    try {
      const response = await fetch(`/api/admin/stock-imports?${query.toString()}`, {
        method: "POST",
        headers: { "x-file-name": encodeURIComponent(target.name) },
        body: target,
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & ApiError;
      return response.ok ? { ok: true, body } : { ok: false, error: body };
    } catch {
      return { ok: false, error: { code: "network" } };
    }
  };

  const check = async (target: File, explicitTime: boolean) => {
    setProblem(null);
    const query = new URLSearchParams({ mode: "preview" });
    if (explicitTime) {
      const when = parseLocalDateTime(date, time, timeZone);
      if (!when.ok) {
        const text = m.time.errors;
        const found =
          when.field === "date"
            ? { date: when.error === "required" ? text.dateRequired : text.dateInvalid }
            : { time: when.error === "required" ? text.timeRequired : text.timeInvalid };
        setTimeErrors(found);
        document.getElementById(`stock-import-${when.field}`)?.focus();
        return;
      }
      query.set("takenAt", when.date.toISOString());
    }
    setTimeErrors({});
    setBusy("check");
    const outcome = await request(target, query);
    setBusy(null);
    if (!outcome.ok) {
      setProblem(errorText(outcome.error));
      return;
    }
    adopt(outcome.body["preview"] as StockReportPreview);
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const chosen = fileInput.current?.files?.[0] ?? null;
    if (!chosen) {
      setProblem(m.upload.noFile);
      fileInput.current?.focus();
      return;
    }
    setFile(chosen);
    setResult(null);
    setTouched(false);
    void check(chosen, false);
  };

  const recheck = () => {
    if (!file) return;
    setTouched(true);
    void check(file, true);
  };

  const saveWarehouses = () => {
    if (!file) return;
    const names = Object.entries(picked)
      .filter(([, on]) => on)
      .map(([name]) => name);
    setProblem(null);
    startSaving(async () => {
      const outcome = await saveStockImportWarehouses(names);
      if (!outcome.ok) {
        setProblem(errorText({ code: outcome.code, message: outcome.message }));
        return;
      }
      await check(file, touched);
      setSavedWarehouses(true);
    });
  };

  const apply = async () => {
    if (!file || !preview || !preview.planHash || !preview.takenAt) return;
    setProblem(null);
    setBusy("apply");
    const query = new URLSearchParams({
      mode: "apply",
      takenAt: preview.takenAt,
      planHash: preview.planHash,
    });
    if (acknowledge) query.set("ack", "1");
    if (zeroConfirm && preview.missing.total > 0) {
      query.set("zeroConfirm", "1");
      query.set("zeroCount", String(preview.missing.total));
    }
    const outcome = await request(file, query);
    setBusy(null);
    setConfirmOpen(false);
    if (!outcome.ok) {
      setProblem(errorText(outcome.error));
      return;
    }
    setResult(outcome.body["result"] as ApplyResult);
    setPreview(null);
    setFile(null);
    if (fileInput.current) fileInput.current.value = "";
    router.refresh();
  };

  const counters = preview?.counters ?? null;
  const warningsToAck = (preview?.timeWarnings.length ?? 0) > 0;
  const canApply =
    preview !== null &&
    preview.canApply &&
    !timeDirty &&
    (!warningsToAck || acknowledge) &&
    busy === null;
  const pickedCount = Object.values(picked).filter(Boolean).length;
  const zeroed = zeroConfirm ? (preview?.missing.total ?? 0) : 0;

  return (
    <div className="flex flex-col gap-6" data-stock-import>
      <section aria-labelledby="stock-import-upload" className="flex flex-col gap-3">
        <h2 id="stock-import-upload" className="text-lg font-semibold">
          {m.upload.heading}
        </h2>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="stock-import-file">{m.upload.file}</Label>
            <FileInput
              id="stock-import-file"
              ref={fileInput}
              accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-describedby="stock-import-file-help"
            />
            <p id="stock-import-file-help" className="text-xs text-muted-foreground">
              {m.upload.help(maxMb)}
            </p>
          </div>
          <div>
            <Button type="submit" disabled={busy !== null}>
              {busy === "check" ? m.upload.checking : m.upload.check}
            </Button>
          </div>
        </form>
        <div role="status" aria-live="polite" className="text-sm">
          {busy === "check" ? m.upload.checking : null}
        </div>
        {problem && (
          <p role="alert" className="rounded-md border border-danger p-3 text-sm" data-problem>
            {problem}
          </p>
        )}
      </section>

      {result && (
        <section
          aria-labelledby="stock-import-result"
          className="flex flex-col gap-2 rounded-md border border-success/50 bg-success/10 p-4"
          data-import-result
        >
          <h2 id="stock-import-result" className="text-lg font-semibold">
            {m.result.heading}
          </h2>
          <p className="text-sm">
            {m.result.applied(result.applied)}
            {result.zeroed > 0 ? ` ${m.result.zeroed(result.zeroed)}` : ""}
            {result.mirrored > 0 ? ` ${m.result.mirrored(result.mirrored)}` : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/produse/stoc" className={buttonVariants({ variant: "outline" })}>
              {m.result.toStock}
            </Link>
            <Button variant="outline" onClick={() => setResult(null)}>
              {m.result.again}
            </Button>
          </div>
        </section>
      )}

      {preview && (
        <>
          <section aria-labelledby="stock-import-time" className="flex flex-col gap-3">
            <h2 id="stock-import-time" className="text-lg font-semibold">
              {m.time.heading}
            </h2>
            <p className="text-sm text-muted-foreground">{m.time.hint}</p>
            <p className="text-sm">
              {preview.fileDate
                ? m.time.fileDate(preview.fileDate.split("-").reverse().join("."))
                : m.time.noFileDate}
              {preview.lastSnapshotAt
                ? ` ${m.time.lastSnapshot(formatDateTime(preview.lastSnapshotAt, locale, timeZone))}`
                : ""}
            </p>
            <div className="grid max-w-md grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="stock-import-date">{m.time.date}</Label>
                <Input
                  id="stock-import-date"
                  inputMode="numeric"
                  autoComplete="off"
                  value={date}
                  aria-invalid={timeErrors.date ? true : undefined}
                  aria-describedby={timeErrors.date ? "stock-import-date-error" : undefined}
                  onChange={(event) => {
                    setDate(event.target.value);
                    setTimeDirty(true);
                  }}
                />
                {timeErrors.date && (
                  <p id="stock-import-date-error" className="text-xs text-danger">
                    {timeErrors.date}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="stock-import-time">{m.time.time}</Label>
                <Input
                  id="stock-import-time"
                  inputMode="numeric"
                  autoComplete="off"
                  value={time}
                  aria-invalid={timeErrors.time ? true : undefined}
                  aria-describedby={timeErrors.time ? "stock-import-time-error" : undefined}
                  onChange={(event) => {
                    setTime(event.target.value);
                    setTimeDirty(true);
                  }}
                />
                {timeErrors.time && (
                  <p id="stock-import-time-error" className="text-xs text-danger">
                    {timeErrors.time}
                  </p>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{m.time.zone(timeZone)}</p>
            <div>
              <Button variant="outline" onClick={recheck} disabled={busy !== null || saving}>
                {m.time.recheck}
              </Button>
            </div>
            {timeDirty && (
              <p role="status" className="text-sm text-danger" data-time-dirty>
                {m.time.changed}
              </p>
            )}
            {preview.timeWarnings.length > 0 && (
              <div
                role="alert"
                className="rounded-md border border-border bg-border/30 p-3 text-sm"
              >
                <p className="font-medium">{m.time.warningsHeading}</p>
                <ul className="mt-1 list-disc pl-5">
                  {preview.timeWarnings.map((w) => (
                    <li key={w.kind}>{w.message}</li>
                  ))}
                </ul>
                <label className="mt-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={acknowledge}
                    onChange={(event) => setAcknowledge(event.target.checked)}
                  />
                  {m.time.acknowledge}
                </label>
              </div>
            )}
            {preview.blockers.length > 0 && (
              <ul
                role="alert"
                className="list-disc rounded-md border border-danger p-3 pl-8 text-sm"
              >
                {preview.blockers.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="stock-import-warehouses" className="flex flex-col gap-3">
            <h2 id="stock-import-warehouses" className="text-lg font-semibold">
              {m.warehouses.heading}
            </h2>
            <p className="text-sm text-muted-foreground">{m.warehouses.hint}</p>
            {preview.warehouseProblem && (
              <p role="alert" className="rounded-md border border-danger p-3 text-sm">
                {preview.warehouseProblem.message}
              </p>
            )}
            {Object.keys(picked).length === 0 ? (
              <p className="text-sm">{m.warehouses.none}</p>
            ) : (
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">{m.warehouses.heading}</legend>
                {Object.keys(picked).map((name) => {
                  const inFile = preview.warehousesInFile.find((w) => w.name === name);
                  const on = picked[name] === true;
                  return (
                    <label
                      key={name}
                      className="flex flex-wrap items-center gap-2 text-sm"
                      data-warehouse={name}
                      data-chosen={on ? "yes" : "no"}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(event) =>
                          setPicked((current) => ({ ...current, [name]: event.target.checked }))
                        }
                      />
                      <span>{inFile ? m.warehouses.inFile(name, inFile.rows) : name}</span>
                      {!inFile && (
                        <span className="text-xs text-muted-foreground">
                          ({m.warehouses.notInFile})
                        </span>
                      )}
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-xs",
                          preview.chosenWarehouses.includes(name)
                            ? "border-success/50 bg-success/10"
                            : "border-border text-muted-foreground",
                        )}
                      >
                        {preview.chosenWarehouses.includes(name)
                          ? m.warehouses.chosen
                          : m.warehouses.notChosen}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            )}
            {preview.chosenWarehouses.length > 0 && (
              <p className="text-sm">
                {m.warehouses.selected(preview.chosenWarehouses.join(", "))}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                onClick={saveWarehouses}
                disabled={saving || busy !== null || pickedCount === 0}
              >
                {saving ? m.warehouses.saving : m.warehouses.save}
              </Button>
              {pickedCount === 0 && (
                <span className="text-xs text-muted-foreground">{m.warehouses.needed}</span>
              )}
              {savedWarehouses && (
                <span role="status" className="text-sm text-success">
                  {m.warehouses.saved}
                </span>
              )}
            </div>
          </section>

          {counters && (
            <section aria-labelledby="stock-import-report" className="flex flex-col gap-3">
              <h2 id="stock-import-report" className="text-lg font-semibold">
                {m.counters.heading}
              </h2>
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" data-counters>
                {(
                  [
                    ["rows", counters.rows],
                    ["otherWarehouses", counters.otherWarehouses],
                    ["services", counters.services],
                    ["withoutQuantity", counters.withoutQuantity],
                    ["matched", counters.matched],
                    ["changed", counters.changed],
                    ["unchanged", counters.unchanged],
                    ["unknown", counters.unknown],
                    ["unmanaged", counters.unmanaged],
                    ["missing", counters.missing],
                    ["errors", counters.errors],
                    ["warnings", counters.warnings],
                  ] as const
                ).map(([key, value]) => (
                  <div
                    key={key}
                    className={cn(
                      "rounded-md border border-border p-2",
                      key === "errors" && value > 0 && "border-danger",
                    )}
                  >
                    <dt className="text-xs text-muted-foreground">{m.counters[key]}</dt>
                    <dd className="text-lg font-semibold" data-counter={key}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

              <ListSection
                id="errors"
                title={m.lists.errors}
                total={preview.errors.total}
                shown={preview.errors.items.length}
                open
                tone="danger"
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={th}>{m.lists.row}</th>
                      <th className={th}>{m.lists.sku}</th>
                      <th className={th}>{m.lists.message}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.errors.items.map((item, index) => (
                      <tr key={`${item.rowNumber}-${index}`} className="border-t border-border">
                        <td className={td}>{item.rowNumber}</td>
                        <td className={td}>{item.code ?? "—"}</td>
                        <td className={td}>{item.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ListSection>

              <ListSection
                id="lines"
                title={m.lists.lines}
                total={preview.lines.total}
                shown={preview.lines.items.length}
                open={preview.errors.total === 0}
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={th}>{m.lists.sku}</th>
                      <th className={th}>{m.lists.product}</th>
                      <th className={th}>{m.lists.fileQuantity}</th>
                      <th className={th}>{m.lists.quantity}</th>
                      <th className={th}>{m.lists.current}</th>
                      <th className={th}>{m.lists.difference}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.lines.items.map((line) => (
                      <tr key={line.rowNumber} className="border-t border-border">
                        <td className={td}>{line.sku}</td>
                        <td className={td}>{line.label}</td>
                        <td className={td}>{line.fileQuantity}</td>
                        <td className={td}>{line.quantity}</td>
                        <td className={td}>{line.current ?? m.lists.noStock}</td>
                        <td className={td}>{line.difference}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ListSection>

              <ListSection
                id="warnings"
                title={m.lists.warnings}
                total={preview.warnings.total}
                shown={preview.warnings.items.length}
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={th}>{m.lists.row}</th>
                      <th className={th}>{m.lists.sku}</th>
                      <th className={th}>{m.lists.message}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.warnings.items.map((item, index) => (
                      <tr key={`${item.rowNumber}-${index}`} className="border-t border-border">
                        <td className={td}>{item.rowNumber}</td>
                        <td className={td}>{item.code}</td>
                        <td className={td}>{item.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ListSection>

              <ListSection
                id="unknown"
                title={m.lists.unknown}
                total={preview.unknownCodes.total}
                shown={preview.unknownCodes.items.length}
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={th}>{m.lists.row}</th>
                      <th className={th}>{m.lists.sku}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.unknownCodes.items.map((item) => (
                      <tr key={item.rowNumber} className="border-t border-border">
                        <td className={td}>{item.rowNumber}</td>
                        <td className={td}>{item.code}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ListSection>

              <ListSection
                id="unmanaged"
                title={m.lists.unmanaged}
                total={preview.unmanaged.total}
                shown={preview.unmanaged.items.length}
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={th}>{m.lists.row}</th>
                      <th className={th}>{m.lists.sku}</th>
                      <th className={th}>{m.lists.product}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.unmanaged.items.map((item) => (
                      <tr key={item.rowNumber} className="border-t border-border">
                        <td className={td}>{item.rowNumber}</td>
                        <td className={td}>{item.sku}</td>
                        <td className={td}>{item.label}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ListSection>

              <ListSection
                id="missing"
                title={m.lists.missing}
                total={preview.missing.total}
                shown={preview.missing.items.length}
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={th}>{m.lists.sku}</th>
                      <th className={th}>{m.lists.product}</th>
                      <th className={th}>{m.lists.current}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.missing.items.map((item) => (
                      <tr key={item.sku} className="border-t border-border">
                        <td className={td}>{item.sku}</td>
                        <td className={td}>{item.label}</td>
                        <td className={td}>{item.currentPhysical ?? m.lists.noStock}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ListSection>

              {preview.missing.total > 0 && (
                <div className="rounded-md border border-border p-3 text-sm" data-zero-block>
                  <label className="flex items-center gap-2 font-medium">
                    <input
                      type="checkbox"
                      checked={zeroConfirm}
                      onChange={(event) => setZeroConfirm(event.target.checked)}
                    />
                    {m.zero.label(preview.missing.total)}
                  </label>
                  <p className="mt-1 text-xs text-muted-foreground">{m.zero.hint}</p>
                </div>
              )}
            </section>
          )}

          <section className="flex flex-col gap-2">
            {preview.status === "blocked" && counters && counters.errors > 0 && (
              <p role="note" className="text-sm text-danger">
                {m.apply.disabledErrors}
              </p>
            )}
            <div>
              <Button onClick={() => setConfirmOpen(true)} disabled={!canApply}>
                {busy === "apply" ? m.apply.applying : m.apply.button}
              </Button>
            </div>
          </section>

          <Dialog
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            title={m.apply.dialogTitle}
            description={m.apply.dialogDescription}
            closeLabel={m.apply.close}
            className="max-w-md"
          >
            {counters && (
              <div
                className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm"
                data-apply-summary
              >
                <p>{m.apply.summary(counters.changed, counters.unchanged, zeroed)}</p>
                {preview.takenAt && (
                  <p>{m.apply.at(formatDateTime(preview.takenAt, locale, timeZone))}</p>
                )}
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                {m.apply.cancel}
              </Button>
              <Button onClick={() => void apply()} disabled={busy !== null}>
                {busy === "apply" ? m.apply.applying : m.apply.confirm}
              </Button>
            </div>
          </Dialog>
        </>
      )}
    </div>
  );
}
