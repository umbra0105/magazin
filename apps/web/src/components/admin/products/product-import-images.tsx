"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ImageProgressView } from "@ecom/core";
import { Button, Progress, TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
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
      <Progress
        label={m.progressLabel}
        value={progress.total > 0 ? (done / progress.total) * 100 : 0}
      />
      <p role="status" aria-live="polite" className="text-body">
        {m.progress(done, progress.total)} — {m.states[progress.state]}
      </p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["downloaded", "existing", "failed", "pending"] as const).map((key) => (
          <div
            key={key}
            className="rounded-lg border border-line-subtle p-3"
            data-image-count={key}
          >
            <dt className="text-label text-ink-secondary">{m.counts[key]}</dt>
            <dd className="text-title">{progress[key]}</dd>
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
          className={message.ok ? "text-body" : "text-body text-tone-problem-fg"}
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
      <h3 className="text-body font-semibold">{m.failuresHeading}</h3>
      <Table stacked aria-label={m.failuresHeading}>
        <THead>
          <Tr>
            <Th numeric>{m.row}</Th>
            <Th>{m.sku}</Th>
            <Th>{m.host}</Th>
            <Th>{m.reason}</Th>
          </Tr>
        </THead>
        <TBody>
          {failures.map((failure, index) => (
            <Tr key={`${failure.row}-${failure.host}-${index}`} data-image-failure={failure.row}>
              <Td numeric>{failure.row}</Td>
              <Td className="break-all">{failure.sku || "—"}</Td>
              <Td className="break-all">{failure.host}</Td>
              <Td stack="title">{failure.message}</Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      <p className="text-label text-ink-secondary">{m.hint}</p>
    </div>
  );
}
