"use client";

import { X } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { Button, Input, Label } from "@ecom/ui";
import {
  addFreeShippingExclusion,
  removeFreeShippingExclusion,
} from "@/app/(admin)/admin/setari/cos/actions";
import { getMessages } from "@/messages";

const m = getMessages().admin.cartSettings;

export interface ExclusionRow {
  productId: string;
  title: string;
  sku: string | null;
}

/**
 * Produsele excluse de la transportul gratuit (pe lângă excluderea pe clasă). Stă în formularul «Coș și transport», dar are
 * acțiuni proprii cu salvare imediată: de aceea nu e un `<form>` imbricat, iar Enter în câmp adaugă produsul, nu salvează
 * setările. Scrierea cere `settings.write`.
 */
export function FreeShippingExclusions({
  initial,
  canWrite,
}: {
  initial: readonly ExclusionRow[];
  canWrite: boolean;
}) {
  const base = useId();
  const [items, setItems] = useState<readonly ExclusionRow[]>(initial);
  const [sku, setSku] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [pending, startTransition] = useTransition();

  const apply = (
    run: () => ReturnType<typeof addFreeShippingExclusion>,
    success: string,
    after?: () => void,
  ) => {
    setProblem(null);
    setStatus("");
    startTransition(async () => {
      try {
        const result = await run();
        if (result.ok) {
          setItems(result.items);
          setStatus(success);
          after?.();
        } else {
          setProblem(result.code === "not_found" ? m.exclusionNotFound : m.exclusionFailed);
          document.getElementById(`${base}-sku`)?.focus();
        }
      } catch {
        setProblem(m.exclusionFailed);
      }
    });
  };

  const add = () => {
    if (!canWrite || pending) return;
    apply(
      () => addFreeShippingExclusion({ sku }),
      m.exclusionAdded,
      () => setSku(""),
    );
  };

  return (
    <div className="flex flex-col gap-3" data-free-shipping-exclusions>
      <h3 className="text-body font-medium">{m.exclusionsTitle}</h3>
      <p className="text-label text-ink-secondary">{m.exclusionsHelp}</p>
      {items.length === 0 ? (
        <p className="text-body text-ink-secondary" data-exclusions-empty>
          {m.exclusionsEmpty}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle">
          {items.map((item) => (
            <li
              key={item.productId}
              data-exclusion={item.productId}
              className="flex min-h-12 items-center justify-between gap-3 px-3 py-2"
            >
              <span className="min-w-0 break-words">
                {item.title}
                {item.sku && (
                  <span className="block text-label text-ink-secondary">{item.sku}</span>
                )}
              </span>
              {canWrite && (
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={pending}
                  aria-label={m.exclusionRemove(item.title)}
                  title={m.exclusionRemove(item.title)}
                  onClick={() =>
                    apply(
                      () => removeFreeShippingExclusion({ productId: item.productId }),
                      m.exclusionRemoved,
                    )
                  }
                >
                  <X aria-hidden="true" className="size-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${base}-sku`}>{m.exclusionSku}</Label>
          <div className="flex gap-2">
            <Input
              id={`${base}-sku`}
              value={sku}
              maxLength={100}
              autoComplete="off"
              onChange={(event) => setSku(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
              {...(problem && {
                "aria-invalid": true as const,
                "aria-describedby": `${base}-problem`,
              })}
              className="max-w-xs"
            />
            <Button
              type="button"
              variant="outline"
              disabled={pending || sku.trim() === ""}
              onClick={add}
            >
              {m.exclusionAdd}
            </Button>
          </div>
          {problem && (
            <p id={`${base}-problem`} role="alert" className="text-label text-tone-problem-fg">
              {problem}
            </p>
          )}
        </div>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
    </div>
  );
}
