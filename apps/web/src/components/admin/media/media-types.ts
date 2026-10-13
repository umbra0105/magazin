import type { LibraryFolder, LibraryItem, MediaUsage } from "@ecom/core";
import { getMessages } from "@/messages";

export type { LibraryFolder, LibraryItem, MediaUsage };

const m = getMessages().admin.media;

/** Rezultatul unei acțiuni de server: succes sau cod stabil (+ detalii). */
export type ActionResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message?: string; usages?: readonly MediaUsage[] };

/** Mesajul în română pentru un cod de eroare întors de acțiuni. */
export function actionErrorMessage(result: { code: string; message?: string }): string {
  if (result.code === "VALIDATION_ERROR" && result.message) return result.message;
  const known = m.errors as Record<string, string>;
  return known[result.code] ?? m.errors.generic;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("ro-RO", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

/** Folderele ca listă plată, în ordinea arborelui, cu adâncimea (pentru indentare și selectoare). */
export function flattenFolders(
  folders: readonly LibraryFolder[],
): { folder: LibraryFolder; depth: number }[] {
  const out: { folder: LibraryFolder; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of folders.filter((f) => f.parentId === parentId)) {
      out.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Folderele care NU sunt `id` sau descendenții lui (candidații valizi pentru mutare). */
export function movableTargets(
  folders: readonly LibraryFolder[],
  id: string,
): { folder: LibraryFolder; depth: number }[] {
  const banned = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && banned.has(f.parentId) && !banned.has(f.id)) {
        banned.add(f.id);
        grew = true;
      }
    }
  }
  return flattenFolders(folders).filter(({ folder }) => !banned.has(folder.id));
}
