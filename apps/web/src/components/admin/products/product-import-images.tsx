"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ImageProgressView } from "@ecom/core";
import { Button } from "@ecom/ui";
import { retryProductImportImages } from "@/app/(admin)/admin/produse/import/actions";
import { getMessages } from "@/messages";

const m = getMessages().admin.productImport.images;
const errors = getMessages().admin.productImport.errors as Record<string, string>;

/**
 * Progresul descărcării imaginilor unui import: bară, contoare și starea (în curs / întrerupt / terminat).
 * Imaginile se aduc în fundal, după ce produsele sunt create; produsele nu așteaptă după ele.
 */
export function ImageProgress({ progress }: { progress: ImageProgressView }) {
  const done = progress.downloaded + progress.existing + progress.failed;
  return (
    <div className="flex flex-col gap-2" data-image-progress data-image-state={progress.state}>
      <progress
        aria-label={m.progressLabel}
        className="h-3 w-full"
        max={progress.total}
        value={done}
      />
      <p role="status" aria-live="polite" className="text-sm">
        {m.progress(done, progress.total)} — {m.states[progress.state]}
      </p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["downloaded", "existing", "failed", "pending"] as const).map((key) => (
          <div key={key} className="rounded-md border border-border p-3" data-image-count={key}>
            <dt className="text-xs text-muted-foreground">{m.counts[key]}</dt>
            <dd className="text-xl font-semibold">{progress[key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** «Reia imaginile»: imaginile rămase în așteptare și cele eșuate se încearcă din nou (doar cine a pornit importul). */
export function RetryImagesButton({ importId, onDone }: { importId: string; onDone?: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const retry = () => {
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await retryProductImportImages({ importId });
        if (result.ok) {
          setMessage({ ok: true, text: m.retried });
          onDone?.();
          router.refresh();
        } else {
          setMessage({
            ok: false,
            text: errors[result.code] ?? result.message ?? errors["generic"] ?? "",
          });
        }
      } catch {
        setMessage({ ok: false, text: errors["generic"] ?? "" });
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button variant="outline" onClick={retry} disabled={pending} data-image-retry>
          {pending ? m.retrying : m.retry}
        </Button>
      </div>
      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          className={message.ok ? "text-sm" : "text-sm text-danger"}
          data-image-retry-message
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

/** Imaginile eșuate ale unui import, cu motivul (fără adrese complete, IP-uri sau detalii tehnice). */
export function ImageFailures({
  failures,
}: {
  failures: readonly { row: number; sku: string; host: string; message: string }[];
}) {
  if (failures.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-image-failures>
      <h3 className="text-sm font-semibold">{m.failuresHeading}</h3>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead className="border-b border-border bg-border/30">
            <tr>
              {[m.row, m.sku, m.host, m.reason].map((label) => (
                <th key={label} scope="col" className="p-2 font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {failures.map((failure, index) => (
              <tr
                key={`${failure.row}-${failure.host}-${index}`}
                data-image-failure={failure.row}
                className="border-b border-border last:border-0"
              >
                <td className="p-2">{failure.row}</td>
                <td className="p-2 break-all">{failure.sku || "—"}</td>
                <td className="p-2 break-all">{failure.host}</td>
                <td className="p-2">{failure.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{m.hint}</p>
    </div>
  );
}
