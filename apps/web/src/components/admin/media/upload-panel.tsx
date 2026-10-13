"use client";

import { Upload, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button, Progress, cn } from "@ecom/ui";
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
 * pe fiecare fișier. Încărcarea propriu-zisă o face `UploadQueue` (max. 2 simultan).
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
  const input = useRef<HTMLInputElement>(null);
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
          "flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border p-4 text-center",
          dragging && "border-primary bg-primary/5",
        )}
      >
        <Upload aria-hidden="true" className="size-6 text-muted-foreground" />
        <h2 id={`${inputId}-title`} className="text-sm font-medium">
          {m.upload.dropHere}
        </h2>
        <p className="text-xs text-muted-foreground">{m.upload.or} </p>
        <input
          ref={input}
          id={inputId}
          type="file"
          multiple
          accept={accept}
          className="sr-only"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            if (files.length > 0) onFiles(files);
            e.target.value = ""; // permite alegerea aceluiași fișier încă o dată
          }}
        />
        <Button variant="outline" onClick={() => input.current?.click()}>
          {m.upload.choose}
        </Button>
        <p className="text-xs text-muted-foreground">{rules}</p>
      </div>

      {items.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <p role="status" aria-live="polite" className="text-sm">
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
              <li key={item.id} className="flex flex-col gap-1 rounded-md border border-border p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{item.file.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatBytes(item.file.size)}
                  </span>
                </div>
                {(item.status === "uploading" || item.status === "queued") && (
                  <Progress
                    label={item.file.name}
                    {...(item.status === "uploading" ? { value: item.progress } : { value: 0 })}
                  />
                )}
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span
                    className={cn(
                      item.status === "error" && "text-danger",
                      item.status === "done" && "text-success",
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
                  <span className="flex shrink-0 gap-1">
                    {item.status === "error" && (
                      <Button size="sm" variant="outline" onClick={() => onRetry(item.id)}>
                        {m.upload.retry}
                      </Button>
                    )}
                    {(item.status === "error" ||
                      item.status === "done" ||
                      item.status === "queued") && (
                      <button
                        type="button"
                        onClick={() => onRemove(item.id)}
                        aria-label={`${m.upload.remove}: ${item.file.name}`}
                        className="inline-flex size-9 items-center justify-center rounded-md hover:bg-border/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <X aria-hidden="true" className="size-4" />
                      </button>
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
