"use server";

import { z } from "zod";
import {
  MediaInUseError,
  MediaLibraryError,
  type LibraryFolder,
  type LibraryItem,
  type MediaUsage,
} from "@ecom/core";
import { DomainError, ValidationError } from "@ecom/shared";
import { getMediaLibrary } from "@/lib/media";
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

function failure(error: unknown): ActionFailure {
  if (error instanceof MediaInUseError) {
    return { ok: false, code: "IN_USE", usages: error.usages };
  }
  if (error instanceof MediaLibraryError) return { ok: false, code: error.code };
  if (error instanceof ValidationError) {
    return { ok: false, code: "VALIDATION_ERROR", message: error.message };
  }
  if (error instanceof z.ZodError) return { ok: false, code: "VALIDATION_ERROR" };
  if (error instanceof DomainError && error.code === "AUDIT_WRITE_FAILED") {
    return { ok: false, code: "AUDIT_WRITE_FAILED" };
  }
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
