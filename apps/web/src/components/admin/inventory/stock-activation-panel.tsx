"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { ActivationApplyResult, StockActivationPreview } from "@ecom/core";
import { Button, Dialog, FileInput, Input, Label, buttonVariants, cn } from "@ecom/ui";
import { saveStockImportWarehouses } from "@/app/(admin)/admin/produse/stoc/import/actions";
import { formatDateTime } from "@/lib/format-date";
import { formatLocalDate, formatLocalTime, parseLocalDateTime } from "@/lib/stock-time";
import { getMessages } from "@/messages";
import { ListSection, errorText, td, th } from "./stock-import-panel";

const m = getMessages().admin.inventory.stockActivation;
const mi = getMessages().admin.inventory.stockImport;

/**
 * Pornirea în masă a gestionării stocului din fișierul SmartBill, în pași: fișier → verificare (fără modificări, cu opțiunea
 * explicită «cu stoc 0») → aplicare. Toată logica (citire, plan, tranzacție) e pe server; aici doar se strâng alegerile și se
 * arată raportul. Aplicarea trimite amprenta verificării, opțiunea și numerele văzute: serverul refuză dacă ceva s-a schimbat.
 */
export function StockActivationPanel({
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
  const [preview, setPreview] = useState<StockActivationPreview | null>(null);
  const [timeDirty, setTimeDirty] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [startUnmatched, setStartUnmatched] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<"check" | "apply" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [savedWarehouses, setSavedWarehouses] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<ActivationApplyResult | null>(null);
  const [saving, startSaving] = useTransition();

  // ora implicită se completează după montare (altfel ora de pe server ar diferi de cea din browser la hidratare)
  useEffect(() => {
    const now = new Date();
    setDate(formatLocalDate(now, timeZone));
    setTime(formatLocalTime(now, timeZone));
  }, [timeZone]);

  const adopt = (next: StockActivationPreview) => {
    setPreview(next);
    setAcknowledge(false);
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
  ): Promise<
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; error: { code?: string; message?: string } }
  > => {
    try {
      const response = await fetch(`/api/admin/stock-activations?${query.toString()}`, {
        method: "POST",
        headers: { "x-file-name": encodeURIComponent(target.name) },
        body: target,
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
        code?: string;
        message?: string;
      };
      return response.ok ? { ok: true, body } : { ok: false, error: body };
    } catch {
      return { ok: false, error: { code: "network" } };
    }
  };

  const check = async (target: File, explicitTime: boolean, start: boolean) => {
    setProblem(null);
    const query = new URLSearchParams({ mode: "preview" });
    if (start) query.set("start", "1");
    if (explicitTime) {
      const when = parseLocalDateTime(date, time, timeZone);
      if (!when.ok) {
        const text = mi.time.errors;
        setTimeErrors(
          when.field === "date"
            ? { date: when.error === "required" ? text.dateRequired : text.dateInvalid }
            : { time: when.error === "required" ? text.timeRequired : text.timeInvalid },
        );
        document.getElementById(`stock-activation-${when.field}`)?.focus();
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
    adopt(outcome.body["preview"] as StockActivationPreview);
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const chosen = fileInput.current?.files?.[0] ?? null;
    if (!chosen) {
      setProblem(mi.upload.noFile);
      fileInput.current?.focus();
      return;
    }
    setFile(chosen);
    setResult(null);
    setTouched(false);
    setStartUnmatched(false);
    void check(chosen, false, false);
  };

  const recheck = () => {
    if (!file) return;
    setTouched(true);
    void check(file, true, startUnmatched);
  };

  const toggleOption = (next: boolean) => {
    setStartUnmatched(next);
    if (file) void check(file, touched, next);
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
      await check(file, touched, startUnmatched);
      setSavedWarehouses(true);
    });
  };

  const apply = async () => {
    if (!file || !preview || !preview.planHash || !preview.takenAt || !preview.counters) return;
    setProblem(null);
    setBusy("apply");
    const query = new URLSearchParams({
      mode: "apply",
      takenAt: preview.takenAt,
      planHash: preview.planHash,
      confirmProducts: String(preview.counters.products),
      confirmVariants: String(preview.counters.matched),
      confirmZero: String(preview.counters.zero),
    });
    if (acknowledge) query.set("ack", "1");
    if (startUnmatched) query.set("start", "1");
    const outcome = await request(file, query);
    setBusy(null);
    setConfirmOpen(false);
    if (!outcome.ok) {
      setProblem(errorText(outcome.error));
      return;
    }
    setResult(outcome.body["result"] as ActivationApplyResult);
    setPreview(null);
    setFile(null);
    setStartUnmatched(false);
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
  const mc = m.counters;

  return (
    <div className="flex flex-col gap-6" data-stock-activation>
      <section aria-labelledby="stock-activation-upload" className="flex flex-col gap-3">
        <h2 id="stock-activation-upload" className="text-lg font-semibold">
          {m.upload.heading}
        </h2>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="stock-activation-file">{m.upload.file}</Label>
            <FileInput
              id="stock-activation-file"
              ref={fileInput}
              accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-describedby="stock-activation-file-help"
            />
            <p id="stock-activation-file-help" className="text-xs text-muted-foreground">
              {m.upload.help(maxMb)}
            </p>
          </div>
          <div>
            <Button type="submit" disabled={busy !== null}>
              {busy === "check" ? mi.upload.checking : mi.upload.check}
            </Button>
          </div>
        </form>
        <div role="status" aria-live="polite" className="text-sm">
          {busy === "check" ? mi.upload.checking : null}
        </div>
        {problem && (
          <p role="alert" className="rounded-md border border-danger p-3 text-sm" data-problem>
            {problem}
          </p>
        )}
      </section>

      {result && (
        <section
          aria-labelledby="stock-activation-result"
          className="flex flex-col gap-2 rounded-md border border-success/50 bg-success/10 p-4"
          data-activation-result
        >
          <h2 id="stock-activation-result" className="text-lg font-semibold">
            {m.result.heading}
          </h2>
          <p className="text-sm">
            {m.result.enabled(result.enabledVariants + result.startedAtZero)}{" "}
            {m.result.products(result.enabledProducts)}.
            {result.startedAtZero > 0 ? ` ${m.result.zero(result.startedAtZero)}.` : ""}
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
          <section aria-labelledby="stock-activation-time" className="flex flex-col gap-3">
            <h2 id="stock-activation-time" className="text-lg font-semibold">
              {mi.time.heading}
            </h2>
            <p className="text-sm text-muted-foreground">{mi.time.hint}</p>
            <p className="text-sm">
              {preview.fileDate
                ? mi.time.fileDate(preview.fileDate.split("-").reverse().join("."))
                : mi.time.noFileDate}
              {preview.lastSnapshotAt
                ? ` ${mi.time.lastSnapshot(formatDateTime(preview.lastSnapshotAt, locale, timeZone))}`
                : ""}
            </p>
            <div className="grid max-w-md grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="stock-activation-date">{mi.time.date}</Label>
                <Input
                  id="stock-activation-date"
                  inputMode="numeric"
                  autoComplete="off"
                  value={date}
                  aria-invalid={timeErrors.date ? true : undefined}
                  aria-describedby={timeErrors.date ? "stock-activation-date-error" : undefined}
                  onChange={(event) => {
                    setDate(event.target.value);
                    setTimeDirty(true);
                  }}
                />
                {timeErrors.date && (
                  <p id="stock-activation-date-error" className="text-xs text-danger">
                    {timeErrors.date}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="stock-activation-time">{mi.time.time}</Label>
                <Input
                  id="stock-activation-time"
                  inputMode="numeric"
                  autoComplete="off"
                  value={time}
                  aria-invalid={timeErrors.time ? true : undefined}
                  aria-describedby={timeErrors.time ? "stock-activation-time-error" : undefined}
                  onChange={(event) => {
                    setTime(event.target.value);
                    setTimeDirty(true);
                  }}
                />
                {timeErrors.time && (
                  <p id="stock-activation-time-error" className="text-xs text-danger">
                    {timeErrors.time}
                  </p>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{mi.time.zone(timeZone)}</p>
            <div>
              <Button variant="outline" onClick={recheck} disabled={busy !== null || saving}>
                {mi.time.recheck}
              </Button>
            </div>
            {timeDirty && (
              <p role="status" className="text-sm text-danger" data-time-dirty>
                {mi.time.changed}
              </p>
            )}
            {preview.timeWarnings.length > 0 && (
              <div
                role="alert"
                className="rounded-md border border-border bg-border/30 p-3 text-sm"
              >
                <p className="font-medium">{mi.time.warningsHeading}</p>
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
                  {mi.time.acknowledge}
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

          <section aria-labelledby="stock-activation-warehouses" className="flex flex-col gap-3">
            <h2 id="stock-activation-warehouses" className="text-lg font-semibold">
              {mi.warehouses.heading}
            </h2>
            <p className="text-sm text-muted-foreground">{mi.warehouses.hint}</p>
            {preview.warehouseProblem && (
              <p role="alert" className="rounded-md border border-danger p-3 text-sm">
                {preview.warehouseProblem.message}
              </p>
            )}
            {Object.keys(picked).length === 0 ? (
              <p className="text-sm">{mi.warehouses.none}</p>
            ) : (
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">{mi.warehouses.heading}</legend>
                {Object.keys(picked).map((name) => {
                  const inFile = preview.warehousesInFile.find((w) => w.name === name);
                  const on = picked[name] === true;
                  const isChosen = preview.chosenWarehouses.includes(name);
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
                      <span>{inFile ? mi.warehouses.inFile(name, inFile.rows) : name}</span>
                      {!inFile && (
                        <span className="text-xs text-muted-foreground">
                          ({mi.warehouses.notInFile})
                        </span>
                      )}
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-xs",
                          isChosen
                            ? "border-success/50 bg-success/10"
                            : "border-border text-muted-foreground",
                        )}
                      >
                        {isChosen ? mi.warehouses.chosen : mi.warehouses.notChosen}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            )}
            {preview.chosenWarehouses.length > 0 && (
              <p className="text-sm">
                {mi.warehouses.selected(preview.chosenWarehouses.join(", "))}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                onClick={saveWarehouses}
                disabled={saving || busy !== null || pickedCount === 0}
              >
                {saving ? mi.warehouses.saving : mi.warehouses.save}
              </Button>
              {pickedCount === 0 && (
                <span className="text-xs text-muted-foreground">{mi.warehouses.needed}</span>
              )}
              {savedWarehouses && (
                <span role="status" className="text-sm text-success">
                  {mi.warehouses.saved}
                </span>
              )}
            </div>
          </section>

          {counters && preview.reportCounters && (
            <section aria-labelledby="stock-activation-report" className="flex flex-col gap-3">
              <h2 id="stock-activation-report" className="text-lg font-semibold">
                {mc.heading}
              </h2>
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" data-counters>
                {(
                  [
                    ["products", counters.products],
                    ["matched", counters.matched],
                    ["zero", counters.zero],
                    ["alreadyManaged", counters.alreadyManaged],
                    ["explicitOff", counters.explicitOff],
                    ["digital", counters.digital],
                    ["unmatchedEligible", counters.unmatchedEligible],
                    ["unknown", preview.reportCounters.unknown],
                    ["errors", preview.reportCounters.errors],
                    ["warnings", preview.reportCounters.warnings],
                  ] as const
                ).map(([key, value]) => (
                  <div
                    key={key}
                    className={cn(
                      "rounded-md border border-border p-2",
                      key === "errors" && value > 0 && "border-danger",
                    )}
                  >
                    <dt className="text-xs text-muted-foreground">{mc[key]}</dt>
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
                id="changes"
                title={m.lists.changes}
                total={preview.changes.total}
                shown={preview.changes.items.length}
                open={preview.errors.total === 0}
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={th}>{m.lists.product}</th>
                      <th className={th}>{m.lists.level}</th>
                      <th className={th}>{m.lists.variants}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.changes.items.map((item) => (
                      <tr
                        key={`${item.scope}-${item.id}`}
                        className="border-t border-border"
                        data-scope={item.scope}
                      >
                        <td className={td}>{item.productTitle}</td>
                        <td className={td}>{m.lists.scope[item.scope] ?? item.scope}</td>
                        <td className={td}>{item.variants}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ListSection>

              <ListSection
                id="matched"
                title={m.lists.matched}
                total={preview.enabledMatched.total}
                shown={preview.enabledMatched.items.length}
              >
                <VariantTable items={preview.enabledMatched.items} />
              </ListSection>

              <ListSection
                id="zero"
                title={m.lists.zero}
                total={preview.enabledZero.total}
                shown={preview.enabledZero.items.length}
              >
                <VariantTable items={preview.enabledZero.items} />
              </ListSection>

              <ListSection
                id="unmatched"
                title={m.lists.unmatched}
                total={preview.unmatchedEligible.total}
                shown={preview.unmatchedEligible.items.length}
              >
                <VariantTable items={preview.unmatchedEligible.items} />
              </ListSection>

              <ListSection
                id="untouched"
                title={m.lists.untouched}
                total={preview.untouched.total}
                shown={preview.untouched.items.length}
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={th}>{m.lists.row}</th>
                      <th className={th}>{m.lists.sku}</th>
                      <th className={th}>{m.lists.product}</th>
                      <th className={th}>{m.lists.reason}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.untouched.items.map((item) => (
                      <tr key={item.variantId} className="border-t border-border">
                        <td className={td}>{item.rowNumber}</td>
                        <td className={td}>{item.sku}</td>
                        <td className={td}>{item.label}</td>
                        <td className={td}>{m.lists.reasons[item.reason] ?? item.reason}</td>
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

              <div className="rounded-md border border-border p-3 text-sm" data-start-unmatched>
                <label className="flex items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    checked={startUnmatched}
                    disabled={busy !== null || counters.unmatchedEligible === 0}
                    onChange={(event) => toggleOption(event.target.checked)}
                  />
                  {m.option.label(counters.unmatchedEligible)}
                </label>
                <p className="mt-1 text-xs text-muted-foreground">{m.option.hint}</p>
              </div>
            </section>
          )}

          <section className="flex flex-col gap-2">
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
                <p>{m.apply.summary(counters.products, counters.matched, counters.zero)}</p>
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

function VariantTable({
  items,
}: {
  items: ReadonlyArray<{ variantId: string; sku: string; label: string }>;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr>
          <th className={th}>{m.lists.sku}</th>
          <th className={th}>{m.lists.product}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.variantId} className="border-t border-border">
            <td className={td}>{item.sku}</td>
            <td className={td}>{item.label}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
