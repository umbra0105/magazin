"use client";

import { Pencil, Power } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  Label,
  RowHeader,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
} from "@ecom/ui";
import {
  createWarehouse,
  renameWarehouse,
  setWarehouseActive,
} from "@/app/(admin)/admin/produse/depozite/actions";
import type { ProductActionFailure } from "@/lib/product-action-support";
import { getMessages } from "@/messages";

const m = getMessages().admin.warehouses;

/** Oglindește `WAREHOUSE_NAME_MAX_LENGTH` din nucleu (validarea reală e pe server). */
const NAME_MAX = 100;

export interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  /** Rânduri de stoc cu cantitate fizică, angajată sau rezervată nenulă */
  stockedItems: number;
}

function errorText(result: ProductActionFailure): string {
  const errors = m.errors as Record<string, string>;
  return result.message ?? errors[result.code] ?? m.errors.generic;
}

/**
 * Lista depozitelor, cu creare, redenumire (și a celui implicit) și dezactivare / activare. Fără `inventory.write` butoanele de
 * scriere sunt dezactivate. Regulile (depozitul implicit nu se dezactivează, un depozit cu stoc nu se dezactivează, nume unic)
 * sunt pe server; aici apar doar ca indicii. Lista e un `Table` (docs/17): pe telefon fiecare depozit e un card cu acțiunile în
 * colțul din dreapta-sus, iar acțiunile sunt doar pictograme terțe, cu nume accesibil și tooltip.
 */
export function WarehouseManager({
  rows,
  canWrite,
}: {
  rows: readonly WarehouseRow[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState<WarehouseRow | "new" | null>(null);
  const [confirming, setConfirming] = useState<WarehouseRow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pending, startTransition] = useTransition();

  const activate = (row: WarehouseRow) => {
    startTransition(async () => {
      try {
        const result = await setWarehouseActive({ id: row.id, active: true });
        if (result.ok) {
          setProblem(null);
          setAnnouncement(m.live.activated(row.name));
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
      <p role="note" className="rounded-lg bg-surface-subtle p-3 text-body">
        {m.defaultNote}
      </p>
      {rows.length > 0 && (
        <div className="flex justify-end">
          <Button disabled={!canWrite} onClick={() => setForm("new")} data-warehouse-create>
            {m.create}
          </Button>
        </div>
      )}
      {problem && (
        <p
          role="alert"
          data-problem
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {problem}
        </p>
      )}
      <p role="status" aria-live="polite" className="sr-only" data-announcement>
        {announcement}
      </p>

      {rows.length === 0 ? (
        <EmptyState
          title={m.empty}
          action={
            <Button disabled={!canWrite} onClick={() => setForm("new")} data-warehouse-create>
              {m.create}
            </Button>
          }
        />
      ) : (
        <Table stacked aria-label={m.listLabel}>
          <THead>
            <Tr>
              <Th>{m.columns.name}</Th>
              <Th priority="secondary">{m.columns.code}</Th>
              <Th priority="secondary">{m.columns.stock}</Th>
              <Th>{m.columns.status}</Th>
              <Th numeric>{m.columns.actions}</Th>
            </Tr>
          </THead>
          <TBody>
            {rows.map((row) => (
              <Tr
                key={row.id}
                data-warehouse-row={row.code}
                data-active={row.isActive ? "true" : "false"}
                data-default={row.isDefault ? "true" : "false"}
              >
                <RowHeader className="font-medium group-data-[stacked]/table:@max-2xl/table:pr-24">
                  {row.name}
                </RowHeader>
                <Td
                  priority="secondary"
                  className="whitespace-nowrap text-ink-secondary"
                  data-cell="code"
                >
                  <span data-cell-text title={row.code} className="block max-w-44 truncate">
                    {row.code}
                  </span>
                </Td>
                <Td priority="secondary" className="whitespace-nowrap" data-cell="stock">
                  {m.stockedItems(row.stockedItems)}
                </Td>
                <Td data-cell="status">
                  <span className="inline-flex flex-wrap gap-1">
                    <Badge variant={row.isActive ? "success" : "neutral"} dot data-status-pill>
                      {row.isActive ? m.status.active : m.status.inactive}
                    </Badge>
                    {row.isDefault && (
                      <Badge variant="info" data-status-pill>
                        {m.status.default}
                      </Badge>
                    )}
                  </span>
                </Td>
                <Td stack="corner" data-cell="actions">
                  <div className="flex justify-end gap-1 group-data-[stacked]/table:@max-2xl/table:justify-start">
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={!canWrite}
                      aria-label={m.actions.rename(row.name)}
                      title={m.actions.renameLabel}
                      onClick={() => setForm(row)}
                    >
                      <Pencil aria-hidden="true" className="size-4" />
                    </Button>
                    {!row.isDefault &&
                      (row.isActive ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={!canWrite}
                          aria-label={m.actions.deactivate(row.name)}
                          title={m.actions.deactivateLabel}
                          onClick={() => setConfirming(row)}
                        >
                          <Power aria-hidden="true" className="size-4" />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={!canWrite || pending}
                          aria-label={m.actions.activate(row.name)}
                          title={m.actions.activateLabel}
                          onClick={() => activate(row)}
                        >
                          <Power aria-hidden="true" className="size-4" />
                        </Button>
                      ))}
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      <NameDialog
        key={form === null ? "closed" : form === "new" ? "new" : form.id}
        target={form}
        onClose={() => setForm(null)}
        onSaved={(message) => {
          setForm(null);
          setProblem(null);
          setAnnouncement(message);
          router.refresh();
        }}
      />
      <DeactivateDialog
        key={confirming ? `off-${confirming.id}` : "off-closed"}
        target={confirming}
        onClose={() => setConfirming(null)}
        onDone={(message) => {
          setConfirming(null);
          setProblem(null);
          setAnnouncement(message);
          router.refresh();
        }}
      />
    </div>
  );
}

/** Creare și redenumire: un singur câmp, «Nume». */
function NameDialog({
  target,
  onClose,
  onSaved,
}: {
  target: WarehouseRow | "new" | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const editing = target !== null && target !== "new" ? target : null;
  const [name, setName] = useState(editing?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (target === null) {
    return (
      <Dialog open={false} onClose={onClose} title="" closeLabel={m.form.close}>
        {null}
      </Dialog>
    );
  }

  const submit = () => {
    const trimmed = name.trim();
    setProblem(null);
    const found =
      trimmed === ""
        ? m.errors.nameRequired
        : trimmed.length > NAME_MAX
          ? m.errors.nameTooLong
          : null;
    setError(found);
    if (found) {
      document.getElementById("warehouse-name")?.focus();
      return;
    }
    if (editing && trimmed === editing.name) {
      onSaved(m.live.renamed(editing.name));
      return;
    }
    startTransition(async () => {
      try {
        const result = editing
          ? await renameWarehouse({ id: editing.id, name: trimmed })
          : await createWarehouse({ name: trimmed });
        if (result.ok) onSaved(editing ? m.live.renamed(trimmed) : m.live.created(trimmed));
        else setProblem(errorText(result));
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? m.form.renameTitle(editing.name) : m.form.createTitle}
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
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="warehouse-name">{m.form.name}</Label>
          <Input
            id="warehouse-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={NAME_MAX}
            autoComplete="off"
            {...(error && { "aria-invalid": true as const })}
            aria-describedby={
              error ? "warehouse-name-help warehouse-name-error" : "warehouse-name-help"
            }
          />
          <p id="warehouse-name-help" className="text-label text-ink-secondary">
            {m.form.nameHelp}
          </p>
          {error && (
            <p id="warehouse-name-error" className="text-label text-tone-problem-fg">
              {error}
            </p>
          )}
        </div>
        {problem && (
          <p
            role="alert"
            data-problem
            className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
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

/**
 * Confirmarea dezactivării: acțiune de pericol (nu buton principal). Un depozit cu stoc nu se dezactivează: dialogul spune de ce,
 * iar serverul refuză oricum.
 */
function DeactivateDialog({
  target,
  onClose,
  onDone,
}: {
  target: WarehouseRow | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!target) {
    return (
      <Dialog open={false} onClose={onClose} title="" closeLabel={m.confirm.close}>
        {null}
      </Dialog>
    );
  }
  const blocked = target.stockedItems > 0;

  const confirm = () => {
    setProblem(null);
    startTransition(async () => {
      try {
        const result = await setWarehouseActive({ id: target.id, active: false });
        if (result.ok) onDone(m.live.deactivated(target.name));
        else setProblem(errorText(result));
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={m.confirm.title(target.name)}
      closeLabel={m.confirm.close}
      className="max-w-lg"
    >
      <div className="flex flex-col gap-4">
        <p className="text-body">{m.confirm.body}</p>
        {blocked && (
          <p
            role="note"
            data-has-stock
            className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
          >
            {m.confirm.hasStock(target.stockedItems)}
          </p>
        )}
        {problem && (
          <p
            role="alert"
            data-problem
            className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
          >
            {problem}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {m.confirm.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending || blocked}
            onClick={confirm}
          >
            {pending ? m.confirm.confirming : m.confirm.confirm}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
