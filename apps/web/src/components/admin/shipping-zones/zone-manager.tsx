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
import { removeShippingZone, saveShippingZone } from "@/app/(admin)/admin/setari/livrare/actions";
import { parseMoneyInput } from "@/lib/money-input";
import { getMessages } from "@/messages";

const m = getMessages().admin.shippingZones;

export interface ZoneRow {
  id: string;
  name: string;
  isActive: boolean;
  countyCodes: number[];
  methodName: string;
  carrier: string;
  type: "flat" | "weight";
  price: string;
  includedKg: string;
  perExtraKg: string;
  freeAbove: string;
  codFee: string;
  days: string;
}

interface CountyOption {
  code: number;
  name: string;
}

const EMPTY: Omit<ZoneRow, "id"> = {
  name: "",
  isActive: true,
  countyCodes: [],
  methodName: "",
  carrier: "",
  type: "flat",
  price: "",
  includedKg: "0",
  perExtraKg: "0",
  freeAbove: "",
  codFee: "0",
  days: "",
};

/** Lista zonelor de livrare, cu creare, editare și ștergere (cu confirmare). Scrierea cere `settings.write`. */
export function ZoneManager({
  zones,
  counties,
  currency,
  canWrite,
}: {
  zones: readonly ZoneRow[];
  counties: readonly CountyOption[];
  currency: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [target, setTarget] = useState<ZoneRow | "new" | null>(null);
  const [removing, setRemoving] = useState<ZoneRow | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const confirmRemove = () => {
    const zone = removing;
    if (!zone) return;
    startTransition(async () => {
      try {
        const result = await removeShippingZone({ id: zone.id });
        setRemoving(null);
        if (result.ok) {
          setProblem(null);
          setAnnouncement(m.deleted);
          router.refresh();
        } else setProblem(m.saveFailed);
      } catch {
        setRemoving(null);
        setProblem(m.forbidden);
      }
    });
  };

  const countyName = (code: number) => counties.find((c) => c.code === code)?.name ?? String(code);

  return (
    <div className="flex flex-col gap-4">
      {canWrite && zones.length > 0 && (
        <div className="flex justify-end">
          <Button onClick={() => setTarget("new")}>{m.add}</Button>
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

      {zones.length === 0 ? (
        <EmptyState
          title={m.empty}
          {...(canWrite && { action: <Button onClick={() => setTarget("new")}>{m.add}</Button> })}
        />
      ) : (
        <Table stacked aria-label={m.title}>
          <THead>
            <Tr>
              <Th>{m.columns.name}</Th>
              <Th priority="secondary">{m.columns.counties}</Th>
              <Th>{m.columns.tariff}</Th>
              <Th priority="tertiary">{m.columns.freeAbove}</Th>
              <Th priority="detail">{m.columns.codFee}</Th>
              <Th>{m.columns.status}</Th>
              {canWrite && <Th numeric>{m.columns.actions}</Th>}
            </Tr>
          </THead>
          <TBody>
            {zones.map((zone) => (
              <Tr key={zone.id} data-zone-row={zone.name} data-active={zone.isActive}>
                <RowHeader
                  className={
                    canWrite
                      ? "font-medium group-data-[stacked]/table:@max-2xl/table:pr-24"
                      : "font-medium"
                  }
                >
                  {zone.name}
                  <span className="block text-label font-normal text-ink-secondary">
                    {zone.methodName}
                  </span>
                </RowHeader>
                <Td priority="secondary" data-cell="counties">
                  <span
                    data-cell-text
                    title={zone.countyCodes.map(countyName).join(", ")}
                    className="block max-w-64 truncate"
                  >
                    {m.counties(zone.countyCodes.length)}
                  </span>
                </Td>
                <Td className="whitespace-nowrap tabular-nums" data-cell="tariff">
                  {m.summary(
                    `${zone.price} ${currency}`,
                    zone.days === "" ? null : Number(zone.days),
                  )}
                </Td>
                <Td
                  priority="tertiary"
                  className="whitespace-nowrap tabular-nums"
                  data-cell="freeAbove"
                >
                  {zone.freeAbove === "" ? m.none : `${zone.freeAbove} ${currency}`}
                </Td>
                <Td priority="detail" className="whitespace-nowrap tabular-nums" data-cell="codFee">
                  {zone.codFee} {currency}
                </Td>
                <Td data-cell="status">
                  <Badge variant={zone.isActive ? "success" : "neutral"} dot data-status-pill>
                    {zone.isActive ? m.activeBadge : m.inactive}
                  </Badge>
                </Td>
                {canWrite && (
                  <Td stack="corner" data-cell="actions">
                    <div className="flex justify-end gap-1 group-data-[stacked]/table:@max-2xl/table:justify-start">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${m.edit}: ${zone.name}`}
                        title={m.edit}
                        onClick={() => setTarget(zone)}
                      >
                        <Pencil aria-hidden="true" className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${m.remove}: ${zone.name}`}
                        title={m.remove}
                        onClick={() => setRemoving(zone)}
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                      </Button>
                    </div>
                  </Td>
                )}
              </Tr>
            ))}
          </TBody>
        </Table>
      )}

      <ZoneFormDialog
        key={target === null ? "closed" : target === "new" ? "new" : target.id}
        target={target}
        counties={counties}
        currency={currency}
        onClose={() => setTarget(null)}
        onSaved={() => {
          setTarget(null);
          setProblem(null);
          setAnnouncement(m.saved);
          router.refresh();
        }}
      />

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing ? m.removeTitle(removing.name) : ""}
        description={m.removeBody}
        closeLabel={m.close}
        className="max-w-md"
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setRemoving(null)}>
            {m.cancel}
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={confirmRemove}>
            {m.removeConfirm}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function ZoneFormDialog({
  target,
  counties,
  currency,
  onClose,
  onSaved,
}: {
  target: ZoneRow | "new" | null;
  counties: readonly CountyOption[];
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = target !== null && target !== "new" ? target : null;
  const [form, setForm] = useState<Omit<ZoneRow, "id">>(() => {
    if (!editing) return EMPTY;
    return {
      name: editing.name,
      isActive: editing.isActive,
      countyCodes: editing.countyCodes,
      methodName: editing.methodName,
      carrier: editing.carrier,
      type: editing.type,
      price: editing.price,
      includedKg: editing.includedKg,
      perExtraKg: editing.perExtraKg,
      freeAbove: editing.freeAbove,
      codFee: editing.codFee,
      days: editing.days,
    };
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (target === null) {
    return (
      <Dialog open={false} onClose={onClose} title="" closeLabel={m.close}>
        {null}
      </Dialog>
    );
  }

  const set = (patch: Partial<Omit<ZoneRow, "id">>) => setForm((prev) => ({ ...prev, ...patch }));
  const money = (text: string) => text.trim() === "" || parseMoneyInput(text) !== null;

  const validate = (): Record<string, string> => {
    const found: Record<string, string> = {};
    if (form.name.trim().length < 2) found["name"] = m.nameRequired;
    if (form.methodName.trim().length < 2) found["methodName"] = m.methodRequired;
    if (form.countyCodes.length === 0) found["counties"] = m.countiesRequired;
    if (parseMoneyInput(form.price) === null) found["price"] = m.invalidMoney;
    if (!money(form.codFee)) found["codFee"] = m.invalidMoney;
    if (form.freeAbove.trim() !== "" && (parseMoneyInput(form.freeAbove) ?? 0) < 1)
      found["freeAbove"] = m.invalidMoney;
    if (form.type === "weight") {
      if (!/^\d+([.,]\d{1,3})?$/.test(form.includedKg.trim()) && form.includedKg.trim() !== "")
        found["includedKg"] = m.invalidNumber;
      if (!money(form.perExtraKg)) found["perExtraKg"] = m.invalidMoney;
    }
    if (form.days.trim() !== "" && !/^\d{1,3}$/.test(form.days.trim()))
      found["days"] = m.invalidNumber;
    return found;
  };

  const submit = () => {
    const found = validate();
    setErrors(found);
    setProblem(null);
    const first = Object.keys(found)[0];
    if (first) {
      setProblem(m.fixErrors);
      document.getElementById(`zone-${first}`)?.focus();
      return;
    }
    startTransition(async () => {
      try {
        const result = await saveShippingZone({
          ...(editing && { id: editing.id }),
          ...form,
          name: form.name.trim(),
          methodName: form.methodName.trim(),
        });
        if (result.ok) {
          onSaved();
          return;
        }
        const messages: Record<string, string> = {
          name: m.nameRequired,
          methodName: m.methodRequired,
          counties: m.countiesRequired,
          money: m.invalidMoney,
          number: m.invalidNumber,
          overlap: m.overlap(result.overlapZone ?? ""),
        };
        const mapped: Record<string, string> = {};
        for (const [key, code] of Object.entries(result.errors))
          mapped[key] = messages[code] ?? m.saveFailed;
        setErrors(mapped);
        setProblem(m.fixErrors);
        const firstServer = Object.keys(mapped)[0];
        if (firstServer) document.getElementById(`zone-${firstServer}`)?.focus();
      } catch {
        setProblem(m.forbidden);
      }
    });
  };

  const errorFor = (name: string) =>
    errors[name] ? (
      <p id={`zone-${name}-error`} role="alert" className="text-label text-tone-problem-fg">
        {errors[name]}
      </p>
    ) : null;
  const describe = (name: string) => (errors[name] ? `zone-${name}-error` : undefined);

  const text = (
    name: "name" | "methodName" | "carrier" | "days",
    label: string,
    extra?: { inputMode?: "numeric"; max?: number; className?: string },
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`zone-${name}`}>{label}</Label>
      <Input
        id={`zone-${name}`}
        value={form[name]}
        onChange={(event) => set({ [name]: event.target.value })}
        autoComplete="off"
        maxLength={extra?.max ?? 100}
        {...(extra?.inputMode && { inputMode: extra.inputMode })}
        {...(errors[name] && { "aria-invalid": true as const })}
        {...(describe(name) && { "aria-describedby": describe(name) })}
        className={extra?.className}
      />
      {errorFor(name)}
    </div>
  );
  const amount = (
    name: "price" | "perExtraKg" | "freeAbove" | "codFee" | "includedKg",
    label: string,
    unit: string,
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`zone-${name}`}>
        {label} ({unit})
      </Label>
      <Input
        id={`zone-${name}`}
        value={form[name]}
        onChange={(event) => set({ [name]: event.target.value })}
        inputMode="decimal"
        autoComplete="off"
        {...(errors[name] && { "aria-invalid": true as const })}
        {...(describe(name) && { "aria-describedby": describe(name) })}
      />
      {errorFor(name)}
    </div>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? m.formTitleEdit(editing.name) : m.formTitleNew}
      closeLabel={m.close}
      className="max-w-3xl"
    >
      <form
        noValidate
        data-zone-form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {text("name", m.name)}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(event) => set({ isActive: event.target.checked })}
            className="size-4"
          />
          <span>{m.active}</span>
        </label>

        <fieldset className="flex flex-col gap-2" data-zone-counties>
          <legend className="text-label font-medium">{m.countiesTitle}</legend>
          <p className="text-label text-ink-secondary">{m.countiesHelp}</p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => set({ countyCodes: counties.map((c) => c.code) })}
            >
              {m.selectAll}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => set({ countyCodes: [] })}
            >
              {m.selectNone}
            </Button>
            <span className="text-label text-ink-secondary" role="status">
              {m.counties(form.countyCodes.length)}
            </span>
          </div>
          <div
            id="zone-counties"
            tabIndex={-1}
            className="grid max-h-56 grid-cols-1 gap-x-4 gap-y-1 overflow-y-auto rounded-md border border-line-subtle p-3 sm:grid-cols-2 md:grid-cols-3"
            {...(errors["counties"] && { "aria-invalid": true as const })}
            {...(describe("counties") && { "aria-describedby": describe("counties") })}
          >
            {counties.map((county) => (
              <label key={county.code} className="flex min-h-8 items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.countyCodes.includes(county.code)}
                  onChange={(event) =>
                    set({
                      countyCodes: event.target.checked
                        ? [...form.countyCodes, county.code]
                        : form.countyCodes.filter((code) => code !== county.code),
                    })
                  }
                  className="size-4"
                />
                <span>{county.name}</span>
              </label>
            ))}
          </div>
          {errorFor("counties")}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          {text("methodName", m.methodName)}
          {text("carrier", m.carrier)}
        </div>
        <div className="flex flex-col gap-1.5 sm:max-w-sm">
          <Label htmlFor="zone-type">{m.type}</Label>
          <Select
            id="zone-type"
            value={form.type}
            onChange={(event) => set({ type: event.target.value === "weight" ? "weight" : "flat" })}
          >
            <option value="flat">{m.typeFlat}</option>
            <option value="weight">{m.typeWeight}</option>
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {amount("price", m.price, currency)}
          {form.type === "weight" && amount("includedKg", m.includedKg, "kg")}
          {form.type === "weight" && amount("perExtraKg", m.perExtraKg, currency)}
          {amount("freeAbove", m.freeAbove, currency)}
          {amount("codFee", m.codFee, currency)}
          {text("days", m.days, { inputMode: "numeric", max: 3, className: "max-w-32" })}
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
            {m.cancelEdit}
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? m.saving : m.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
