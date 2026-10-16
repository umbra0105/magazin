"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, Label } from "@ecom/ui";
import { getMessages } from "@/messages";

const m = getMessages().admin.productExport;

type Scope = "selection" | "filters" | "all";
type Format = "csv" | "xlsx";

export interface ProductExportProps {
  /** Parametrii listei curente (q, category, brand, status, shipping, stock, view), ca în URL. */
  filters: Record<string, string>;
  /** Câte produse respectă filtrele curente (în toate paginile). */
  filteredTotal: number;
  /** Produsele selectate în pagina curentă. */
  selectedIds: readonly string[];
  /** Lista arată coșul de gunoi: exportul filtrelor curente exportă coșul. */
  trashView: boolean;
}

const RADIO = "mt-1 size-4 shrink-0 accent-primary";

/** Numele fișierului din antetul `Content-Disposition`, sau unul implicit. */
function fileNameOf(response: Response, fallback: string): string {
  const header = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(header);
  return match?.[1] ?? fallback;
}

function errorText(code: string | undefined, message: string | undefined): string {
  const known = code ? (m.errors as Record<string, string>)[code] : undefined;
  // mesajele serverului (în română, cu numere: «Exportul ar avea … rânduri, limita este …»)
  return known ?? message ?? m.errors.generic;
}

/**
 * Butonul «Exportă…» al listei de produse și dialogul lui: domeniul (selecția, filtrele curente, tot
 * catalogul), coșul de gunoi (exclus implicit) și formatul. Cererea e un POST către
 * `/api/admin/product-exports`; răspunsul (CSV sau XLSX) se descarcă fără să părăsești pagina, iar
 * refuzurile (limită de rânduri, rate limit) apar aici, în română. Nu ține niciun cost: ruta nu îl exportă.
 */
export function ProductExportDialog({
  filters,
  filteredTotal,
  selectedIds,
  trashView,
}: ProductExportProps) {
  const [open, setOpen] = useState(false);
  const [scopeChoice, setScopeChoice] = useState<Scope | null>(null);
  const [format, setFormat] = useState<Format>("xlsx");
  const [includeTrash, setIncludeTrash] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const hasSelection = selectedIds.length > 0;
  // fără alegere explicită: selecția, dacă există, altfel filtrele curente
  const scope: Scope =
    scopeChoice === "selection" && !hasSelection
      ? "filters"
      : (scopeChoice ?? (hasSelection ? "selection" : "filters"));
  const trashLocked = scope === "selection" || (scope === "filters" && trashView);
  const trashChecked =
    scope === "filters" && trashView ? true : scope === "selection" ? false : includeTrash;

  const close = () => {
    if (working) return;
    setOpen(false);
    setError(null);
  };

  const run = async () => {
    setWorking(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/product-exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          scope,
          ...(scope === "selection" && { ids: selectedIds }),
          ...(scope === "filters" && { filters }),
          includeTrash: trashChecked && !trashLocked,
        }),
      });
      if (!response.ok) {
        let code: string | undefined;
        let message: string | undefined;
        try {
          const body = (await response.json()) as { code?: string; message?: string };
          code = body.code;
          message = body.message;
        } catch {
          // corp ilizibil: mesajul generic
        }
        setError(errorText(code, message));
        return;
      }
      const blob = await response.blob();
      const name = fileNameOf(response, `export-produse.${format}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setAnnouncement(m.done(name));
      setOpen(false);
    } catch {
      setError(m.errors.network);
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <p aria-live="polite" className="sr-only" data-export-status>
        {announcement}
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        data-export-open
      >
        <Download aria-hidden="true" className="size-4" />
        {m.openButton}
      </Button>

      <Dialog
        open={open}
        onClose={close}
        title={m.title}
        description={m.description}
        closeLabel={m.close}
        className="max-w-lg"
      >
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <fieldset className="flex flex-col gap-2" data-export-scope>
            <legend className="mb-1 text-sm font-medium">{m.scopeLegend}</legend>
            <Label className="flex items-start gap-2 font-normal">
              <input
                type="radio"
                name="export-scope"
                value="selection"
                className={RADIO}
                checked={scope === "selection"}
                disabled={!hasSelection}
                onChange={() => setScopeChoice("selection")}
              />
              <span>
                {hasSelection ? m.scope.selection(selectedIds.length) : m.scope.selectionNone}
              </span>
            </Label>
            <Label className="flex items-start gap-2 font-normal">
              <input
                type="radio"
                name="export-scope"
                value="filters"
                className={RADIO}
                checked={scope === "filters"}
                onChange={() => setScopeChoice("filters")}
              />
              <span>{m.scope.filters(filteredTotal)}</span>
            </Label>
            <Label className="flex items-start gap-2 font-normal">
              <input
                type="radio"
                name="export-scope"
                value="all"
                className={RADIO}
                checked={scope === "all"}
                onChange={() => setScopeChoice("all")}
              />
              <span>{m.scope.all}</span>
            </Label>
          </fieldset>

          <div className="flex flex-col gap-1">
            <Label className="flex items-start gap-2 font-normal">
              <input
                type="checkbox"
                className={RADIO}
                checked={trashChecked}
                disabled={trashLocked}
                onChange={(event) => setIncludeTrash(event.target.checked)}
                aria-describedby="export-trash-help"
                data-export-trash
              />
              <span>{m.includeTrash}</span>
            </Label>
            <p id="export-trash-help" className="pl-6 text-xs text-muted-foreground">
              {m.includeTrashHelp}
            </p>
          </div>

          <fieldset className="flex flex-col gap-2" data-export-format>
            <legend className="mb-1 text-sm font-medium">{m.formatLegend}</legend>
            <Label className="flex items-start gap-2 font-normal">
              <input
                type="radio"
                name="export-format"
                value="xlsx"
                className={RADIO}
                checked={format === "xlsx"}
                onChange={() => setFormat("xlsx")}
              />
              <span className="flex flex-col">
                <span>{m.format.xlsx}</span>
                <span className="text-xs text-muted-foreground">{m.format.xlsxHelp}</span>
              </span>
            </Label>
            <Label className="flex items-start gap-2 font-normal">
              <input
                type="radio"
                name="export-format"
                value="csv"
                className={RADIO}
                checked={format === "csv"}
                onChange={() => setFormat("csv")}
              />
              <span className="flex flex-col">
                <span>{m.format.csv}</span>
                <span className="text-xs text-muted-foreground">{m.format.csvHelp}</span>
              </span>
            </Label>
          </fieldset>

          <p role="alert" className="min-h-5 text-sm text-danger" data-export-error>
            {error}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={close} disabled={working}>
              {m.cancel}
            </Button>
            <Button type="submit" disabled={working} data-export-submit>
              {working ? m.working : m.submit}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
