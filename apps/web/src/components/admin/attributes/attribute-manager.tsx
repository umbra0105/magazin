"use client";

import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  RowHeader,
  Select,
  TBody,
  THead,
  Table,
  Td,
  Textarea,
  Th,
  Tr,
} from "@ecom/ui";
import {
  addAttributeOption,
  createAttribute,
  deleteAttribute,
  deleteAttributeOption,
  renameAttributeOption,
  reorderAttributeOptions,
  updateAttribute,
} from "@/app/(admin)/admin/produse/atribute/actions";
import { CheckField, Field } from "@/components/admin/products/editor-ui";
import type { ProductActionFailure } from "@/lib/product-action-support";
import { getMessages } from "@/messages";

const m = getMessages().admin.attributes;
const f = m.form;

type AttributeType = "text" | "number" | "select" | "bool";

export interface AttributeRow {
  id: string;
  code: string;
  name: string;
  type: AttributeType;
  unit: string | null;
  isFilterable: boolean;
  sortOrder: number;
  productCount: number;
  options: { id: string; value: string; productCount: number }[];
}

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

function failureText(result: ProductActionFailure): string {
  const errors = m.errors as Record<string, string>;
  return result.message ?? errors[result.code] ?? m.errors.generic;
}

/**
 * Pagina Atribute: lista definițiilor, crearea, editarea (nume, unitate, filtrabil, opțiuni) și
 * ștergerea. Regulile (tip blocat cu valori, ștergere refuzată cât e folosit) sunt pe server; aici
 * doar se arată mesajele lor. Fără `canWrite`, pagina e doar pentru citire.
 */
export function AttributeManager({
  attributes,
  canWrite,
}: {
  attributes: readonly AttributeRow[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AttributeRow | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const editing = attributes.find((a) => a.id === editingId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-body text-ink-secondary">
          {status}
        </p>
        {canWrite && attributes.length > 0 && (
          <Button
            type="button"
            onClick={() => {
              setStatus(null);
              setCreating(true);
            }}
          >
            {m.new}
          </Button>
        )}
      </div>

      {attributes.length === 0 ? (
        <EmptyState
          title={m.empty}
          {...(canWrite && {
            action: (
              <Button
                type="button"
                onClick={() => {
                  setStatus(null);
                  setCreating(true);
                }}
              >
                {m.new}
              </Button>
            ),
          })}
        />
      ) : (
        <Table stacked aria-label={m.table.label}>
          <THead>
            <Tr>
              <Th>{m.table.name}</Th>
              <Th priority="secondary">{m.table.code}</Th>
              <Th>{m.table.type}</Th>
              <Th priority="secondary">{m.table.unit}</Th>
              <Th priority="tertiary">{m.table.filterable}</Th>
              <Th priority="tertiary" numeric>
                {m.table.usage}
              </Th>
              <Th priority="detail">{m.table.options}</Th>
              {canWrite && <Th numeric>{m.table.actions}</Th>}
            </Tr>
          </THead>
          <TBody>
            {attributes.map((a) => (
              <Tr key={a.id} data-attribute-row={a.code}>
                <RowHeader
                  className={
                    canWrite
                      ? "font-medium group-data-[stacked]/table:@max-2xl/table:pr-24"
                      : "font-medium"
                  }
                >
                  {a.name}
                </RowHeader>
                <Td
                  priority="secondary"
                  className="whitespace-nowrap text-ink-secondary"
                  data-cell="code"
                >
                  <span data-cell-text title={a.code} className="block max-w-44 truncate">
                    {a.code}
                  </span>
                </Td>
                <Td className="whitespace-nowrap" data-cell="type">
                  {m.types[a.type]}
                </Td>
                <Td priority="secondary" className="whitespace-nowrap" data-cell="unit">
                  {a.unit ?? "—"}
                </Td>
                <Td priority="tertiary" data-cell="filterable">
                  <Badge variant={a.isFilterable ? "success" : "neutral"} dot>
                    {a.isFilterable ? m.yes : m.no}
                  </Badge>
                </Td>
                <Td priority="tertiary" numeric className="whitespace-nowrap" data-cell="usage">
                  {m.usage(a.productCount)}
                </Td>
                <Td priority="detail" className="whitespace-nowrap" data-cell="options">
                  {a.type === "select" ? m.optionsCount(a.options.length) : "—"}
                </Td>
                {canWrite && (
                  <Td stack="corner" data-cell="actions">
                    <div className="flex justify-end gap-1 group-data-[stacked]/table:@max-2xl/table:justify-start">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={m.edit(a.name)}
                        title={m.editLabel}
                        onClick={() => {
                          setStatus(null);
                          setEditingId(a.id);
                        }}
                      >
                        <Pencil aria-hidden className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={m.delete.button(a.name)}
                        title={m.deleteLabel}
                        onClick={() => setDeleting(a)}
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    </div>
                  </Td>
                )}
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setStatus(f.created);
            router.refresh();
            // pentru liste, deschide direct editarea ca să adaugi opțiuni
            if (id) setEditingId(id);
          }}
        />
      )}
      {editing && (
        <EditDialog
          attribute={editing}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            setStatus(f.saved);
            router.refresh();
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          attribute={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            setStatus(m.delete.done);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (idToEdit: string | null) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [type, setType] = useState<AttributeType>("number");
  const [unit, setUnit] = useState("");
  const [filterable, setFilterable] = useState(false);
  const [sortOrder, setSortOrder] = useState("0");
  const [initialOptions, setInitialOptions] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (name.trim() === "") found["name"] = f.nameRequired;
    if (code.trim() === "") found["code"] = f.codeRequired;
    else if (!CODE_PATTERN.test(code.trim())) found["code"] = f.codeInvalid;
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length > 0) return;

    startTransition(async () => {
      try {
        const options = initialOptions
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const result = await createAttribute({
          code: code.trim(),
          name: name.trim(),
          type,
          ...(type === "number" && unit.trim() !== "" && { unit: unit.trim() }),
          isFilterable: type !== "text" && filterable,
          sortOrder: Number.parseInt(sortOrder, 10) || 0,
          ...(type === "select" && options.length > 0 && { options }),
        });
        if (result.ok) {
          onCreated(type === "select" ? result.attribute.id : null);
          return;
        }
        const text = failureText(result);
        if (result.code === "ATTRIBUTE_CODE_CONFLICT") setErrors({ code: text });
        else setProblem(text);
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  return (
    <Dialog open onClose={onClose} title={f.createTitle} closeLabel={f.close} className="max-w-xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field id="attr-name" label={f.name} error={errors["name"]}>
          {(control) => (
            <Input
              {...control}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              autoFocus
            />
          )}
        </Field>
        <Field id="attr-code" label={f.code} help={f.codeHelp} error={errors["code"]}>
          {(control) => (
            <Input
              {...control}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={50}
              autoComplete="off"
            />
          )}
        </Field>
        <Field id="attr-type" label={f.type}>
          {(control) => (
            <Select
              {...control}
              value={type}
              onChange={(e) => {
                const next = e.target.value as AttributeType;
                setType(next);
                if (next === "text") setFilterable(false);
              }}
            >
              {(Object.keys(m.types) as AttributeType[]).map((t) => (
                <option key={t} value={t}>
                  {m.types[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {type === "number" && (
          <Field id="attr-unit" label={f.unit} help={f.unitHelp}>
            {(control) => (
              <Input
                {...control}
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                maxLength={20}
              />
            )}
          </Field>
        )}
        {type === "select" && (
          <Field id="attr-options" label={f.optionsInitial} help={f.optionsAfterCreate}>
            {(control) => (
              <Textarea
                {...control}
                value={initialOptions}
                onChange={(e) => setInitialOptions(e.target.value)}
                rows={4}
              />
            )}
          </Field>
        )}
        {type !== "text" && (
          <CheckField
            id="attr-filterable"
            label={f.filterable}
            help={f.filterableHelp}
            checked={filterable}
            onChange={setFilterable}
          />
        )}
        <Field id="attr-sort" label={f.sortOrder}>
          {(control) => (
            <Input
              {...control}
              type="number"
              min={0}
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          )}
        </Field>

        {problem && (
          <p
            role="alert"
            data-problem
            className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
          >
            {problem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {f.cancel}
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? f.creating : f.create}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditDialog({
  attribute,
  onClose,
  onSaved,
}: {
  attribute: AttributeRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(attribute.name);
  const [type, setType] = useState<AttributeType>(attribute.type);
  const [unit, setUnit] = useState(attribute.unit ?? "");
  const [filterable, setFilterable] = useState(attribute.isFilterable);
  const [sortOrder, setSortOrder] = useState(String(attribute.sortOrder));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [optionProblem, setOptionProblem] = useState<string | null>(null);
  const [newOption, setNewOption] = useState("");
  const locked = attribute.productCount > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (name.trim() === "") found["name"] = f.nameRequired;
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length > 0) return;

    const patch: Record<string, unknown> = {};
    if (name.trim() !== attribute.name) patch["name"] = name.trim();
    if (type !== attribute.type) patch["type"] = type;
    const nextUnit = type === "number" ? unit.trim() || null : null;
    if (nextUnit !== attribute.unit) patch["unit"] = nextUnit;
    const nextFilterable = type === "text" ? false : filterable;
    if (nextFilterable !== attribute.isFilterable) patch["isFilterable"] = nextFilterable;
    const order = Number.parseInt(sortOrder, 10) || 0;
    if (order !== attribute.sortOrder) patch["sortOrder"] = order;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    startTransition(async () => {
      try {
        const result = await updateAttribute({ id: attribute.id, patch });
        if (result.ok) {
          onSaved();
          onClose();
          return;
        }
        setProblem(failureText(result));
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  /** Rulează o acțiune pe opțiuni; la succes reîncarcă datele paginii. */
  const optionAction = (run: () => Promise<{ ok: true } | ProductActionFailure>) => {
    setOptionProblem(null);
    startTransition(async () => {
      try {
        const result = await run();
        if (result.ok) router.refresh();
        else setOptionProblem(failureText(result));
      } catch {
        setOptionProblem(m.errors.generic);
      }
    });
  };

  const moveOption = (index: number, delta: -1 | 1) => {
    const ids = attribute.options.map((o) => o.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const [moved] = ids.splice(index, 1);
    if (!moved) return;
    ids.splice(target, 0, moved);
    optionAction(() => reorderAttributeOptions({ attributeId: attribute.id, orderedIds: ids }));
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={f.editTitle(attribute.name)}
      closeLabel={f.close}
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-6">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <Field id="edit-name" label={f.name} error={errors["name"]}>
            {(control) => (
              <Input
                {...control}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
              />
            )}
          </Field>
          <Field id="edit-code" label={f.code}>
            {(control) => <Input {...control} value={attribute.code} readOnly />}
          </Field>
          <Field
            id="edit-type"
            label={f.type}
            help={locked ? f.typeLocked(attribute.productCount) : f.typeFree}
          >
            {(control) => (
              <Select
                {...control}
                value={type}
                disabled={locked}
                onChange={(e) => {
                  const next = e.target.value as AttributeType;
                  setType(next);
                  if (next === "text") setFilterable(false);
                }}
              >
                {(Object.keys(m.types) as AttributeType[]).map((t) => (
                  <option key={t} value={t}>
                    {m.types[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {type === "number" && (
            <Field id="edit-unit" label={f.unit} help={f.unitHelp}>
              {(control) => (
                <Input
                  {...control}
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  maxLength={20}
                />
              )}
            </Field>
          )}
          {type !== "text" && (
            <CheckField
              id="edit-filterable"
              label={f.filterable}
              help={f.filterableHelp}
              checked={filterable}
              onChange={setFilterable}
            />
          )}
          <Field id="edit-sort" label={f.sortOrder}>
            {(control) => (
              <Input
                {...control}
                type="number"
                min={0}
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              />
            )}
          </Field>
          {problem && (
            <p
              role="alert"
              data-problem
              className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
            >
              {problem}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {f.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? f.saving : f.save}
            </Button>
          </div>
        </form>

        {attribute.type === "select" && (
          <section
            aria-labelledby="options-heading"
            className="flex flex-col gap-3 border-t border-line-subtle pt-4"
          >
            <h3 id="options-heading" className="text-body font-semibold">
              {f.options}
            </h3>
            <p className="text-body text-ink-secondary">{f.optionsHelp}</p>
            {optionProblem && (
              <p
                role="alert"
                data-problem
                className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
              >
                {optionProblem}
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {attribute.options.map((option, index) => (
                <OptionRow
                  key={`${option.id}:${option.value}`}
                  option={option}
                  index={index}
                  total={attribute.options.length}
                  pending={pending}
                  onRename={(value) =>
                    optionAction(() => renameAttributeOption({ optionId: option.id, value }))
                  }
                  onDelete={() =>
                    optionAction(() => deleteAttributeOption({ optionId: option.id }))
                  }
                  onMove={(delta) => moveOption(index, delta)}
                />
              ))}
            </ul>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1">
                <Field id="option-new" label={f.optionNew}>
                  {(control) => (
                    <Input
                      {...control}
                      value={newOption}
                      onChange={(e) => setNewOption(e.target.value)}
                      maxLength={100}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          document.getElementById("option-add")?.click();
                        }
                      }}
                    />
                  )}
                </Field>
              </div>
              <Button
                id="option-add"
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  if (newOption.trim() === "") {
                    setOptionProblem(f.optionRequired);
                    return;
                  }
                  optionAction(async () => {
                    const result = await addAttributeOption({
                      attributeId: attribute.id,
                      value: newOption.trim(),
                    });
                    if (result.ok) setNewOption("");
                    return result.ok ? { ok: true as const } : result;
                  });
                }}
              >
                {f.optionAdd}
              </Button>
            </div>
          </section>
        )}
      </div>
    </Dialog>
  );
}

function OptionRow({
  option,
  index,
  total,
  pending,
  onRename,
  onDelete,
  onMove,
}: {
  option: { id: string; value: string; productCount: number };
  index: number;
  total: number;
  pending: boolean;
  onRename: (value: string) => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
}) {
  const [draft, setDraft] = useState(option.value);
  const changed = draft.trim() !== option.value && draft.trim() !== "";
  return (
    <li data-option-row={option.value} className="flex flex-wrap items-center gap-2">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={f.optionRename(option.value)}
        maxLength={100}
        className="min-w-40 flex-1"
      />
      {changed && (
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => onRename(draft.trim())}
        >
          {f.optionSave}
        </Button>
      )}
      <span className="text-label text-ink-secondary">
        {option.productCount > 0 ? f.optionUsedBy(option.productCount) : ""}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={pending || index === 0}
        aria-label={f.optionMoveUp(option.value)}
        title={f.optionMoveUp(option.value)}
        onClick={() => onMove(-1)}
      >
        <ArrowUp aria-hidden className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={pending || index === total - 1}
        aria-label={f.optionMoveDown(option.value)}
        title={f.optionMoveDown(option.value)}
        onClick={() => onMove(1)}
      >
        <ArrowDown aria-hidden className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={pending}
        aria-label={f.optionDelete(option.value)}
        title={f.optionDelete(option.value)}
        onClick={onDelete}
      >
        <Trash2 aria-hidden className="size-4" />
      </Button>
    </li>
  );
}

function DeleteDialog({
  attribute,
  onClose,
  onDeleted,
}: {
  attribute: AttributeRow;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={m.delete.title(attribute.name)}
      description={m.delete.description}
      closeLabel={f.close}
    >
      <div className="flex flex-col gap-4">
        {problem && (
          <p
            role="alert"
            data-problem
            className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
          >
            {problem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {f.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                try {
                  const result = await deleteAttribute({ id: attribute.id });
                  if (result.ok) onDeleted();
                  else setProblem(failureText(result));
                } catch {
                  setProblem(m.errors.generic);
                }
              })
            }
          >
            {pending ? m.delete.deleting : m.delete.confirm}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
