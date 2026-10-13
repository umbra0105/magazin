/**
 * Coada de încărcări din browser (fără React, ca să fie testabilă): cel mult `concurrency`
 * încărcări simultane, progres pe fișier, reîncercare automată după `Retry-After` când serverul
 * răspunde `503 MEDIA_BUSY`, clasificarea erorilor în chei pentru mesajele din `ro.ts`.
 */

export type UploadErrorKey =
  | "tooLarge"
  | "unsupported"
  | "rateLimited"
  | "busy"
  | "storageUnavailable"
  | "unauthenticated"
  | "forbidden"
  | "originInvalid"
  | "empty"
  | "corrupt"
  | "tooManyPixels"
  | "folderMissing"
  | "network"
  | "generic";

export interface SendResult {
  status: number;
  /** Cod stabil din corpul JSON (`MEDIA_BUSY`, `MEDIA_TOO_LARGE`…), dacă există. */
  code?: string;
  retryAfterSeconds?: number;
  /** `id` din răspunsul 201. */
  mediaId?: string;
  /** Conexiunea a căzut sau cererea a fost anulată. */
  networkError?: boolean;
}

export type Classification =
  | { kind: "ok" }
  | { kind: "retry"; afterSeconds: number }
  | { kind: "error"; key: UploadErrorKey; retryAfterSeconds: number | null };

export const MAX_BUSY_RETRIES = 5;
const DEFAULT_RETRY_SECONDS = 5;

const BY_CODE: Record<string, UploadErrorKey> = {
  MEDIA_TOO_LARGE: "tooLarge",
  MEDIA_UNSUPPORTED_TYPE: "unsupported",
  MEDIA_EMPTY: "empty",
  MEDIA_CORRUPT: "corrupt",
  MEDIA_IMAGE_TOO_BIG: "tooManyPixels",
  MEDIA_FOLDER_NOT_FOUND: "folderMissing",
  MEDIA_STORAGE_UNAVAILABLE: "storageUnavailable",
  AUTH_RATE_LIMITED: "rateLimited",
  AUTH_UNAUTHENTICATED: "unauthenticated",
  AUTH_FORBIDDEN: "forbidden",
  ORIGIN_INVALID: "originInvalid",
};

export function classifyResponse(result: SendResult): Classification {
  if (result.networkError) return { kind: "error", key: "network", retryAfterSeconds: null };
  if (result.status === 201) return { kind: "ok" };
  if (result.status === 503 && result.code === "MEDIA_BUSY") {
    return { kind: "retry", afterSeconds: result.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS };
  }
  const byCode = result.code ? BY_CODE[result.code] : undefined;
  const key: UploadErrorKey =
    byCode ??
    (result.status === 413
      ? "tooLarge"
      : result.status === 415
        ? "unsupported"
        : result.status === 429
          ? "rateLimited"
          : result.status === 401
            ? "unauthenticated"
            : result.status === 403
              ? "forbidden"
              : result.status === 503
                ? "storageUnavailable"
                : "generic");
  return {
    kind: "error",
    key,
    retryAfterSeconds: key === "rateLimited" ? (result.retryAfterSeconds ?? null) : null,
  };
}

export type UploadStatus = "queued" | "uploading" | "waiting" | "done" | "error";

export interface UploadItem {
  id: string;
  file: File;
  status: UploadStatus;
  /** 0–100 */
  progress: number;
  errorKey: UploadErrorKey | null;
  errorRetryAfter: number | null;
  /** Secunde până la reîncercarea automată (status `waiting`). */
  waitingSeconds: number | null;
  attempts: number;
  mediaId: string | null;
}

export interface UploadOptions {
  folderId: string | null;
  alt: string;
}

export interface UploaderDeps {
  /** Trimite un fișier; raportează progresul 0–100. */
  send: (
    file: File,
    options: UploadOptions,
    onProgress: (percent: number) => void,
  ) => Promise<SendResult>;
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
  onChange?: (items: readonly UploadItem[]) => void;
  /** Apelat la fiecare încărcare reușită. */
  onUploaded?: (item: UploadItem) => void;
}

export class UploadQueue {
  private items: UploadItem[] = [];
  private active = 0;
  private readonly concurrency: number;
  private seq = 0;
  private readonly options = new Map<string, UploadOptions>();

  constructor(private readonly deps: UploaderDeps) {
    this.concurrency = deps.concurrency ?? 2;
  }

  get snapshot(): readonly UploadItem[] {
    return this.items;
  }

  add(files: readonly File[], options: UploadOptions): void {
    for (const file of files) {
      const id = `u${++this.seq}`;
      this.options.set(id, options);
      this.items = [
        ...this.items,
        {
          id,
          file,
          status: "queued",
          progress: 0,
          errorKey: null,
          errorRetryAfter: null,
          waitingSeconds: null,
          attempts: 0,
          mediaId: null,
        },
      ];
    }
    this.emit();
    this.pump();
  }

  retry(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== "error") return;
    this.patch(id, {
      status: "queued",
      progress: 0,
      errorKey: null,
      errorRetryAfter: null,
      attempts: 0,
    });
    this.pump();
  }

  remove(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status === "uploading" || item.status === "waiting") return;
    this.items = this.items.filter((i) => i.id !== id);
    this.options.delete(id);
    this.emit();
  }

  clearFinished(): void {
    this.items = this.items.filter((i) => i.status !== "done");
    this.emit();
  }

  private patch(id: string, patch: Partial<UploadItem>): void {
    this.items = this.items.map((i) => (i.id === id ? { ...i, ...patch } : i));
    this.emit();
  }

  private emit(): void {
    this.deps.onChange?.(this.items);
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const next = this.items.find((i) => i.status === "queued");
      if (!next) return;
      this.active += 1;
      this.patch(next.id, { status: "uploading", progress: 0 });
      void this.run(next.id).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(id: string): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    const options = this.options.get(id) ?? { folderId: null, alt: "" };
    for (let attempt = 1; ; attempt++) {
      const item = this.items.find((i) => i.id === id);
      if (!item) return;
      this.patch(id, { status: "uploading", attempts: attempt, waitingSeconds: null });

      const result = await this.deps
        .send(item.file, options, (percent) => this.patch(id, { progress: percent }))
        .catch((): SendResult => ({ status: 0, networkError: true }));
      const verdict = classifyResponse(result);

      if (verdict.kind === "ok") {
        this.patch(id, { status: "done", progress: 100, mediaId: result.mediaId ?? null });
        const done = this.items.find((i) => i.id === id);
        if (done) this.deps.onUploaded?.(done);
        return;
      }
      if (verdict.kind === "retry" && attempt <= MAX_BUSY_RETRIES) {
        // Reîncercare automată după Retry-After, cu numărătoare inversă vizibilă.
        for (let left = verdict.afterSeconds; left > 0; left--) {
          this.patch(id, { status: "waiting", waitingSeconds: left, progress: 0 });
          await sleep(1000);
        }
        continue;
      }
      this.patch(id, {
        status: "error",
        progress: 0,
        waitingSeconds: null,
        errorKey: verdict.kind === "retry" ? "busy" : verdict.key,
        errorRetryAfter: verdict.kind === "retry" ? null : verdict.retryAfterSeconds,
      });
      return;
    }
  }
}

/** Trimiterea reală, cu XMLHttpRequest (fetch nu raportează progresul încărcării). */
export function xhrSend(
  file: File,
  options: UploadOptions,
  onProgress: (percent: number) => void,
): Promise<SendResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const params = new URLSearchParams();
    if (options.folderId) params.set("folderId", options.folderId);
    if (options.alt) params.set("alt", options.alt);
    const query = params.toString();
    xhr.open("POST", `/api/media${query ? `?${query}` : ""}`);
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress((event.loaded / event.total) * 100);
    };
    xhr.onerror = () => resolve({ status: 0, networkError: true });
    xhr.onabort = () => resolve({ status: 0, networkError: true });
    xhr.onload = () => {
      let code: string | undefined;
      let mediaId: string | undefined;
      try {
        const body = JSON.parse(xhr.responseText) as { code?: string; id?: string };
        code = body.code;
        mediaId = body.id;
      } catch {
        // corp non-JSON: ne bazăm pe status
      }
      const retryAfter = Number(xhr.getResponseHeader("Retry-After"));
      resolve({
        status: xhr.status,
        ...(code && { code }),
        ...(mediaId && { mediaId }),
        ...(Number.isFinite(retryAfter) && retryAfter > 0 && { retryAfterSeconds: retryAfter }),
      });
    };
    xhr.send(file);
  });
}
