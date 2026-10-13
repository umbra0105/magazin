"use server";

import { z } from "zod";
import { can, type LibraryFolder, type LibraryItem, type MediaUsage } from "@ecom/core";
import { getMediaLibrary } from "@/lib/media";
import { getSettings } from "@/lib/services";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile bibliotecii media. Fiecare: validare Zod la graniță, `withPermission` (citirea cere
 * `media.read`, orice modificare `media.write`; refuzul se înregistrează în audit), apoi serviciul
 * din `@ecom/core`, care verifică din nou permisiunea și scrie în audit. Erorile de domeniu se
 * întorc ca rezultat (cod stabil), nu ca excepții, ca UI-ul să arate mesajul potrivit.
 */

export type ActionFailure = {
  ok: false;
  code: string;
  message?: string;
  usages?: readonly MediaUsage[];
};

/**
 * Clasificare după codul stabil al erorii, nu `instanceof`: serviciul bibliotecii e păstrat în
 * `globalThis`, iar în Next modulele pot exista în mai multe copii (straturi, reîncărcare la cald).
 */
function failure(error: unknown): ActionFailure {
  const e = error as { code?: unknown; usages?: unknown; message?: unknown; name?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : undefined;
  if (code === "MEDIA_IN_USE" && Array.isArray(e?.usages)) {
    return { ok: false, code: "IN_USE", usages: e.usages as MediaUsage[] };
  }
  if (
    code === "MEDIA_NOT_FOUND" ||
    code === "FOLDER_NOT_FOUND" ||
    code === "FOLDER_NAME_TAKEN" ||
    code === "FOLDER_CYCLE" ||
    code === "FOLDER_TOO_DEEP" ||
    code === "AUDIT_WRITE_FAILED"
  ) {
    return { ok: false, code };
  }
  if (code === "VALIDATION_ERROR" && typeof e?.message === "string") {
    return { ok: false, code: "VALIDATION_ERROR", message: e.message };
  }
  if (e?.name === "ZodError") return { ok: false, code: "VALIDATION_ERROR" };
  throw error;
}

const id = z.string().min(1).max(40);
const folderId = z.string().min(1).max(40).nullable();

export const getMediaStatuses = withPermission(
  "media.read",
  async (input: unknown, subject) => {
    const ids = z.array(id).max(60).parse(input);
    const items: LibraryItem[] = await getMediaLibrary().statuses(subject, ids);
    return { ok: true as const, items };
  },
  { action: "media.read", entity: "media" },
);

export const updateMedia = withPermission(
  "media.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z
        .object({
          id,
          alt: z.string().max(1000).optional(),
          tags: z.array(z.string().max(100)).max(100).optional(),
          folderId: folderId.optional(),
        })
        .parse(input);
      const item = await getMediaLibrary().update(subject, parsed.id, {
        ...(parsed.alt !== undefined && { alt: parsed.alt }),
        ...(parsed.tags !== undefined && { tags: parsed.tags }),
        ...(parsed.folderId !== undefined && { folderId: parsed.folderId }),
      });
      return { ok: true as const, item };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "media.update", entity: "media" },
);

export const deleteMedia = withPermission(
  "media.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id }).parse(input);
      await getMediaLibrary().delete(subject, parsed.id);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "media.delete", entity: "media" },
);

export const regenerateMedia = withPermission(
  "media.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id }).parse(input);
      await getMediaLibrary().regenerate(subject, parsed.id);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "media.regenerate", entity: "media" },
);

export const createMediaFolder = withPermission(
  "media.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ name: z.string().max(200), parentId: folderId }).parse(input);
      const folder: LibraryFolder = await getMediaLibrary().createFolder(
        subject,
        parsed.name,
        parsed.parentId,
      );
      return { ok: true as const, folder };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "media_folder.create", entity: "media_folder" },
);

export const renameMediaFolder = withPermission(
  "media.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id, name: z.string().max(200) }).parse(input);
      const folder = await getMediaLibrary().renameFolder(subject, parsed.id, parsed.name);
      return { ok: true as const, folder };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "media_folder.rename", entity: "media_folder" },
);

export const moveMediaFolder = withPermission(
  "media.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id, parentId: folderId }).parse(input);
      const folder = await getMediaLibrary().moveFolder(subject, parsed.id, parsed.parentId);
      return { ok: true as const, folder };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "media_folder.move", entity: "media_folder" },
);

/**
 * Lista pentru selectorul `MediaPicker`: doar fișierele `ready` (filtrul de stare e impus aici, pe
 * server, nu vine din cerere), 12 pe pagină, plus folderele. Cere `media.read`; `canWrite` spune
 * selectorului dacă să arate încărcarea (serverul refuză oricum încărcarea fără `media.write`).
 */
export const listPickerMedia = withPermission(
  "media.read",
  async (input: unknown, subject) => {
    const parsed = z
      .object({
        q: z.string().max(100).optional(),
        folder: z.string().max(40).optional(),
        page: z.number().int().min(1).max(100000).optional(),
      })
      .parse(input);
    const library = getMediaLibrary();
    const [list, folders, maxUploadBytes] = await Promise.all([
      library.list(subject, {
        ...(parsed.q && { q: parsed.q }),
        ...(parsed.folder && { folder: parsed.folder }),
        ...(parsed.page && { page: parsed.page }),
        status: "ready",
        pageSize: 12,
      }),
      library.folders(subject),
      getSettings().get("media.maxUploadBytes"),
    ]);
    return {
      ok: true as const,
      ...list,
      folders,
      canWrite: can(subject, "media.write"),
      maxUploadMb: Math.max(Math.round(maxUploadBytes / (1024 * 1024)), 1),
    };
  },
  { action: "media.pick", entity: "media" },
);
