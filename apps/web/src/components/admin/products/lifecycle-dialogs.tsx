"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Dialog, Input, Label } from "@ecom/ui";
import {
  archiveProducts,
  deleteProducts,
  describeProductPurge,
  purgeProduct,
  restoreProducts,
  unarchiveProducts,
} from "@/app/(admin)/admin/produse/lifecycle-actions";
import { getMessages } from "@/messages";

const m = getMessages().admin.products;
const l = m.lifecycle;

export type LifecycleOperation = "archive" | "unarchive" | "delete" | "restore";

const ACTIONS = {
  archive: archiveProducts,
  unarchive: unarchiveProducts,
  delete: deleteProducts,
  restore: restoreProducts,
} as const;

export function lifecycleErrorText(result: { code: string; message?: string }): string {
  return (m.errors as Record<string, string>)[result.code] ?? result.message ?? m.errors.generic;
}

/**
 * Confirmarea explicită pentru arhivare, dezarhivare, coș de gunoi și restaurare, pe o selecție
 * (cel mult 50, tot sau nimic). Trimite id-urile și numărul exact; serverul le re-verifică.
 */
export function LifecycleConfirmDialog({
  operation,
  products,
  open,
  onClose,
  onDone,
}: {
  operation: LifecycleOperation;
  products: readonly { id: string; title: string }[];
  open: boolean;
  onClose: () => void;
  onDone: (count: number) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (open) setProblem(null);
  }, [open]);

  const apply = () => {
    const ids = products.map((p) => p.id);
    startTransition(async () => {
      try {
        const result = await ACTIONS[operation]({ ids, confirm: true, expectedCount: ids.length });
        if (result.ok) {
          onDone(result.count);
        } else {
          setProblem(lifecycleErrorText(result));
        }
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={l.confirm.title(l.actions[operation], products.length)}
      description={l.confirm.allOrNothing}
      closeLabel={l.confirm.close}
      className="max-w-md"
    >
      <p className="rounded-md border border-border p-3 text-sm" data-lifecycle-summary>
        {l.confirm[operation]}
      </p>
      <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-sm">
        {products.slice(0, 10).map((p) => (
          <li key={p.id}>{p.title}</li>
        ))}
        {products.length > 10 && <li>… +{products.length - 10}</li>}
      </ul>
      {problem && (
        <p role="alert" data-problem className="text-sm text-danger">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {l.confirm.cancel}
        </Button>
        <Button onClick={apply} disabled={pending} data-lifecycle-confirm>
          {pending ? l.confirm.applying : l.confirm.apply}
        </Button>
      </div>
    </Dialog>
  );
}

type Impact = Extract<Awaited<ReturnType<typeof describeProductPurge>>, { ok: true }>["impact"];

/**
 * Ștergerea definitivă: arată ce se șterge odată cu produsul, ce rămâne (fișe, hotspot-uri „fără
 * produs”) și ce o blochează, apoi cere adresa produsului tastată. Serverul le re-verifică pe toate.
 */
export function PurgeDialog({
  product,
  onClose,
  onDone,
}: {
  product: { id: string; title: string } | null;
  onClose: () => void;
  onDone: (title: string) => void;
}) {
  const [impact, setImpact] = useState<Impact | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [pending, startTransition] = useTransition();
  const id = product?.id ?? null;

  useEffect(() => {
    setImpact(null);
    setProblem(null);
    setTyped("");
    if (!id) return;
    let cancelled = false;
    void describeProductPurge({ id })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setImpact(result.impact);
        else setProblem(lifecycleErrorText(result));
      })
      .catch(() => {
        if (!cancelled) setProblem(m.errors.generic);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const submit = () => {
    if (!product || !impact) return;
    startTransition(async () => {
      try {
        const result = await purgeProduct({ id: product.id, confirm: true, confirmSlug: typed });
        if (result.ok) onDone(product.title);
        else setProblem(lifecycleErrorText(result));
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  const lines = impact
    ? ([
        [impact.counts.variants, l.purge.line.variants],
        [impact.counts.media, l.purge.line.media],
        [impact.counts.documents, l.purge.line.documents],
        [impact.counts.attributes, l.purge.line.attributes],
        [impact.counts.categories, l.purge.line.categories],
        [impact.counts.relations, l.purge.line.relations],
        [impact.counts.relatedBy, l.purge.line.relatedBy],
        [impact.counts.collections, l.purge.line.collections],
        [impact.counts.channelListings, l.purge.line.channelListings],
      ] as const)
    : [];
  const blocked = impact !== null && impact.blockingListings > 0;
  const matches = impact !== null && typed.trim().toLowerCase() === impact.slug.toLowerCase();

  return (
    <Dialog
      open={product !== null}
      onClose={onClose}
      title={l.purge.title(product?.title ?? "")}
      description={l.purge.description}
      closeLabel={l.purge.close}
      className="max-w-lg"
    >
      {!impact && !problem && <p className="text-sm text-muted-foreground">{l.purge.loading}</p>}
      {impact && (
        <div className="flex flex-col gap-3 text-sm" data-purge-impact>
          <div>
            <p className="font-medium">{l.purge.willDelete}</p>
            <ul className="list-disc pl-5">
              {lines
                .filter(([count]) => count > 0)
                .map(([count, text]) => (
                  <li key={text(count)}>{text(count)}</li>
                ))}
            </ul>
          </div>
          {impact.diagrams.length > 0 && (
            <div data-purge-diagrams>
              <p className="font-medium">{l.purge.diagrams}</p>
              <ul className="list-disc pl-5">
                {impact.diagrams.map((d) => (
                  <li key={d.id}>{d.title}</li>
                ))}
              </ul>
            </div>
          )}
          {impact.hotspots.length > 0 && (
            <div data-purge-hotspots>
              <p className="font-medium">{l.purge.hotspots}</p>
              <ul className="list-disc pl-5">
                {impact.hotspots.map((h) => (
                  <li key={`${h.diagramId}-${h.number}`}>
                    {l.purge.hotspotLine(h.diagramTitle, h.number)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {blocked ? (
            <p role="alert" data-problem className="text-danger">
              {l.purge.blocked(impact.blockingListings)}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              <Label htmlFor="purge-confirm">{l.purge.confirmLabel(impact.slug)}</Label>
              <Input
                id="purge-confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="purge-confirm-help"
              />
              <p id="purge-confirm-help" className="text-xs text-muted-foreground">
                {l.purge.confirmHelp}
              </p>
            </div>
          )}
        </div>
      )}
      {problem && (
        <p role="alert" data-problem className="text-sm text-danger">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {l.purge.cancel}
        </Button>
        <Button
          onClick={submit}
          disabled={pending || !impact || blocked || !matches}
          data-purge-confirm
        >
          {pending ? l.purge.submitting : l.purge.submit}
        </Button>
      </div>
    </Dialog>
  );
}
