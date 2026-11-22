"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Button, Input, Label, Section, Textarea } from "@ecom/ui";
import { savePalletSettings } from "@/app/(admin)/admin/setari/paleti/actions";
import { parseMoneyInput } from "@/lib/money-input";
import { parseScaledInput } from "@/lib/scaled-input";
import { getMessages } from "@/messages";

const m = getMessages().admin.shipping.pallet;

export interface PalletSettingsValues {
  price: string;
  threshold: string;
  maxWeightKg: string;
  maxVolumeM3: string;
  manualCarriers: string;
}

export function PalletSettingsForm({
  initial,
  canSave,
  currency,
}: {
  initial: PalletSettingsValues;
  canSave: boolean;
  currency: string;
}) {
  const router = useRouter();
  const base = useId();
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startSave] = useTransition();

  const set = (patch: Partial<PalletSettingsValues>) => {
    setStatus(null);
    setForm((previous) => ({ ...previous, ...patch }));
  };

  const failWith = (found: Record<string, string>) => {
    setErrors(found);
    setProblem(m.fixErrors);
    const first = Object.keys(found)[0];
    if (first) document.getElementById(`${base}-${first}`)?.focus();
  };

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave || pending) return;
    setProblem(null);
    setStatus(null);
    const found: Record<string, string> = {};
    const price = parseMoneyInput(form.price);
    if (price === null || price < 1) found["price"] = m.invalidMoney;
    if (parseMoneyInput(form.threshold) === null) found["threshold"] = m.invalidThreshold;
    const weight = parseScaledInput(form.maxWeightKg, 3);
    if (weight === null || weight < 1) found["maxWeight"] = m.invalidWeight;
    const volume = parseScaledInput(form.maxVolumeM3, 6);
    if (volume === null || volume < 1) found["maxVolume"] = m.invalidVolume;
    const names = form.manualCarriers
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (names.length > 30 || names.some((name) => name.length > 80)) {
      found["manualCarriers"] = m.invalidCarriers;
    }
    if (Object.keys(found).length > 0) {
      failWith(found);
      return;
    }
    setErrors({});
    startSave(async () => {
      try {
        const result = await savePalletSettings({
          price: form.price,
          threshold: form.threshold,
          maxWeightKg: form.maxWeightKg,
          maxVolumeM3: form.maxVolumeM3,
          manualCarriers: form.manualCarriers,
        });
        if (result.ok) {
          setStatus(m.saved);
          router.refresh();
        } else {
          const messages: Record<string, string> = {
            price: m.invalidMoney,
            threshold: m.invalidThreshold,
            maxWeight: m.invalidWeight,
            maxVolume: m.invalidVolume,
            manualCarriers: m.invalidCarriers,
          };
          const mapped: Record<string, string> = {};
          for (const key of Object.keys(result.errors)) mapped[key] = messages[key] ?? m.saveFailed;
          failWith(mapped);
        }
      } catch {
        setProblem(m.saveFailed);
      }
    });
  };

  const field = (name: string) => ({
    id: `${base}-${name}`,
    "aria-invalid": errors[name] ? (true as const) : undefined,
    "aria-describedby": errors[name] ? `${base}-${name}-error` : `${base}-${name}-help`,
  });
  const errorFor = (name: string) =>
    errors[name] ? (
      <p id={`${base}-${name}-error`} role="alert" className="text-label text-tone-problem-fg">
        {errors[name]}
      </p>
    ) : null;
  const help = (name: string, text: string) => (
    <p id={`${base}-${name}-help`} className="text-label text-ink-secondary">
      {text}
    </p>
  );

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-8" data-pallet-settings>
      <Section id="pallet-price" title={m.title}>
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor={`${base}-price`}>
            {m.price} ({currency})
          </Label>
          <Input
            {...field("price")}
            inputMode="decimal"
            autoComplete="off"
            value={form.price}
            disabled={!canSave}
            onChange={(event) => set({ price: event.target.value })}
          />
          {errorFor("price") ?? help("price", m.priceHelp)}
        </div>
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor={`${base}-threshold`}>
            {m.threshold} ({currency})
          </Label>
          <Input
            {...field("threshold")}
            inputMode="decimal"
            autoComplete="off"
            value={form.threshold}
            disabled={!canSave}
            onChange={(event) => set({ threshold: event.target.value })}
          />
          {errorFor("threshold") ?? help("threshold", m.thresholdHelp)}
        </div>
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor={`${base}-maxWeight`}>{m.maxWeight}</Label>
          <Input
            {...field("maxWeight")}
            inputMode="decimal"
            autoComplete="off"
            value={form.maxWeightKg}
            disabled={!canSave}
            onChange={(event) => set({ maxWeightKg: event.target.value })}
          />
          {errorFor("maxWeight") ?? help("maxWeight", m.maxWeightHelp)}
        </div>
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor={`${base}-maxVolume`}>{m.maxVolume}</Label>
          <Input
            {...field("maxVolume")}
            inputMode="decimal"
            autoComplete="off"
            value={form.maxVolumeM3}
            disabled={!canSave}
            onChange={(event) => set({ maxVolumeM3: event.target.value })}
          />
          {errorFor("maxVolume") ?? help("maxVolume", m.maxVolumeHelp)}
        </div>
      </Section>
      <Section id="manual-carriers" title={m.manualCarriers}>
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor={`${base}-manualCarriers`}>{m.manualCarriers}</Label>
          <Textarea
            {...field("manualCarriers")}
            rows={5}
            value={form.manualCarriers}
            disabled={!canSave}
            onChange={(event) => set({ manualCarriers: event.target.value })}
          />
          {errorFor("manualCarriers") ?? help("manualCarriers", m.manualCarriersHelp)}
        </div>
      </Section>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!canSave || pending}>
          {pending ? m.saving : m.save}
        </Button>
        <span role="status" aria-live="polite" className="text-body text-ink-secondary">
          {status}
        </span>
      </div>
      {problem && (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {problem}
        </p>
      )}
    </form>
  );
}
