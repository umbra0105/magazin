/**
 * Logica pură a arborelui de categorii: validarea mutărilor (fără cicluri, fără categorie părinte a ei
 * însăși, adâncime maximă) și planul de actualizări (cale, adâncime, ordine). Nu atinge baza de date:
 * serviciul aplică planul într-o tranzacție.
 *
 * Adâncimea: rădăcina are `depth = 0`; limita este `MAX_CATEGORY_DEPTH = 4` (5 niveluri). Adâncimea unui
 * subarbore contează la mutare: o categorie cu copii de 2 niveluri nu se poate muta sub un părinte aflat
 * la adâncimea 3.
 */

export const MAX_CATEGORY_DEPTH = 4;

export interface CategoryNode {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  path: string;
  depth: number;
  sortOrder: number;
}

export type MoveRefusal =
  | "CATEGORY_NOT_FOUND"
  | "CATEGORY_PARENT_NOT_FOUND"
  | "CATEGORY_SELF_PARENT"
  | "CATEGORY_CYCLE"
  | "CATEGORY_TOO_DEEP";

export interface NodeUpdate {
  id: string;
  parentId: string | null;
  depth: number;
  path: string;
  sortOrder: number;
  /** Adresa nouă, doar la redenumire: se scrie în aceeași tranzacție cu căile (C-15). */
  slug?: string;
}

export const pathFor = (parentPath: string | null, slug: string): string =>
  parentPath ? `${parentPath}/${slug}` : slug;

/** Frații unui nod (aceiași părinți), în ordinea afișării: `sortOrder`, apoi numele. */
export function childrenOf(
  nodes: readonly CategoryNode[],
  parentId: string | null,
): CategoryNode[] {
  return nodes
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ro"));
}

/** Toți descendenții (copii, nepoți...) lui `id`. */
export function descendantIds(nodes: readonly CategoryNode[], id: string): Set<string> {
  const byParent = new Map<string | null, CategoryNode[]>();
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  const out = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const child of byParent.get(current) ?? []) {
      if (!out.has(child.id)) {
        out.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return out;
}

/** Câte niveluri sub `id` (0 = frunză). */
export function subtreeHeight(nodes: readonly CategoryNode[], id: string): number {
  const self = nodes.find((n) => n.id === id);
  if (!self) return 0;
  let max = self.depth;
  for (const d of descendantIds(nodes, id)) {
    const depth = nodes.find((n) => n.id === d)?.depth ?? self.depth;
    if (depth > max) max = depth;
  }
  return max - self.depth;
}

/** Valideaza mutarea lui `id` sub `newParentId` (`null` = la rădăcină). */
export function validateMove(
  nodes: readonly CategoryNode[],
  id: string,
  newParentId: string | null,
): { ok: true; newDepth: number } | { ok: false; code: MoveRefusal } {
  const node = nodes.find((n) => n.id === id);
  if (!node) return { ok: false, code: "CATEGORY_NOT_FOUND" };
  if (newParentId === id) return { ok: false, code: "CATEGORY_SELF_PARENT" };
  let newDepth = 0;
  if (newParentId !== null) {
    const parent = nodes.find((n) => n.id === newParentId);
    if (!parent) return { ok: false, code: "CATEGORY_PARENT_NOT_FOUND" };
    if (descendantIds(nodes, id).has(newParentId)) return { ok: false, code: "CATEGORY_CYCLE" };
    newDepth = parent.depth + 1;
  }
  if (newDepth + subtreeHeight(nodes, id) > MAX_CATEGORY_DEPTH) {
    return { ok: false, code: "CATEGORY_TOO_DEEP" };
  }
  return { ok: true, newDepth };
}

/**
 * Părinții în care se poate muta `id` (inclusiv rădăcina = `null`), pentru alternativa de tastatură a
 * glisării. Exclude categoria însăși, descendenții ei și părinții care ar depăși adâncimea maximă.
 */
export function validParents(nodes: readonly CategoryNode[], id: string): (string | null)[] {
  const options: (string | null)[] = [];
  if (validateMove(nodes, id, null).ok) options.push(null);
  for (const candidate of nodes) {
    if (validateMove(nodes, id, candidate.id).ok) options.push(candidate.id);
  }
  return options;
}

/**
 * Planul mutării lui `id` sub `newParentId`, la poziția `index` între frații noului părinte (`index`
 * mai mare decât numărul de frați = la sfârșit). Întoarce actualizările pentru: nodul și subarborele lui
 * (cale, adâncime), frații noului părinte și frații vechiului părinte (ordine continuă 0..n-1).
 * Presupune că mutarea a fost validată cu `validateMove`.
 */
export function planMove(
  nodes: readonly CategoryNode[],
  id: string,
  newParentId: string | null,
  index: number,
): NodeUpdate[] {
  const node = nodes.find((n) => n.id === id) as CategoryNode;
  const parent = newParentId === null ? null : (nodes.find((n) => n.id === newParentId) ?? null);
  const newDepth = parent ? parent.depth + 1 : 0;
  const newPath = pathFor(parent?.path ?? null, node.slug);
  const updates = new Map<string, NodeUpdate>();

  // frații noului părinte, fără nodul mutat, cu nodul inserat la poziție
  const siblings = childrenOf(nodes, newParentId).filter((n) => n.id !== id);
  const at = Math.min(Math.max(Math.trunc(index), 0), siblings.length);
  const ordered = [...siblings.slice(0, at), node, ...siblings.slice(at)];
  ordered.forEach((n, order) => {
    if (n.id === id) return;
    if (n.sortOrder !== order) {
      updates.set(n.id, {
        id: n.id,
        parentId: n.parentId,
        depth: n.depth,
        path: n.path,
        sortOrder: order,
      });
    }
  });
  updates.set(id, { id, parentId: newParentId, depth: newDepth, path: newPath, sortOrder: at });

  // vechii frați (dacă s-a schimbat părintele): ordine continuă
  if (node.parentId !== newParentId) {
    childrenOf(nodes, node.parentId)
      .filter((n) => n.id !== id)
      .forEach((n, order) => {
        if (n.sortOrder !== order) {
          updates.set(n.id, {
            id: n.id,
            parentId: n.parentId,
            depth: n.depth,
            path: n.path,
            sortOrder: order,
          });
        }
      });
  }

  // subarborele: adâncime și cale noi
  const delta = newDepth - node.depth;
  if (delta !== 0 || newPath !== node.path) {
    for (const d of descendantIds(nodes, id)) {
      const child = nodes.find((n) => n.id === d) as CategoryNode;
      updates.set(d, {
        id: d,
        parentId: child.parentId,
        depth: child.depth + delta,
        path: newPath + child.path.slice(node.path.length),
        sortOrder: child.sortOrder,
      });
    }
  }
  return [...updates.values()];
}

/** Schimbarea adresei (slug) lui `id`: calea lui și a descendenților se recalculează. */
export function planRename(
  nodes: readonly CategoryNode[],
  id: string,
  newSlug: string,
): NodeUpdate[] {
  const node = nodes.find((n) => n.id === id) as CategoryNode;
  const parent = node.parentId ? nodes.find((n) => n.id === node.parentId) : undefined;
  const newPath = pathFor(parent?.path ?? null, newSlug);
  const updates: NodeUpdate[] = [
    {
      id,
      parentId: node.parentId,
      depth: node.depth,
      path: newPath,
      sortOrder: node.sortOrder,
      slug: newSlug,
    },
  ];
  for (const d of descendantIds(nodes, id)) {
    const child = nodes.find((n) => n.id === d) as CategoryNode;
    updates.push({
      id: d,
      parentId: child.parentId,
      depth: child.depth,
      path: newPath + child.path.slice(node.path.length),
      sortOrder: child.sortOrder,
    });
  }
  return updates;
}
