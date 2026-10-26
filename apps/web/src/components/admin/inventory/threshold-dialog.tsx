"use client";

import { Gauge } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Dialog, Input, Label } from "@ecom/ui";
import { setLowStockThreshold } from "@/app/(admin)/admin/produse/stoc/actions";
import type { ProductActionFailure } from "@/lib/product-action-support";
import { validateThreshold } from "@/lib/stock-form";
import { stepsText } from "@/lib/stock-view";
import { getMessages } from "@/messages";

const m = getMessages().admin.inventory;

export interface ThresholdTarget {
  variantId: string;
  warehouseId: string;
  /** Produs și variantă, pentru titlu și pentru cititoarele de ecran */
  name: string;
  /** Pragul propriu de acum (în pași); `null` = folosește setarea globală */
  ownSteps: number | null;
  /** Pragul efectiv de acum, deja formatat («2 pași») */
  effectiveText: string;
  /** De unde vine: «propriu» sau «setarea globală» */
  originLabel: string;
  /** Setarea globală, deja formatată («2 pași») */
  globalText: string;
}

function errorText(result: ProductActionFailure): string {
  const errors = m.threshold.errors as unknown as Record<string, string | undefined>;
  return errors[result.code] ?? result.message ?? m.threshold.errors.generic;
}

/** Butonul «Prag» al unei variante gestionate și dialogul lui. Apare doar cu `inventory.write`. */
export function SetThresholdButton({ target, max }: { target: ThresholdTarget; max: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-label={m.threshold.aria(target.name)}
        onClick={() => setOpen(true)}
      >
        <Gauge aria-hidden="true" className="h-4 w-4" />
        <span className="ml-1 hidden sm:inline">{m.threshold.button}</span>
      </Button>
      {open && <ThresholdForm target={target} max={max} onClose={() => setOpen(false)} />}
    </>
  );
}

function ThresholdForm({
  target,
  max,
  onClose,
}: {
  target: ThresholdTarget;
  max: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [value, setValue] = useState(target.ownSteps === null ? "" : String(target.ownSteps));
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const text = m.threshold;

  // lista se reîmprospătează la ÎNCHIDERE, nu imediat după salvare: în vederea «Stoc mic» rândul poate ieși din listă (sau se
  // poate muta), iar dialogul, fiind copilul rândului, ar dispărea înainte să se vadă confirmarea
  const close = () => {
    onClose();
    if (saved) router.refresh();
  };

  const submit = () => {
    setProblem(null);
    const parsed = validateThreshold(value, max);
    if (!parsed.ok) {
      setError(parsed.error === "range" ? text.errors.range(max) : text.errors[parsed.error]);
      document.getElementById("threshold-value")?.focus();
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const result = await setLowStockThreshold({
          variantId: target.variantId,
          warehouseId: target.warehouseId,
          steps: parsed.steps,
        });
        if (result.ok) {
          setSaved(
            result.before === result.after
              ? text.unchanged
              : result.after === null
                ? text.savedGlobal(target.name, target.globalText)
                : text.saved(target.name, stepsText(BigInt(result.after))),
          );
        } else {
          setProblem(errorText(result));
        }
      } catch {
        setProblem(text.errors.generic);
      }
    });
  };

  return (
    <Dialog
      open
      onClose={close}
      title={text.title(target.name)}
      closeLabel={text.close}
      className="max-w-md"
    >
      {saved ? (
        <div className="flex flex-col gap-4">
          <p
            role="status"
            data-saved
            className="rounded-md border border-success/50 bg-success/10 p-3 text-sm"
          >
            {saved}
          </p>
          <div className="flex justify-end">
            <Button type="button" onClick={close}>
              {text.close}
            </Button>
          </div>
        </div>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <p className="text-sm text-muted-foreground">
            {text.current(target.effectiveText, target.originLabel)}
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="threshold-value">{text.label}</Label>
            <Input
              id="threshold-value"
              inputMode="numeric"
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              {...(error && { "aria-invalid": true as const })}
              aria-describedby={`threshold-help${error ? " threshold-error" : ""}`}
            />
            <p id="threshold-help" className="text-xs text-muted-foreground">
              {text.help(target.globalText)}
            </p>
            {error && (
              <p id="threshold-error" className="text-xs text-danger">
                {error}
              </p>
            )}
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
            <Button type="button" variant="outline" onClick={close}>
              {text.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? text.saving : text.save}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
