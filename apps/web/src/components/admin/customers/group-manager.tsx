"use client";

import { Pencil, Trash2 } from "lucide-react";
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
  Select,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
} from "@ecom/ui";
import {
  createCustomerGroup,
  deleteCustomerGroup,
  updateCustomerGroup,
} from "@/app/(admin)/admin/clienti/grupuri/actions";
import {
  MAX_DISCOUNT_PERCENT,
  MAX_MARKUP_PERCENT,
  bpsToPercentText,
  parsePercentToBps,
} from "@/lib/customer-group-form";
import type { ProductActionFailure } from "@/lib/product-action-support";
import { getMessages } from "@/messages";

const m = getMessages().admin.customerGroups;

type Tone = "neutral" | "info" | "success" | "warning" | "danger";
type PricingType = "none" | "discount" | "cost_plus";
const TONES: readonly Tone[] = ["neutral", "info", "success", "warning", "danger"];

export interface GroupRow {
  id: string;
  name: string;
  pricingType: PricingType;
  discountBps: number | null;
  markupBps: number | null;
  stacksWithSalePrice: boolean;
  earnsLoyaltyPoints: boolean;
  tone: Tone;
  isSystem: boolean;
  isActive: boolean;
  memberCount: number;
  orderCount: number;
}

function errorText(result: ProductActionFailure): string {
  return result.message ?? m.errors[result.code] ?? m.errors.generic ?? "";
}

function percentText(row: GroupRow): string {
  if (row.pricingType === "discount" && row.discountBps !== null) {
    return m.percent.discount(bpsToPercentText(row.discountBps));
  }
  if (row.pricingType === "cost_plus" && row.markupBps !== null) {
    return m.percent.cost_plus(bpsToPercentText(row.markupBps));
  }
  return m.percent.none;
}

/** Lista grupurilor de clienți, cu creare, editare și ștergere. Scrierea cere `customers.groups.manage` (verificat pe server). */
export function GroupManager({ rows, canWrite }: { rows: readonly GroupRow[]; canWrite: boolean }) {
  const router = useRouter();
  const [target, setTarget] = useState<GroupRow | "new" | null>(null);
  const [removing, setRemoving] = useState<GroupRow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pending, startTransition] = useTransition();

  const remove = (row: GroupRow) => {
    startTransition(async () => {
      try {
        const result = await deleteCustomerGroup({ id: row.id });
        setRemoving(null);
        if (result.ok) {
          setProblem(null);
          setAnnouncement(m.live.removed(row.name));
          router.refresh();
        } else {
          setProblem(errorText(result));
        }
      } catch {
        setRemoving(null);
        setProblem(m.errors.generic ?? "");
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <p role="note" className="rounded-lg bg-surface-subtle p-3 text-body">
        {m.systemNote}
      </p>
      {canWrite && (
        <div className="flex justify-end">
          <Button onClick={() => setTarget("new")} data-create-group>
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
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {rows.length === 0 ? (
        <EmptyState title={m.empty} />
      ) : (
        <Table stacked aria-label={m.listLabel}>
          <THead>
            <Tr>
              <Th>{m.columns.name}</Th>
              <Th priority="secondary">{m.columns.type}</Th>
              <Th>{m.columns.percent}</Th>
              <Th priority="secondary" numeric>
                {m.columns.members}
              </Th>
              <Th priority="tertiary" numeric>
                {m.columns.orders}
              </Th>
              <Th priority="tertiary">{m.columns.loyalty}</Th>
              <Th>{m.columns.status}</Th>
              {canWrite && <Th numeric>{m.columns.actions}</Th>}
            </Tr>
          </THead>
          <TBody>
            {rows.map((row) => (
              <Tr
                key={row.id}
                data-group-row={row.name}
                data-active={row.isActive ? "true" : "false"}
              >
                <RowHeader className="font-medium">
                  <Badge variant={row.tone}>{row.name}</Badge>
                </RowHeader>
                <Td priority="secondary" className="text-ink-secondary">
                  {m.types[row.pricingType]}
                </Td>
                <Td className="whitespace-nowrap" data-cell="percent">
                  {percentText(row)}
                </Td>
                <Td priority="secondary" numeric data-cell="members">
                  {m.membersValue(row.memberCount)}
                </Td>
                <Td priority="tertiary" numeric>
                  {row.orderCount}
                </Td>
                <Td priority="tertiary" className="whitespace-nowrap">
                  {row.earnsLoyaltyPoints ? m.loyalty.yes : m.loyalty.no}
                </Td>
                <Td data-cell="status">
                  <span className="inline-flex flex-wrap gap-1">
                    <Badge variant={row.isActive ? "success" : "neutral"} dot>
                      {row.isActive ? m.status.active : m.status.inactive}
                    </Badge>
                    {row.isSystem && <Badge variant="info">{m.status.system}</Badge>}
                  </span>
                </Td>
                {canWrite && (
                  <Td stack="corner" data-cell="actions">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={m.actions.edit(row.name)}
                        title={m.actions.editLabel}
                        onClick={() => setTarget(row)}
                      >
                        <Pencil aria-hidden="true" className="size-4" />
                      </Button>
                      {!row.isSystem && (
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={pending}
                          aria-label={m.actions.remove(row.name)}
                          title={m.actions.removeLabel}
                          onClick={() => setRemoving(row)}
                        >
                          <Trash2 aria-hidden="true" className="size-4" />
                        </Button>
                      )}
                    </div>
                  </Td>
                )}
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      <GroupFormDialog
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

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing ? m.remove.title(removing.name) : ""}
        closeLabel={m.form.close}
        className="max-w-lg"
      >
        <div className="flex flex-col gap-4">
          <p className="text-body">{m.remove.body}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRemoving(null)}>
              {m.remove.cancel}
            </Button>
            <Button
              disabled={pending}
              onClick={() => removing && remove(removing)}
              data-confirm-remove
            >
              {m.remove.confirm}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function GroupFormDialog({
  target,
  onClose,
  onSaved,
}: {
  target: GroupRow | "new" | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const editing = target !== null && target !== "new" ? target : null;
  const isNew = target === "new";
  const [name, setName] = useState(editing?.name ?? "");
  const [pricingType, setPricingType] = useState<PricingType>(editing?.pricingType ?? "discount");
  const [discount, setDiscount] = useState(
    editing?.discountBps != null ? bpsToPercentText(editing.discountBps) : "",
  );
  const [markup, setMarkup] = useState(
    editing?.markupBps != null ? bpsToPercentText(editing.markupBps) : "",
  );
  const [stacks, setStacks] = useState(editing?.stacksWithSalePrice ?? false);
  const [loyalty, setLoyalty] = useState(editing?.earnsLoyaltyPoints ?? true);
  const [tone, setTone] = useState<Tone>(editing?.tone ?? "neutral");
  const [active, setActive] = useState(editing?.isActive ?? true);
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

  const locked = editing?.isSystem === true;
  const percentError = (problemKind: "required" | "invalid" | "too_big"): string =>
    problemKind === "required"
      ? (m.errors.percentRequired ?? "")
      : problemKind === "too_big"
        ? (m.errors.percentTooBig ?? "")
        : (m.errors.percentInvalid ?? "");

  const submit = () => {
    const found: Record<string, string> = {};
    let discountBps: number | null = null;
    let markupBps: number | null = null;
    if (name.trim() === "") found["name"] = m.errors.nameRequired ?? "";
    if (pricingType === "discount") {
      const parsed = parsePercentToBps(discount, MAX_DISCOUNT_PERCENT);
      if (parsed.ok) discountBps = parsed.bps;
      else found["discount"] = percentError(parsed.problem);
    }
    if (pricingType === "cost_plus") {
      const parsed = parsePercentToBps(markup, MAX_MARKUP_PERCENT);
      if (parsed.ok) markupBps = parsed.bps;
      else found["markup"] = percentError(parsed.problem);
    }
    setErrors(found);
    setProblem(null);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(`group-${first}`)?.focus();
      return;
    }
    const fields = {
      name: name.trim(),
      pricingType,
      discountBps,
      markupBps,
      stacksWithSalePrice: pricingType === "discount" ? stacks : false,
      earnsLoyaltyPoints: loyalty,
      tone,
      isActive: active,
    };
    startTransition(async () => {
      try {
        const result = isNew
          ? await createCustomerGroup(fields)
          : await updateCustomerGroup({ id: editing?.id ?? "", ...fields });
        if (result.ok) onSaved(isNew ? m.live.created(fields.name) : m.live.updated(fields.name));
        else setProblem(errorText(result));
      } catch {
        setProblem(m.errors.generic ?? "");
      }
    });
  };

  const percentField = (
    id: "discount" | "markup",
    label: string,
    help: string,
    value: string,
    setValue: (text: string) => void,
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`group-${id}`}>{label}</Label>
      <Input
        id={`group-${id}`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        inputMode="decimal"
        autoComplete="off"
        maxLength={8}
        {...(errors[id] && { "aria-invalid": true as const })}
        aria-describedby={`group-${id}-help${errors[id] ? ` group-${id}-error` : ""}`}
      />
      <p id={`group-${id}-help`} className="text-label text-ink-secondary">
        {help}
      </p>
      {errors[id] && (
        <p id={`group-${id}-error`} className="text-label text-tone-problem-fg">
          {errors[id]}
        </p>
      )}
    </div>
  );

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
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="group-name">{m.form.name}</Label>
          <Input
            id="group-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            autoComplete="off"
            {...(errors["name"] && { "aria-invalid": true as const })}
            {...(errors["name"] && { "aria-describedby": "group-name-error" })}
          />
          {errors["name"] && (
            <p id="group-name-error" className="text-label text-tone-problem-fg">
              {errors["name"]}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="group-type">{m.form.type}</Label>
          <Select
            id="group-type"
            value={pricingType}
            disabled={locked}
            onChange={(event) => setPricingType(event.target.value as PricingType)}
          >
            {(["none", "discount", "cost_plus"] as const).map((type) => (
              <option key={type} value={type}>
                {m.types[type]}
              </option>
            ))}
          </Select>
          {locked && <p className="text-label text-ink-secondary">{m.form.systemLocked}</p>}
        </div>
        {pricingType === "discount" &&
          percentField("discount", m.form.discount, m.form.discountHelp, discount, setDiscount)}
        {pricingType === "cost_plus" &&
          percentField("markup", m.form.markup, m.form.markupHelp, markup, setMarkup)}
        {pricingType === "discount" && (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={stacks}
              onChange={(event) => setStacks(event.target.checked)}
              aria-describedby="group-stacks-help"
              data-group-stacks
            />
            <span className="flex flex-col">
              <span>{m.form.stacks}</span>
              <span id="group-stacks-help" className="text-label text-ink-secondary">
                {m.form.stacksHelp}
              </span>
            </span>
          </label>
        )}
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={loyalty}
            onChange={(event) => setLoyalty(event.target.checked)}
            aria-describedby="group-loyalty-help"
          />
          <span className="flex flex-col">
            <span>{m.form.loyalty}</span>
            <span id="group-loyalty-help" className="text-label text-ink-secondary">
              {m.form.loyaltyHelp}
            </span>
          </span>
        </label>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="group-tone">{m.form.tone}</Label>
          <Select
            id="group-tone"
            value={tone}
            onChange={(event) => setTone(event.target.value as Tone)}
          >
            {TONES.map((value) => (
              <option key={value} value={value}>
                {m.form.tones[value]}
              </option>
            ))}
          </Select>
        </div>
        {editing && !locked && (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 size-4"
              checked={active}
              onChange={(event) => setActive(event.target.checked)}
              aria-describedby="group-active-help"
            />
            <span className="flex flex-col">
              <span>{m.form.active}</span>
              <span id="group-active-help" className="text-label text-ink-secondary">
                {m.form.activeHelp}
              </span>
            </span>
          </label>
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
            {m.form.cancel}
          </Button>
          <Button type="submit" disabled={pending} data-save-group>
            {pending ? m.form.saving : m.form.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
