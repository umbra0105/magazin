import { type getLogger } from "@ecom/shared";
import type { AuditService } from "../../../audit/audit-service";
import { can, type PermissionSubject } from "../../../rbac/can";
import { isMediaError } from "../../../media/errors";
import type { ImageLimits } from "../../../media/image";
import type { MediaService } from "../../../media/media-service";
import { sanitizeFileName } from "../../../media/file-name";
import { SafeFetchError, type SafeFetchPolicy } from "../../../media/safe-fetch";
import { CATALOG_TAG } from "../../catalog-support";
import type { ProductAssignmentsService } from "../../product-assignments";
import type { ProductImportStore } from "../import-store";
import type { ImageTask, ImageTaskStore } from "./image-store";

/**
 * Descărcarea imaginilor unui import WooCommerce, în fundal, DUPĂ ce produsele au fost create (punctul 15b).
 *
 *  - Singura cale în rețea e `fetchImage` (în producție: `safeFetchImage`, cu toate verificările SSRF); aici nu
 *    există nicio cerere de rețea proprie.
 *  - Octeții descărcați trec prin aceeași conductă ca încărcarea din admin (`MediaService.upload`: tipul din
 *    octeți, SVG și tipuri active refuzate, limita de pixeli, reencodare cu sharp, fără EXIF), apoi prin
 *    procesarea media (variante). O imagine care nu trece = eroare pe IMAGINE, nu pe produs.
 *  - Idempotent: aceeași adresă sursă nu produce al doilea fișier (hash-ul adresei e unic pe `Media`); o a doua
 *    rulare descarcă doar ce lipsește, iar imaginile eșuate se reîncearcă.
 *  - Atașarea: în ordinea din fișier, DUPĂ imaginile existente (prima devine principală doar dacă produsul n-are
 *    nicio imagine); nu șterge și nu înlocuiește nimic.
 *  - Permisiunea (`products.write` ȘI `media.write`) se reverifică la rulare, pe utilizatorul care a pornit importul.
 * Motivele eșecului sunt coduri stabile; nu se scriu IP-uri, anteturi, corpuri de răspuns sau căi interne.
 */

export interface ImageImportPolicy {
  allowedHosts: readonly string[];
  maxUrlLength: number;
  maxDownloadBytes: number;
  connectTimeoutSeconds: number;
  totalTimeoutSeconds: number;
  maxRedirects: number;
  concurrency: number;
  perHostConcurrency: number;
}

export type ImageProcessOutcome = "ready" | "failed" | "busy";

export interface ImageImporterDeps {
  tasks: ImageTaskStore;
  imports: Pick<ProductImportStore, "get">;
  /** Singura cale în rețea: `safeFetchImage` în producție. */
  fetchImage: (url: string, policy: SafeFetchPolicy) => Promise<{ bytes: Buffer; host: string }>;
  media: Pick<MediaService, "upload">;
  /** Generează variantele unui fișier proaspăt încărcat (procesorul media); întoarce starea finală. */
  processMedia: (mediaId: string) => Promise<ImageProcessOutcome>;
  assignments: Pick<ProductAssignmentsService, "setMedia">;
  getPolicy: () => Promise<ImageImportPolicy>;
  getMediaLimits: () => Promise<ImageLimits>;
  loadSubject: (userId: string) => Promise<PermissionSubject | null>;
  audit: AuditService;
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
  logger: Pick<ReturnType<typeof getLogger>, "warn" | "error">;
}

export interface ImageImportSummary {
  downloaded: number;
  existing: number;
  failed: number;
  attached: number;
}

/** Mesajele pentru administrator, pe cod (fără adrese, IP-uri sau detalii interne). */
export const IMAGE_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  too_long: "adresă prea lungă",
  invalid: "adresă invalidă",
  scheme: "adresă respinsă (doar https)",
  credentials: "adresă respinsă (cu utilizator sau parolă)",
  port: "adresă respinsă (doar portul 443)",
  fragment: "adresă respinsă (cu fragment)",
  ip_literal: "adresă respinsă (IP în loc de domeniu)",
  no_hosts_configured: "lista de domenii permise e goală",
  host_not_allowed: "domeniu nepermis",
  dns_failed: "descărcare eșuată (domeniul nu răspunde)",
  address_not_public: "adresă respinsă (nu duce la un server public)",
  connect_failed: "descărcare eșuată",
  timeout: "timp depășit",
  too_many_redirects: "adresă respinsă (prea multe redirecturi)",
  redirect_refused: "adresă respinsă (redirect către altă gazdă)",
  bad_status: "descărcare eșuată (răspuns neașteptat)",
  compressed: "descărcare eșuată (răspuns comprimat)",
  too_large: "imagine prea mare",
  empty: "descărcare eșuată (răspuns gol)",
  not_image: "fișierul nu e o imagine acceptată",
  image_too_big: "imaginea are prea mulți pixeli",
  corrupt: "imagine coruptă",
  processing_failed: "imaginea nu a putut fi procesată",
  attach_failed: "imaginea nu a putut fi atașată produsului",
  permission: "contul care a pornit importul nu mai are dreptul de a încărca imagini",
  busy: "serverul e ocupat; reîncearcă mai târziu",
  download_failed: "descărcare eșuată",
};

export const imageFailureMessage = (code: string | null): string =>
  (code && IMAGE_FAILURE_MESSAGES[code]) || "descărcare eșuată";

/** Un semafor simplu: cel mult `max` sarcini în același timp. */
class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "P2002";

/** Numele fișierului din calea adresei (doar pentru afișare în bibliotecă; nu influențează tipul). */
function fileNameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return sanitizeFileName(last) || "imagine";
  } catch {
    return "imagine";
  }
}

/** Codul stabil al unei erori de la o imagine. Nu citește și nu păstrează mesajul erorii. */
export function imageFailureCode(error: unknown): string {
  if (error instanceof SafeFetchError) return error.code;
  if (isMediaError(error)) {
    switch (error.code) {
      case "MEDIA_TOO_LARGE":
        return "too_large";
      case "MEDIA_UNSUPPORTED_TYPE":
        return "not_image";
      case "MEDIA_IMAGE_TOO_BIG":
        return "image_too_big";
      case "MEDIA_CORRUPT":
        return "corrupt";
      case "MEDIA_EMPTY":
        return "empty";
      case "MEDIA_BUSY":
        return "busy";
      default:
        return "download_failed";
    }
  }
  if ((error as { code?: unknown } | null)?.code === "IMAGE_PROCESSING_FAILED") {
    return "processing_failed";
  }
  return "download_failed";
}

export class ProductImageImporter {
  constructor(private readonly deps: ImageImporterDeps) {}

  /**
   * Rulează sarcinile în așteptare ale unui import, apoi atașează imaginile produselor. Se poate chema din nou
   * oricând (jobul căzut la mijloc, reîncercarea celor eșuate): ce e gata nu se mai atinge.
   */
  async run(importId: string): Promise<ImageImportSummary> {
    const { deps } = this;
    const summary: ImageImportSummary = { downloaded: 0, existing: 0, failed: 0, attached: 0 };
    const record = await deps.imports.get(importId);
    if (!record || record.status !== "completed") return summary;

    const subject = record.createdById ? await deps.loadSubject(record.createdById) : null;
    const pending = await deps.tasks.listTasks(importId, ["pending"]);
    const allowed = subject && can(subject, "products.write") && can(subject, "media.write");
    if (!subject || !allowed) {
      for (const task of pending) {
        await deps.tasks.setResult(task.id, { status: "failed", reason: "permission" });
        summary.failed += 1;
      }
      await this.audit(importId, null, summary);
      return summary;
    }

    if (pending.length > 0) {
      const policy = await deps.getPolicy();
      const limits = await deps.getMediaLimits();
      const fetchPolicy: SafeFetchPolicy = {
        allowedHosts: policy.allowedHosts,
        maxUrlLength: policy.maxUrlLength,
        maxBytes: policy.maxDownloadBytes,
        connectTimeoutMs: policy.connectTimeoutSeconds * 1000,
        totalTimeoutMs: policy.totalTimeoutSeconds * 1000,
        maxRedirects: policy.maxRedirects,
      };
      const titles = await deps.tasks.productTitles([...new Set(pending.map((t) => t.productId))]);
      const hostGates = new Map<string, Gate>();
      const gateFor = (host: string): Gate => {
        let gate = hostGates.get(host);
        if (!gate) {
          gate = new Gate(policy.perHostConcurrency);
          hostGates.set(host, gate);
        }
        return gate;
      };

      // aceeași adresă de mai multe ori în import: o singură descărcare (restul așteaptă rezultatul)
      const inFlight = new Map<string, Promise<{ downloaded: boolean }>>();
      const resolveOne = (task: ImageTask): Promise<{ downloaded: boolean }> => {
        const existing = inFlight.get(task.sourceHash);
        if (existing) return existing.then(() => ({ downloaded: false }));
        const promise = gateFor(task.host).run(() =>
          this.obtain(task, titles.get(task.productId) ?? "", subject, fetchPolicy, limits),
        );
        inFlight.set(task.sourceHash, promise);
        return promise;
      };

      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const task = pending[cursor++];
          if (!task) return;
          try {
            const { downloaded } = await resolveOne(task);
            await deps.tasks.setResult(task.id, {
              status: downloaded ? "downloaded" : "existing",
              reason: null,
            });
            if (downloaded) summary.downloaded += 1;
            else summary.existing += 1;
          } catch (error) {
            const reason = imageFailureCode(error);
            if (reason === "download_failed") {
              // fără mesajul erorii (poate conține adrese sau căi): doar tipul
              deps.logger.warn(
                {
                  importId,
                  host: task.host,
                  kind: error instanceof Error ? error.name : "necunoscut",
                },
                "import imagini: o imagine nu s-a putut aduce",
              );
            }
            await deps.tasks.setResult(task.id, { status: "failed", reason });
            summary.failed += 1;
          }
        }
      };
      const lanes = Math.max(1, Math.min(policy.concurrency, pending.length));
      await Promise.all(Array.from({ length: lanes }, () => worker()));
    }

    summary.attached = await this.attach(importId, subject);
    await this.audit(importId, subject, summary);
    try {
      await deps.invalidate?.([CATALOG_TAG]);
    } catch (error) {
      deps.logger.warn(
        { reason: error instanceof Error ? error.name : "necunoscut" },
        "import imagini: invalidarea cache-ului a eșuat",
      );
    }
    return summary;
  }

  /** Fișierul pentru o sarcină: cel deja adus de la aceeași adresă sau unul nou, descărcat și procesat. */
  private async obtain(
    task: ImageTask,
    title: string,
    subject: PermissionSubject,
    fetchPolicy: SafeFetchPolicy,
    limits: ImageLimits,
  ): Promise<{ downloaded: boolean }> {
    const { deps } = this;
    const known = await deps.tasks.findMediaBySourceHash(task.sourceHash);
    if (known) {
      await this.ensureReady(known.id, known.status);
      return { downloaded: false };
    }
    const fetched = await deps.fetchImage(task.sourceUrl, fetchPolicy);
    let mediaId: string;
    try {
      const uploaded = await deps.media.upload({
        bytes: fetched.bytes,
        originalName: fileNameFromUrl(task.sourceUrl),
        alt: title.slice(0, 300),
        uploadedById: subject.userId,
        limits,
        sourceHash: task.sourceHash,
      });
      mediaId = uploaded.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // altcineva a adus aceeași adresă între timp: se folosește fișierul lui
      const winner = await deps.tasks.findMediaBySourceHash(task.sourceHash);
      if (!winner) throw error;
      await this.ensureReady(winner.id, winner.status);
      return { downloaded: false };
    }
    await this.ensureReady(mediaId, "pending");
    return { downloaded: true };
  }

  private async ensureReady(mediaId: string, status: string): Promise<void> {
    if (status === "ready") return;
    const outcome = await this.deps.processMedia(mediaId);
    if (outcome === "busy") throw Object.assign(new Error("busy"), { code: "MEDIA_BUSY" });
    if (outcome === "failed") throw new ProcessingFailed();
  }

  /** Imaginile sarcinilor terminate, în ordinea din fișier, după cele existente ale produsului. */
  private async attach(importId: string, subject: PermissionSubject): Promise<number> {
    const { deps } = this;
    const done = await deps.tasks.listTasks(importId, ["downloaded", "existing"]);
    // fișierele se regăsesc prin hash-ul adresei sursă (unic pe `Media`); sarcinile nu au cheie străină spre media
    const mediaByHash = await deps.tasks.findMediaBySourceHashes([
      ...new Set(done.map((task) => task.sourceHash)),
    ]);
    const byProduct = new Map<string, ImageTask[]>();
    for (const task of done) {
      byProduct.set(task.productId, [...(byProduct.get(task.productId) ?? []), task]);
    }
    let attached = 0;
    for (const [productId, tasks] of byProduct) {
      try {
        const current = await deps.tasks.productMediaIds(productId);
        const have = new Set(current);
        const fresh: string[] = [];
        for (const task of [...tasks].sort((a, b) => a.position - b.position)) {
          const mediaId = mediaByHash.get(task.sourceHash)?.id;
          if (!mediaId) {
            // fișierul a fost șters din bibliotecă între timp: imaginea se reia la următoarea rulare
            await deps.tasks.setResult(task.id, { status: "failed", reason: "attach_failed" });
            continue;
          }
          if (!have.has(mediaId) && !fresh.includes(mediaId)) fresh.push(mediaId);
        }
        if (fresh.length === 0) continue;
        await deps.assignments.setMedia(subject, productId, { mediaIds: [...current, ...fresh] });
        attached += fresh.length;
      } catch (error) {
        deps.logger.warn(
          { importId, kind: error instanceof Error ? error.name : "necunoscut" },
          "import imagini: imaginile nu s-au putut atașa unui produs",
        );
        for (const task of tasks) {
          await deps.tasks.setResult(task.id, { status: "failed", reason: "attach_failed" });
        }
      }
    }
    return attached;
  }

  private async audit(
    importId: string,
    subject: PermissionSubject | null,
    summary: ImageImportSummary,
  ): Promise<void> {
    await this.deps.audit.record({
      actorId: subject?.userId ?? null,
      actorLabel: subject?.email ?? "import",
      action: "product.import.images",
      entity: "product_import",
      entityId: importId,
      after: {
        downloaded: summary.downloaded,
        existing: summary.existing,
        failed: summary.failed,
        attached: summary.attached,
      },
    });
  }
}

class ProcessingFailed extends Error {
  readonly code = "IMAGE_PROCESSING_FAILED";
  constructor() {
    super("IMAGE_PROCESSING_FAILED");
    this.name = "ProcessingFailed";
  }
}
