"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type {
  ImportAnalysis,
  ImportReport,
  ImportStatusView,
  ImportValidation,
  WooOptions,
} from "@ecom/core";
import { Button, Dialog, FileInput, Label, Select, buttonVariants } from "@ecom/ui";
import {
  analyzeProductImport,
  applyProductImport,
  cancelProductImport,
  getProductImportStatus,
  validateProductImport,
} from "@/app/(admin)/admin/produse/import/actions";
import { getMessages } from "@/messages";
import { WooOptionsPanel, WooReportExtras } from "./product-import-woo";

const m = getMessages().admin.productImport;

type Profile = "generic" | "woocommerce";

type Step = "upload" | "mapping" | "check" | "running" | "done";

export interface ImportFieldOption {
  key: string;
  label: string;
}

const errorText = (result: { code: string; message?: string }): string =>
  (m.errors as Record<string, string>)[result.code] ?? result.message ?? m.errors.generic;

/**
 * Importul de produse, în pași: fișier → mapare → verificare (fără modificări) → aplicare. Toată
 * logica (parsare, planificare, scriere) e pe server; aici doar se strâng alegerile și se arată
 * raportul. Aplicarea trimite amprenta verificării: serverul refuză dacă ceva s-a schimbat de atunci.
 */
export function ProductImportWizard({
  fields,
  maxUploadMb,
}: {
  fields: readonly ImportFieldOption[];
  maxUploadMb: number;
}) {
  const [step, setStep] = useState<Step>("upload");
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [profile, setProfile] = useState<Profile>("generic");
  const [wooOptions, setWooOptions] = useState<WooOptions | null>(null);
  const [validation, setValidation] = useState<ImportValidation | null>(null);
  const [status, setStatus] = useState<ImportStatusView | null>(null);
  const [finalReport, setFinalReport] = useState<ImportReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const importId = analysis?.importId ?? null;

  const adopt = (next: ImportAnalysis) => {
    setAnalysis(next);
    setColumns(next.columns.map((c) => c.field ?? ""));
    // opțiunile se păstrează între reanalizări (alt delimitator); la un fișier nou pornesc de la propuneri
    setWooOptions((current) => current ?? next.woo?.defaults ?? null);
  };

  const reset = () => {
    setStep("upload");
    setAnalysis(null);
    setColumns([]);
    setWooOptions(null);
    setValidation(null);
    setStatus(null);
    setFinalReport(null);
    setProblem(null);
    setConfirmOpen(false);
  };

  const upload = async () => {
    const file = fileInput.current?.files?.[0];
    if (!file) {
      setProblem(m.upload.noFile);
      return;
    }
    setProblem(null);
    setUploading(true);
    try {
      const response = await fetch("/api/admin/product-imports", {
        method: "POST",
        headers: { "x-file-name": encodeURIComponent(file.name) },
        body: file,
      });
      const body = (await response.json().catch(() => ({}))) as {
        import?: ImportAnalysis;
        code?: string;
        message?: string;
      };
      if (response.ok && body.import) {
        if (profile === "woocommerce" && !body.import.woo) {
          // fișierul nu e un export WooCommerce: se renunță la import și se rămâne la pasul 1
          void cancelProductImport({ importId: body.import.importId }).catch(() => undefined);
          setProblem(m.profile.notWoo);
        } else {
          adopt(body.import);
          setStep("mapping");
        }
      } else {
        setProblem(
          errorText({ code: body.code ?? "", ...(body.message && { message: body.message }) }),
        );
      }
    } catch {
      setProblem(m.upload.failed);
    } finally {
      setUploading(false);
    }
  };

  const changeDelimiter = (delimiter: string) => {
    if (!importId) return;
    setProblem(null);
    startTransition(async () => {
      try {
        const result = await analyzeProductImport({ importId, delimiter });
        if (result.ok) adopt(result.analysis);
        else setProblem(errorText(result));
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  const check = () => {
    if (!analysis) return;
    setProblem(null);
    startTransition(async () => {
      try {
        const result = await validateProductImport(
          profile === "woocommerce" && wooOptions
            ? {
                importId: analysis.importId,
                profile: "woocommerce",
                options: wooOptions,
                ...(analysis.delimiter && { delimiter: analysis.delimiter }),
              }
            : {
                importId: analysis.importId,
                columns: columns.map((c) => (c === "" ? null : c)),
                ...(analysis.delimiter && { delimiter: analysis.delimiter }),
              },
        );
        if (result.ok) {
          setValidation(result.validation);
          setStep("check");
        } else setProblem(errorText(result));
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  const apply = () => {
    if (!validation) return;
    startTransition(async () => {
      try {
        const result = await applyProductImport({
          importId: validation.importId,
          confirm: true,
          expectedPlanHash: validation.planHash,
        });
        setConfirmOpen(false);
        if (!result.ok) {
          setProblem(errorText(result));
        } else if (result.result.mode === "sync") {
          setFinalReport(result.result.report);
          setStep("done");
        } else {
          setStatus(null);
          setStep("running");
        }
      } catch {
        setConfirmOpen(false);
        setProblem(m.errors.generic);
      }
    });
  };

  const cancel = () => {
    if (!importId) return reset();
    startTransition(async () => {
      try {
        await cancelProductImport({ importId });
      } finally {
        reset();
      }
    });
  };

  // progresul unui import din fundal: interogare periodică până la final
  const poll = useCallback(async (id: string): Promise<boolean> => {
    try {
      const result = await getProductImportStatus({ importId: id });
      if (!result.ok) {
        setProblem(errorText(result));
        return true;
      }
      setStatus(result.status);
      if (result.status.status === "completed") {
        setFinalReport(result.status.report);
        setStep("done");
        return true;
      }
      if (result.status.status === "failed") return true;
    } catch {
      setProblem(m.errors.generic);
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    if (step !== "running" || !importId) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const finished = await poll(importId);
      if (!finished && !stopped) timer = setTimeout(tick, 1500);
    };
    let timer = setTimeout(tick, 600);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [step, importId, poll]);

  const wooProfile = profile === "woocommerce" && analysis?.woo != null && wooOptions != null;
  const skuMapped = wooProfile || columns.includes("sku");
  const nothingToApply =
    validation !== null && validation.report.counts.new + validation.report.counts.updated === 0;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <ol className="flex flex-wrap gap-2 text-sm" aria-label={m.title}>
        {(
          [
            ["upload", m.steps.upload],
            ["mapping", m.steps.mapping],
            ["check", m.steps.check],
            ["apply", m.steps.apply],
          ] as const
        ).map(([id, label]) => {
          const current =
            id === step || (id === "apply" && (step === "running" || step === "done"));
          return (
            <li
              key={id}
              aria-current={current ? "step" : undefined}
              className={`rounded-md border px-3 py-1 ${current ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground"}`}
            >
              {label}
            </li>
          );
        })}
      </ol>

      {problem && (
        <p
          role="alert"
          data-problem
          className="rounded-md border border-danger p-3 text-sm text-danger"
        >
          {problem}
        </p>
      )}

      {step === "upload" && (
        <section aria-labelledby="imp-upload" className="flex flex-col gap-4">
          <h2 id="imp-upload" className="text-lg font-semibold">
            {m.upload.heading}
          </h2>
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {m.upload.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
          <div className="flex flex-col gap-2 rounded-md border border-border p-4">
            <h3 className="text-base font-medium">{m.upload.template}</h3>
            <p className="text-sm text-muted-foreground">{m.upload.templateHelp}</p>
            <div className="flex flex-wrap gap-2">
              <a
                href="/api/admin/product-imports/template?format=xlsx"
                className={buttonVariants({ variant: "default", size: "sm" })}
                download
                data-template="xlsx"
              >
                {m.upload.templateXlsx}
              </a>
              <a
                href="/api/admin/product-imports/template?format=csv"
                className={buttonVariants({ variant: "outline", size: "sm" })}
                download
                data-template="csv"
              >
                {m.upload.templateCsv}
              </a>
            </div>
            <p className="text-sm text-muted-foreground" data-excel-help>
              {m.upload.excelHelp}
            </p>
          </div>
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void upload();
            }}
          >
            <fieldset className="flex flex-col gap-2" data-import-profile>
              <legend className="mb-1 text-sm font-medium">{m.profile.legend}</legend>
              {(
                [
                  ["generic", m.profile.generic, m.profile.genericHelp],
                  ["woocommerce", m.profile.woocommerce, m.profile.woocommerceHelp],
                ] as const
              ).map(([value, label, help]) => (
                <label key={value} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="import-profile"
                    value={value}
                    className="mt-1 size-4 shrink-0 accent-primary"
                    checked={profile === value}
                    onChange={() => setProfile(value)}
                  />
                  <span className="flex flex-col">
                    <span className="font-medium">{label}</span>
                    <span className="text-xs text-muted-foreground">{help}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="flex flex-col gap-1">
              <Label htmlFor="import-file">{m.upload.file}</Label>
              <FileInput
                id="import-file"
                ref={fileInput}
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                aria-describedby="import-file-help"
              />
              <p id="import-file-help" className="text-xs text-muted-foreground">
                {m.upload.help(maxUploadMb)}
              </p>
            </div>
            <div>
              <Button type="submit" disabled={uploading}>
                {uploading ? m.upload.uploading : m.upload.submit}
              </Button>
            </div>
          </form>
        </section>
      )}

      {step === "mapping" && analysis && (
        <section aria-labelledby="imp-mapping" className="flex flex-col gap-4">
          <h2 id="imp-mapping" className="text-lg font-semibold">
            {wooProfile ? m.woo.heading : m.mapping.heading}
          </h2>
          <p className="text-sm">
            {m.mapping.detected(analysis.fileName, analysis.format.toUpperCase())} ·{" "}
            {m.mapping.rows(analysis.rowCount)}
            {analysis.encoding ? ` · ${m.mapping.encoding(analysis.encoding)}` : ""}
          </p>
          {analysis.warnings.map((warning) => (
            <p key={warning} role="note" className="rounded-md border border-border p-3 text-sm">
              {warning}
            </p>
          ))}
          {analysis.format === "csv" && (
            <div className="flex max-w-xs flex-col gap-1">
              <Label htmlFor="import-delimiter">{m.mapping.delimiter}</Label>
              <Select
                id="import-delimiter"
                value={analysis.delimiter ?? ","}
                onChange={(e) => changeDelimiter(e.target.value)}
                disabled={pending}
                aria-describedby="import-delimiter-help"
              >
                {Object.entries(m.mapping.delimiters).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </Select>
              <p id="import-delimiter-help" className="text-xs text-muted-foreground">
                {analysis.delimiterSource
                  ? `${m.mapping.delimiterSource[analysis.delimiterSource]} `
                  : ""}
                {m.mapping.delimiterHelp}
              </p>
            </div>
          )}
          {wooProfile && analysis.woo && wooOptions ? (
            <WooOptionsPanel
              analysis={analysis.woo}
              options={wooOptions}
              onChange={setWooOptions}
            />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="border-b border-border bg-border/30">
                  <tr>
                    <th scope="col" className="p-3 font-medium">
                      {m.mapping.column}
                    </th>
                    <th scope="col" className="p-3 font-medium">
                      {m.mapping.sample}
                    </th>
                    <th scope="col" className="p-3 font-medium">
                      {m.mapping.target}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.headers.map((header, index) => {
                    const blocked = analysis.columns[index]?.blocked ?? null;
                    const id = `import-col-${index}`;
                    return (
                      <tr
                        key={`${index}-${header}`}
                        className="border-b border-border align-top last:border-0"
                      >
                        <th scope="row" className="p-3 font-medium">
                          {header || `(coloana ${index + 1})`}
                        </th>
                        <td className="p-3 text-muted-foreground">
                          {analysis.sample
                            .slice(0, 3)
                            .map((row) => row[index] ?? "")
                            .filter(Boolean)
                            .join(" · ")}
                        </td>
                        <td className="p-3">
                          <Label htmlFor={id} className="sr-only">
                            {`${m.mapping.target}: ${header}`}
                          </Label>
                          <Select
                            id={id}
                            value={blocked ? "" : (columns[index] ?? "")}
                            disabled={blocked !== null}
                            onChange={(e) =>
                              setColumns((current) =>
                                current.map((c, i) => (i === index ? e.target.value : c)),
                              )
                            }
                          >
                            <option value="">{m.mapping.ignore}</option>
                            {fields.map((f) => (
                              <option key={f.key} value={f.key}>
                                {f.label}
                              </option>
                            ))}
                          </Select>
                          {blocked && (
                            <p
                              className="mt-1 text-xs text-muted-foreground"
                              data-blocked={blocked}
                            >
                              {blocked === "cost"
                                ? m.mapping.blockedCost
                                : blocked === "readonly"
                                  ? m.mapping.blockedReadonly
                                  : m.mapping.blockedImages}
                            </p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!skuMapped && (
            <p role="note" className="text-sm text-danger">
              {m.mapping.required}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={check} disabled={pending || !skuMapped} data-import-check>
              {pending ? m.mapping.checking : m.mapping.submit}
            </Button>
            <Button variant="outline" onClick={cancel} disabled={pending}>
              {m.mapping.cancel}
            </Button>
          </div>
        </section>
      )}

      {step === "check" && validation && (
        <section aria-labelledby="imp-check" className="flex flex-col gap-4">
          <h2 id="imp-check" className="text-lg font-semibold">
            {m.check.heading}
          </h2>
          <p role="note" className="rounded-md border border-border bg-border/30 p-3 text-sm">
            {m.check.notApplied}
          </p>
          <ReportView report={validation.report} importId={validation.importId} />
          {validation.report.counts.errors > 0 && (
            <p className="text-sm text-muted-foreground">{m.check.errorsApplyNote}</p>
          )}
          <p className="text-sm text-muted-foreground">
            {validation.mode === "sync" ? m.check.modeSync : m.check.modeBackground}
          </p>
          {nothingToApply && <p className="text-sm">{m.check.nothing}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={pending || nothingToApply}
              data-import-apply
            >
              {m.check.apply}
            </Button>
            <Button variant="outline" onClick={() => setStep("mapping")} disabled={pending}>
              {m.check.recheck}
            </Button>
            <Button variant="outline" onClick={cancel} disabled={pending}>
              {m.mapping.cancel}
            </Button>
          </div>
          <Dialog
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            title={m.apply.title}
            description={m.apply.description}
            closeLabel={m.apply.close}
            className="max-w-md"
          >
            <p className="rounded-md border border-border p-3 text-sm" data-import-summary>
              {m.apply.summary(validation.report.counts.new, validation.report.counts.updated)}
              {validation.report.woo
                ? ` ${m.woo.apply(
                    validation.report.woo.categoriesToCreate.length,
                    validation.report.woo.brandsToCreate.length,
                    validation.report.woo.attributesToCreate.length,
                  )}`
                : ""}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                {m.apply.cancel}
              </Button>
              <Button onClick={apply} disabled={pending} data-import-confirm>
                {pending ? m.apply.applying : m.apply.confirm}
              </Button>
            </div>
          </Dialog>
        </section>
      )}

      {step === "running" && (
        <section aria-labelledby="imp-run" className="flex flex-col gap-3">
          <h2 id="imp-run" className="text-lg font-semibold">
            {m.apply.progressLabel}
          </h2>
          {status && status.status === "failed" ? (
            <div className="flex flex-col gap-3">
              <p
                role="alert"
                data-problem
                className="rounded-md border border-danger p-3 text-sm text-danger"
              >
                {m.apply.failedHeading}: {status.errorMessage ?? m.errors.generic}
              </p>
              <div>
                <Button variant="outline" onClick={reset}>
                  {m.apply.another}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2" data-import-progress>
              <progress
                aria-label={m.apply.progressLabel}
                className="h-3 w-full"
                max={status?.rowCount ?? validation?.rowCount ?? 1}
                value={status?.processedRows ?? 0}
              />
              <p role="status" aria-live="polite" className="text-sm">
                {status && status.status === "running"
                  ? m.apply.progress(status.processedRows, status.rowCount)
                  : m.apply.queued}
              </p>
            </div>
          )}
        </section>
      )}

      {step === "done" && finalReport && importId && (
        <section aria-labelledby="imp-done" className="flex flex-col gap-4" data-import-done>
          <h2 id="imp-done" className="text-lg font-semibold">
            {m.apply.doneHeading}
          </h2>
          <ReportView report={finalReport} importId={importId} />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={reset}>
              {m.apply.another}
            </Button>
            <Link href="/admin/produse" className={buttonVariants({ variant: "default" })}>
              {m.apply.toProducts}
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}

function ReportView({ report, importId }: { report: ImportReport; importId: string }) {
  const c = m.check;
  const counts = report.counts;
  return (
    <div className="flex flex-col gap-4" data-import-report>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {(
          [
            ["new", counts.new],
            ["updated", counts.updated],
            ["unchanged", counts.unchanged],
            ["skipped", counts.skipped],
            ["errors", counts.errors],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="rounded-md border border-border p-3" data-count={key}>
            <dt className="text-xs text-muted-foreground">{c.counts[key]}</dt>
            <dd className="text-xl font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      {report.woo && <WooReportExtras woo={report.woo} />}
      {report.fileWarnings.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold">{c.fileWarnings}</h3>
          <ul className="list-disc pl-5 text-sm" data-file-warnings>
            {report.fileWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{c.entries}</h3>
        {report.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{c.entriesNone}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="border-b border-border bg-border/30">
                <tr>
                  <th scope="col" className="p-2 font-medium">
                    {c.row}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {c.sku}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {c.result}
                  </th>
                  <th scope="col" className="p-2 font-medium">
                    {c.reason}
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.entries.map((entry) => (
                  <tr
                    key={`${entry.row}-${entry.sku}`}
                    data-report-row={entry.row}
                    data-outcome={entry.outcome}
                    className="border-b border-border align-top last:border-0"
                  >
                    <td className="p-2">{entry.row}</td>
                    <td className="p-2">{entry.sku || "—"}</td>
                    <td className="p-2">{c.outcomes[entry.outcome]}</td>
                    <td className="p-2">
                      {entry.messages.length > 0 ? (
                        <ul className="list-disc pl-4">
                          {entry.messages.map((message) => (
                            <li key={message}>{message}</li>
                          ))}
                        </ul>
                      ) : entry.changed.length > 0 ? (
                        c.willChange(entry.changed.join(", "))
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {report.truncated && (
          <p className="text-xs text-muted-foreground">{c.truncated(report.entries.length)}</p>
        )}
      </div>
      <div>
        <a
          href={`/api/admin/product-imports/${importId}/report`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
          download
          data-import-download
        >
          {c.download}
        </a>
      </div>
    </div>
  );
}
