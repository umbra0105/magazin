"use client";

import { useState } from "react";
import { UploadPanel } from "@/components/admin/media/upload-panel";
import type { UploadErrorKey, UploadItem, UploadStatus } from "@/lib/media-uploader";

/**
 * Panoul de încărcare cu TOATE stările unei încărcări (în coadă, în curs, în așteptare, terminată și fiecare eroare), pe date fixe,
 * în coloana laterală a bibliotecii (w-64 la desktop). Doar pentru teste (vezi pagina-harness).
 */
const ERRORS: UploadErrorKey[] = [
  "tooLarge",
  "unsupported",
  "rateLimited",
  "busy",
  "storageUnavailable",
  "network",
  "generic",
];

function make(
  id: string,
  name: string,
  status: UploadStatus,
  extra: Partial<UploadItem> = {},
): UploadItem {
  return {
    id,
    file: new File(["x".repeat(2048)], name, { type: "image/png" }),
    status,
    progress: 0,
    errorKey: null,
    errorRetryAfter: null,
    waitingSeconds: null,
    attempts: 0,
    mediaId: null,
    ...extra,
  };
}

export function UploadHarness({ stare }: { stare: string }) {
  const long = stare === "lung";
  const suffix = long ? "-pompa-de-caldura-inverter-cu-agent-frigorific-ecologic-2026" : "";
  const [items, setItems] = useState<UploadItem[]>(() => [
    make("q", `coada${suffix}.png`, "queued"),
    make("u", `in-curs${suffix}.png`, "uploading", { progress: 40 }),
    make("w", `asteapta${suffix}.png`, "waiting", { waitingSeconds: 5 }),
    make("d", `gata${suffix}.png`, "done", { progress: 100, mediaId: "x" }),
    ...ERRORS.map((key, index) =>
      make(`e${index}`, `eroare-${key}${suffix}.png`, "error", {
        errorKey: key,
        errorRetryAfter: key === "rateLimited" ? 30 : null,
      }),
    ),
  ]);
  return (
    <div className="flex max-w-xs flex-col gap-4 lg:w-64">
      <UploadPanel
        primary
        items={items}
        rules="JPEG, PNG, WebP, AVIF. Cel mult 10 MB per fișier."
        accept="image/png"
        onFiles={() => undefined}
        onRetry={() => undefined}
        onRemove={(id) => setItems((current) => current.filter((i) => i.id !== id))}
        onClear={() => setItems((current) => current.filter((i) => i.status !== "done"))}
      />
    </div>
  );
}
