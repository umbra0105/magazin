"use client";

import { Pencil, Power } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Dialog, Input, Label, Select } from "@ecom/ui";
import {
  createMeasureUnit,
  updateMeasureUnit,
} from "@/app/(admin)/admin/unitati-de-masura/actions";
import type { ProductActionFailure } from "@/lib/product-action-support";
import { getMessages } from "@/messages";

const m = getMessages().admin.measureUnits;

/** Unitatea implicită: o unitate nulă pe un produs înseamnă exact aceasta (oglindește `DEFAULT_MEASURE_UNIT_CODE`). */
const DEFAULT_UNIT_CODE = "buc";
const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface MeasureUnitRow {
  id: string;
  code: string;
  name: string;
  symbol: string;
  smartbillName: string | null;
  decimals: number;
  isActive: boolean;
  isSystem: boolean;
  productCount: number;
  variantCount: number;
}

function errorText(result: ProductActionFailure): string {
  const errors = m.errors as Record<string, string>;
  return result.message ?? errors[result.code] ?? m.errors.generic;
}

/** Lista unităților de măsură, cu creare, editare și dezactivare. Scrierea cere `products.write`. */
export function MeasureUnitManager({
  rows,
  canWrite,
}: {
  rows: readonly MeasureUnitRow[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [target, setTarget] = useState<MeasureUnitRow | "new" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pending, startTransition] = useTransition();

  const toggle = (row: MeasureUnitRow) => {
    startTransition(async () => {
      try {
        const result = await updateMeasureUnit({ id: row.id, isActive: !row.isActive });
        if (result.ok) {
          setProblem(null);
          setAnnouncement(row.isActive ? m.live.deactivated(row.name) : m.live.activated(row.name));
          router.refresh();
        } else {
          setProblem(errorText(result));
        }
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <p role="note" className="rounded-md border border-border bg-border/30 p-3 text-sm">
        {m.defaultNote}
      </p>
      {canWrite && (
        <div className="flex justify-end">
          <Button onClick={() => setTarget("new")}>{m.create}</Button>
        </div>
      )}
      {problem && (
        <p
          role="alert"
          data-problem
          className="rounded-md border border-danger p-3 text-sm text-danger"
        >
          {problem}
        </p>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {rows.length === 0 ? (
        <p className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
          {m.empty}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[48rem] text-left text-sm" aria-label={m.listLabel}>
            <thead className="border-b border-border bg-border/30">
              <tr>
                {(
                  ["name", "code", "symbol", "decimals", "smartbill", "usage", "status"] as const
                ).map((column) => (
                  <th key={column} scope="col" className="p-3 font-medium">
                    {m.columns[column]}
                  </th>
                ))}
                {canWrite && (
                  <th scope="col" className="p-3 text-right font-medium">
                    {m.columns.actions}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  data-unit-row={row.code}
                  data-active={row.isActive ? "true" : "false"}
                  className="border-b border-border last:border-0"
                >
                  <td className="p-3 font-medium">{row.name}</td>
                  <td className="p-3 text-muted-foreground">{row.code}</td>
                  <td className="p-3">{row.symbol}</td>
                  <td className="p-3">{m.decimalsValue(row.decimals)}</td>
                  <td className="p-3">{row.smartbillName ?? m.noSmartbill}</td>
                  <td className="p-3">{m.usage(row.productCount, row.variantCount)}</td>
                  <td className="p-3">
                    <span className="flex flex-wrap gap-1">
                      <Badge>{row.isActive ? m.status.active : m.status.inactive}</Badge>
                      {row.code === DEFAULT_UNIT_CODE && <Badge>{m.status.default}</Badge>}
                    </span>
                  </td>
                  {canWrite && (
                    <td className="p-3">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={m.actions.edit(row.name)}
                          onClick={() => setTarget(row)}
                        >
                          <Pencil aria-hidden="true" className="h-4 w-4" />
                          <span className="ml-1 hidden sm:inline">{m.actions.editLabel}</span>
                        </Button>
                        {row.code !== DEFAULT_UNIT_CODE && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={pending}
                            aria-label={
                              row.isActive
                                ? m.actions.deactivate(row.name)
                                : m.actions.activate(row.name)
                            }
                            onClick={() => toggle(row)}
                          >
                            <Power aria-hidden="true" className="h-4 w-4" />
                            <span className="ml-1 hidden sm:inline">
                              {row.isActive ? m.actions.deactivateLabel : m.actions.activateLabel}
                            </span>
                          </Button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <UnitFormDialog
        key={target === null ? "closed" : target === "new" ? "new" : target.id}
        target={target}
        onClose={() => setTarget(null)}
        onSaved={(message) => {
          setTarget(null);
          setProblem(null);
          setAnnouncement(message);
          router.refresh();
        }}
      />
    </div>
  );
}

function UnitFormDialog({
  target,
  onClose,
  onSaved,
}: {
  target: MeasureUnitRow | "new" | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const editing = target !== null && target !== "new" ? target : null;
  const isNew = target === "new";
  const isDefault = editing?.code === DEFAULT_UNIT_CODE;
  const [code, setCode] = useState(editing?.code ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [symbol, setSymbol] = useState(editing?.symbol ?? "");
  const [decimals, setDecimals] = useState(String(editing?.decimals ?? 0));
  const [smartbillName, setSmartbillName] = useState(editing?.smartbillName ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (target === null) {
    return (
      <Dialog open={false} onClose={onClose} title="" closeLabel={m.form.close}>
        {null}
      </Dialog>
    );
  }

  const validate = (): Record<string, string> => {
    const found: Record<string, string> = {};
    if (isNew) {
      if (code.trim() === "") found["code"] = m.errors.codeRequired;
      else if (!CODE_PATTERN.test(code.trim()) || code.trim().length > 30) {
        found["code"] = m.errors.codeInvalid;
      }
    }
    if (name.trim() === "") found["name"] = m.errors.nameRequired;
    if (symbol.trim() === "") found["symbol"] = m.errors.symbolRequired;
    return found;
  };

  const submit = () => {
    const found = validate();
    setErrors(found);
    setProblem(null);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(`unit-${first}`)?.focus();
      return;
    }
    startTransition(async () => {
      try {
        const smartbill = smartbillName.trim() === "" ? null : smartbillName.trim();
        if (isNew) {
          const result = await createMeasureUnit({
            code: code.trim(),
            name: name.trim(),
            symbol: symbol.trim(),
            decimals: Number(decimals),
            smartbillName: smartbill,
          });
          if (result.ok) onSaved(m.live.created(name.trim()));
          else setProblem(errorText(result));
          return;
        }
        if (!editing) return;
        const patch: Record<string, unknown> = {};
        if (name.trim() !== editing.name) patch["name"] = name.trim();
        if (symbol.trim() !== editing.symbol) patch["symbol"] = symbol.trim();
        if (Number(decimals) !== editing.decimals) patch["decimals"] = Number(decimals);
        if (smartbill !== editing.smartbillName) patch["smartbillName"] = smartbill;
        if (Object.keys(patch).length === 0) {
          onSaved(m.live.updated(editing.name));
          return;
        }
        const result = await updateMeasureUnit({ id: editing.id, ...patch });
        if (result.ok) onSaved(m.live.updated(name.trim()));
        else setProblem(errorText(result));
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  const field = (id: string, label: string, error: string | undefined, help?: string) => ({
    id: `unit-${id}`,
    label,
    error,
    help,
  });
  const parts = {
    code: field("code", m.form.code, errors["code"], isNew ? m.form.codeHelp : m.form.codeLocked),
    name: field("name", m.form.name, errors["name"]),
    symbol: field("symbol", m.form.symbol, errors["symbol"], m.form.symbolHelp),
    decimals: field(
      "decimals",
      m.form.decimals,
      undefined,
      isDefault ? m.form.decimalsLocked : m.form.decimalsHelp,
    ),
    smartbill: field("smartbill", m.form.smartbillName, undefined, m.form.smartbillHelp),
  };
  const describedBy = (p: { id: string; error: string | undefined; help: string | undefined }) =>
    [p.help ? `${p.id}-help` : null, p.error ? `${p.id}-error` : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? m.form.editTitle(editing.name) : m.form.createTitle}
      closeLabel={m.form.close}
      className="max-w-lg"
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {(
          [
            ["code", parts.code, code, setCode, !isNew, 30],
            ["name", parts.name, name, setName, false, 100],
            ["symbol", parts.symbol, symbol, setSymbol, false, 20],
          ] as const
        ).map(([key, p, value, setValue, locked, max]) => (
          <div key={key} className="flex flex-col gap-1.5">
            <Label htmlFor={p.id}>{p.label}</Label>
            <Input
              id={p.id}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              maxLength={max}
              disabled={locked}
              autoComplete="off"
              {...(p.error && { "aria-invalid": true as const })}
              {...(describedBy(p) && { "aria-describedby": describedBy(p) })}
            />
            {p.help && (
              <p id={`${p.id}-help`} className="text-xs text-muted-foreground">
                {p.help}
              </p>
            )}
            {p.error && (
              <p id={`${p.id}-error`} className="text-xs text-danger">
                {p.error}
              </p>
            )}
          </div>
        ))}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={parts.decimals.id}>{parts.decimals.label}</Label>
          <Select
            id={parts.decimals.id}
            value={decimals}
            onChange={(event) => setDecimals(event.target.value)}
            disabled={isDefault}
            aria-describedby={`${parts.decimals.id}-help`}
          >
            {[0, 1, 2, 3, 4].map((n) => (
              <option key={n} value={String(n)}>
                {m.form.decimalsOption(n)}
              </option>
            ))}
          </Select>
          <p id={`${parts.decimals.id}-help`} className="text-xs text-muted-foreground">
            {parts.decimals.help}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={parts.smartbill.id}>{parts.smartbill.label}</Label>
          <Input
            id={parts.smartbill.id}
            value={smartbillName}
            onChange={(event) => setSmartbillName(event.target.value)}
            maxLength={100}
            autoComplete="off"
            aria-describedby={`${parts.smartbill.id}-help`}
          />
          <p id={`${parts.smartbill.id}-help`} className="text-xs text-muted-foreground">
            {parts.smartbill.help}
          </p>
        </div>
        {problem && (
          <p
            role="alert"
            data-problem
            className="rounded-md border border-danger p-3 text-sm text-danger"
          >
            {problem}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {m.form.cancel}
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? m.form.saving : m.form.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
