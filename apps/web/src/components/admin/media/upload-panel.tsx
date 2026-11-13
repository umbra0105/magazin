"use client";

import { Upload, X } from "lucide-react";
import { useId, useState } from "react";
import { Button, FileInput, Progress, cn } from "@ecom/ui";
import { getMessages } from "@/messages";
import type { UploadErrorKey, UploadItem } from "@/lib/media-uploader";
import { formatBytes } from "./media-types";

const m = getMessages().admin.media;

function errorText(key: UploadErrorKey, retryAfter: number | null): string {
  if (key === "rateLimited") return m.upload.errors.rateLimited(retryAfter);
  return m.upload.errors[key];
}

/**
 * Zona de încărcare (drag & drop sau selector de fișiere) și lista încărcărilor curente, cu progres
 * pe fiecare fișier. Încărcarea propriu-zisă o face `UploadQueue` (max. 2 simultan). Erorile și «Încărcat» sunt în
 * tonurile Problemă / Succes (și scrise cu litere, nu doar colorate); «Reîncearcă» e secundar, iar «Scoate din listă»
 * e un buton doar cu pictogramă (terț), cu nume accesibil și tooltip.
 */
export function UploadPanel({
  items,
  rules,
  accept,
  onFiles,
  onRetry,
  onRemove,
  onClear,
}: {
  items: readonly UploadItem[];
  rules: string;
  accept: string;
  onFiles: (files: File[]) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);
  const done = items.filter((i) => i.status === "done").length;

  return (
    <section aria-labelledby={`${inputId}-title`} className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const files = [...e.dataTransfer.files];
          if (files.length > 0) onFiles(files);
        }}
        className={cn(
          "flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-line-control p-4 text-center",
          dragging && "border-brand bg-surface-subtle",
        )}
      >
        <Upload aria-hidden="true" className="size-6 text-ink-secondary" />
        <h2 id={`${inputId}-title`} className="text-body font-medium">
          {m.upload.dropHere}
        </h2>
        <p className="text-label text-ink-secondary">{m.upload.or} </p>
        <FileInput
          id={inputId}
          multiple
          accept={accept}
          buttonLabel={m.upload.choose}
          hideStatus
          clearAfterChange
          onFilesChange={(files) => {
            if (files.length > 0) onFiles(files);
          }}
        />
        <p className="text-label text-ink-secondary">{rules}</p>
      </div>

      {items.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <p role="status" aria-live="polite" className="text-body">
              {m.upload.summary(done, items.length)}
            </p>
            {done > 0 && (
              <Button variant="ghost" size="sm" onClick={onClear}>
                {m.upload.clearDone}
              </Button>
            )}
          </div>
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-1 rounded-lg border border-line-subtle p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span title={item.file.name} className="min-w-0 truncate text-body font-medium">
                    {item.file.name}
                  </span>
                  <span className="shrink-0 text-label text-ink-secondary">
                    {formatBytes(item.file.size)}
                  </span>
                </div>
                {(item.status === "uploading" || item.status === "queued") && (
                  <Progress
                    label={item.file.name}
                    {...(item.status === "uploading" ? { value: item.progress } : { value: 0 })}
                  />
                )}
                <div className="flex items-center justify-between gap-2 text-label">
                  <span
                    className={cn(
                      "min-w-0",
                      item.status === "error" && "text-tone-problem-fg",
                      item.status === "done" && "text-tone-success-fg",
                    )}
                  >
                    {item.status === "queued" && m.upload.queued}
                    {item.status === "uploading" &&
                      `${m.upload.uploading} ${Math.round(item.progress)}%`}
                    {item.status === "waiting" && m.upload.retryingIn(item.waitingSeconds ?? 0)}
                    {item.status === "done" && m.upload.done}
                    {item.status === "error" &&
                      item.errorKey &&
                      errorText(item.errorKey, item.errorRetryAfter)}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {item.status === "error" && (
                      <Button size="sm" variant="outline" onClick={() => onRetry(item.id)}>
                        {m.upload.retry}
                      </Button>
                    )}
                    {(item.status === "error" ||
                      item.status === "done" ||
                      item.status === "queued") && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onRemove(item.id)}
                        aria-label={`${m.upload.remove}: ${item.file.name}`}
                        title={m.upload.remove}
                      >
                        <X aria-hidden="true" className="size-4" />
                      </Button>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
