"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Badge, Button, Dialog, FileInput, Label } from "@ecom/ui";
import {
  confirmNirImport,
  getNirImportStatus,
} from "@/app/(admin)/admin/produse/import-nir/actions";
import { getMessages } from "@/messages";

const m = getMessages().admin.nirImport;

/**
 * Forma importului pentru interfață: FĂRĂ prețuri de achiziție (serverul le scoate; ele stau doar în raportul CSV). Oglindește
 * `NirImportView` din nucleu, fără costurile din `updated` / `unchanged`.
 */
export interface NirIssue {
  row: number;
  code: string | null;
  reason: string;
  fileUnit?: string | null;
}

export interface NirResult {
  row: number;
  code: string;
  date: string;
}

export interface NirViewDto {
  id: string;
  status: "previewed" | "queued" | "running" | "completed" | "failed";
  fileName: string;
  itemCount: number;
  processedItems: number;
  errorMessage: string | null;
  report: {
    counters: {
      fileRows: number;
      ignored: number;
      invalid: number;
      unknownCodes: number;
      unitDifferent: number;
      updated: number;
      unchanged: number;
      multiSameDay: number;
    };
    invalid: NirIssue[];
    unknown: NirIssue[];
    unitDifferent: NirIssue[];
    updated: NirResult[];
    unchanged: NirResult[];
    multiSameDay: Array<{ code: string; date: string; rows: number[] }>;
    otherDocTypes: Array<{ type: string; count: number }>;
  };
}

const LIST_LIMIT = 50;
const POLL_MS = 1500;
const POLL_MAX_MS = 15 * 60_000;

const isoToText = (iso: string): string => {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
};

function errorText(code: string | undefined, message?: string): string {
  return (code ? m.errors[code] : undefined) ?? message ?? m.errors.generic ?? "";
}

function Counter({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-surface-subtle p-3" data-nir-counter={tone}>
      <dt className="text-label text-ink-secondary">{label}</dt>
      <dd className="text-title tabular-nums">{value.toLocaleString("ro-RO")}</dd>
    </div>
  );
}

function ListBlock({
  title,
  rows,
  total,
}: {
  title: string;
  rows: ReadonlyArray<{ key: string; cells: string[] }>;
  total: number;
}) {
  if (total === 0) return null;
  const shown = rows.slice(0, LIST_LIMIT);
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-body font-medium">
        {title} ({total.toLocaleString("ro-RO")})
      </h3>
      <ul className="flex flex-col gap-1 text-body">
        {shown.map((row) => (
          <li key={row.key} className="flex flex-wrap gap-x-3 gap-y-0.5 text-ink-secondary">
            {row.cells.map((cell, index) => (
              <span key={index} className={index === 1 ? "font-medium text-ink" : undefined}>
                {cell}
              </span>
            ))}
          </li>
        ))}
      </ul>
      {total > shown.length && (
        <p className="text-label text-ink-secondary">{m.lists.more(total - shown.length)}</p>
      )}
    </section>
  );
}

/** Rezumatul și listele unui import (previzualizare sau final). */
function Report({ view, done }: { view: NirViewDto; done: boolean }) {
  const c = view.report.counters;
  const columns = m.lists.columns;
  const issueRows = (issues: readonly NirIssue[]) =>
    issues.map((issue, index) => ({
      key: `${issue.row}-${index}`,
      cells: [`${columns.row} ${issue.row}`, issue.code ?? "—", issue.reason],
    }));
  const resultRows = (results: readonly NirResult[]) =>
    results.map((result) => ({
      key: `${result.row}-${result.code}`,
      cells: [`${columns.row} ${result.row}`, result.code, isoToText(result.date)],
    }));
  return (
    <div className="flex flex-col gap-4" data-nir-report>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Counter label={m.counters.fileRows} value={c.fileRows} tone="rows" />
        <Counter
          label={done ? m.counters.updatedDone : m.counters.updated}
          value={c.updated}
          tone="updated"
        />
        <Counter label={m.counters.unchanged} value={c.unchanged} tone="unchanged" />
        <Counter label={m.counters.unknown} value={c.unknownCodes} tone="unknown" />
        <Counter label={m.counters.invalid} value={c.invalid} tone="invalid" />
        <Counter label={m.counters.ignored} value={c.ignored} tone="ignored" />
        <Counter label={m.counters.unitDifferent} value={c.unitDifferent} tone="unit" />
        <Counter label={m.counters.multiSameDay} value={c.multiSameDay} tone="multi" />
      </dl>
      <ListBlock
        title={done ? m.lists.updatedDone : m.lists.updated}
        rows={resultRows(view.report.updated)}
        total={view.report.updated.length}
      />
      <ListBlock
        title={m.lists.unchanged}
        rows={resultRows(view.report.unchanged)}
        total={view.report.unchanged.length}
      />
      <ListBlock
        title={m.lists.unknown}
        rows={issueRows(view.report.unknown)}
        total={view.report.unknown.length}
      />
      <ListBlock
        title={m.lists.invalid}
        rows={issueRows(view.report.invalid)}
        total={view.report.invalid.length}
      />
      <ListBlock
        title={m.lists.unitDifferent}
        rows={issueRows(view.report.unitDifferent)}
        total={view.report.unitDifferent.length}
      />
      <ListBlock
        title={m.lists.multiSameDay}
        rows={view.report.multiSameDay.map((item) => ({
          key: `${item.code}-${item.date}`,
          cells: [m.lists.rowsLabel(item.rows.join(", ")), item.code, isoToText(item.date)],
        }))}
        total={view.report.multiSameDay.length}
      />
      <ListBlock
        title={m.lists.docTypes}
        rows={view.report.otherDocTypes.map((item) => ({
          key: item.type,
          cells: [m.lists.docType(item.type, item.count)],
        }))}
        total={view.report.otherDocTypes.length}
      />
    </div>
  );
}

type Phase = "idle" | "uploading" | "previewed" | "running" | "done";

/**
 * Importul prețurilor NIR (Faza 15): alegi fișierul, verifici previzualizarea (nu se scrie nimic), confirmi, urmărești progresul și
 * descarci raportul. Prețurile de achiziție nu ajung aici (doar în raportul CSV, cu `products.cost.view`).
 */
export function NirImportPanel() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [view, setView] = useState<NirViewDto | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [fileKey, setFileKey] = useState(0);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const reset = () => {
    if (timer.current) clearTimeout(timer.current);
    setPhase("idle");
    setFile(null);
    setView(null);
    setProblem(null);
    setFileKey((key) => key + 1);
  };

  const upload = async () => {
    if (!file) {
      setProblem(m.noFile);
      document.getElementById("nir-file")?.focus();
      return;
    }
    setProblem(null);
    setPhase("uploading");
    setAnnouncement(m.uploading);
    try {
      const response = await fetch("/api/admin/nir-imports", {
        method: "POST",
        headers: { "X-File-Name": encodeURIComponent(file.name) },
        body: file,
        credentials: "same-origin",
      });
      const body = (await response.json()) as {
        import?: NirViewDto;
        code?: string;
        message?: string;
      };
      if (!response.ok || !body.import) {
        setProblem(errorText(body.code, body.message));
        setPhase("idle");
        return;
      }
      setView(body.import);
      setPhase("previewed");
      setAnnouncement(m.previewTitle);
    } catch {
      setProblem(m.errors.generic ?? "");
      setPhase("idle");
    }
  };

  const poll = (id: string, startedAt: number) => {
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const result = await getNirImportStatus({ id });
          if (!result.ok) {
            setProblem(errorText(result.code, result.message));
            setPhase("done");
            return;
          }
          const next = result.import as unknown as NirViewDto;
          setView(next);
          if (next.status === "completed" || next.status === "failed") {
            setPhase("done");
            setAnnouncement(next.status === "completed" ? m.completed : m.failed);
            return;
          }
          if (Date.now() - startedAt < POLL_MAX_MS) poll(id, startedAt);
        } catch {
          setProblem(m.errors.generic ?? "");
          setPhase("done");
        }
      })();
    }, POLL_MS);
  };

  const confirm = () => {
    if (!view) return;
    startTransition(async () => {
      try {
        const result = await confirmNirImport({ id: view.id });
        setConfirming(false);
        if (!result.ok) {
          setProblem(errorText(result.code, result.message));
          return;
        }
        const next = result.import as unknown as NirViewDto;
        setView(next);
        setProblem(null);
        if (next.status === "completed" || next.status === "failed") {
          setPhase("done");
          setAnnouncement(next.status === "completed" ? m.completed : m.failed);
        } else {
          setPhase("running");
          setAnnouncement(m.running);
          poll(view.id, Date.now());
        }
      } catch {
        setConfirming(false);
        setProblem(m.errors.generic ?? "");
      }
    });
  };

  const canConfirm = view !== null && view.status === "previewed" && view.itemCount > 0;

  return (
    <div className="flex flex-col gap-6">
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

      {(phase === "idle" || phase === "uploading") && (
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void upload();
          }}
        >
          <Label htmlFor="nir-file">{m.fileLabel}</Label>
          <FileInput
            key={fileKey}
            id="nir-file"
            accept=".xls,.xlsx,.csv,.txt"
            disabled={phase === "uploading"}
            onFilesChange={(files) => setFile(files[0] ?? null)}
            aria-describedby="nir-file-help"
          />
          <p id="nir-file-help" className="text-label text-ink-secondary">
            {m.fileHelp}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={phase === "uploading"} data-nir-upload>
              {phase === "uploading" ? m.uploading : m.upload}
            </Button>
            <a className="text-body underline" href="/api/admin/nir-imports/template" download>
              {m.template}
            </a>
          </div>
        </form>
      )}

      {phase === "previewed" && view && (
        <section aria-label={m.previewTitle} className="flex flex-col gap-4" data-nir-preview>
          <div>
            <h2 className="text-subtitle">{m.previewTitle}</h2>
            <p className="text-body text-ink-secondary">
              {view.fileName} · {m.previewNote}
            </p>
          </div>
          <Report view={view} done={false} />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => setConfirming(true)}
              disabled={!canConfirm || pending}
              data-nir-confirm
            >
              {m.confirm}
            </Button>
            <Button variant="outline" onClick={reset}>
              {m.cancel}
            </Button>
          </div>
        </section>
      )}

      {(phase === "running" || phase === "done") && view && (
        <section aria-label={m.steps.done} className="flex flex-col gap-4" data-nir-final>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-subtitle">
              {view.status === "completed"
                ? m.completed
                : view.status === "failed"
                  ? m.failed
                  : m.running}
            </h2>
            <Badge
              variant={
                view.status === "completed"
                  ? "success"
                  : view.status === "failed"
                    ? "danger"
                    : "info"
              }
              dot
              data-nir-status={view.status}
            >
              {m.recent.status[view.status] ?? view.status}
            </Badge>
          </div>
          {phase === "running" && (
            <p className="text-body" data-nir-progress>
              {m.progress(view.processedItems, view.itemCount)}
            </p>
          )}
          {view.errorMessage && (
            <p
              role="alert"
              className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
            >
              {view.errorMessage}
            </p>
          )}
          {phase === "done" && <Report view={view} done />}
          {phase === "done" && (
            <div className="flex flex-wrap items-center gap-3">
              <a
                className="text-body underline"
                href={`/api/admin/nir-imports/${view.id}/report`}
                download
                data-nir-report-link
              >
                {m.reportDownload}
              </a>
              <Button variant="outline" onClick={reset}>
                {m.newImport}
              </Button>
            </div>
          )}
        </section>
      )}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={m.confirmTitle}
        closeLabel={m.close}
        className="max-w-lg"
      >
        <div className="flex flex-col gap-4">
          <p className="text-body">{m.confirmBody(view?.itemCount ?? 0)}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {m.cancel}
            </Button>
            <Button onClick={confirm} disabled={pending} data-nir-confirm-yes>
              {pending ? m.confirming : m.confirmAction}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
