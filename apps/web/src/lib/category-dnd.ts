/**
 * Logica pură a glisării în arborele de categorii (testabilă fără browser). Interfața calculează
 * unde ar ateriza o categorie; serverul validează oricum mutarea (cicluri, adâncime, adresă).
 */

export interface TreeRow {
  id: string;
  parentId: string | null;
  /** Poziția între frați (0-based). */
  index: number;
  /** Numărul de frați (inclusiv ea). */
  siblingCount: number;
  /** Părinții în care are voie să fie mutată (`null` = rădăcina); calculat pe server. */
  validParentIds: readonly (string | null)[];
}

export type DropZone = "before" | "after" | "inside";

export interface DropTarget {
  parentId: string | null;
  /** Poziția între frații noului părinte, fără categoria mutată; `undefined` = la sfârșit. */
  index: number | undefined;
}

/** Zona de pe rândul peste care se trage: sfertul de sus, mijlocul, sfertul de jos. */
export function zoneFromOffset(offsetY: number, height: number): DropZone {
  if (height <= 0) return "inside";
  const ratio = offsetY / height;
  if (ratio < 0.25) return "before";
  if (ratio > 0.75) return "after";
  return "inside";
}

/**
 * Unde ajunge `dragged` dacă e lăsată în `zone` peste `over`. `null` = nu se poate (peste ea însăși
 * sau într-un loc care nu e în lista de părinți permiși).
 */
export function dropTarget(dragged: TreeRow, over: TreeRow, zone: DropZone): DropTarget | null {
  if (dragged.id === over.id) return null;
  const target: DropTarget =
    zone === "inside"
      ? { parentId: over.id, index: undefined }
      : {
          parentId: over.parentId,
          index: (() => {
            const raw = over.index + (zone === "after" ? 1 : 0);
            // același părinte și sursa e înaintea țintei: scoaterea ei mută totul cu o poziție
            return dragged.parentId === over.parentId && dragged.index < over.index ? raw - 1 : raw;
          })(),
        };
  return dragged.validParentIds.includes(target.parentId) ? target : null;
}

/** Mutarea cu o poziție în sus/jos între frați (`null` dacă e deja la capăt). */
export function stepTarget(row: TreeRow, direction: "up" | "down"): DropTarget | null {
  const index = direction === "up" ? row.index - 1 : row.index + 1;
  if (index < 0 || index >= row.siblingCount) return null;
  return { parentId: row.parentId, index };
}
