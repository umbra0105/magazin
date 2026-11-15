/**
 * Meniul de categorii al vitrinei (Faza 6: mega menu, drawer, footer). Logica pură: din lista de categorii construiește arborele
 * afișat, cu adrese reale `/categorie/<cale>` (`docs/03` §1) ca să fie `<a href>` în HTML-ul serverului. Categoriile fără niciun
 * produs activ în tot subarborele nu apar (un meniu cu pagini goale e o capcană de SEO și de conversie); părintele gol cu un
 * copil plin rămâne. Nu atinge baza de date.
 */
export const CATEGORY_URL_PREFIX = "/categorie/";

export interface MenuCategory {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  path: string;
  depth: number;
  sortOrder: number;
  /** Produse active (nesterse) direct în această categorie. */
  productCount: number;
}

export interface MenuNode {
  id: string;
  name: string;
  href: string;
  children: MenuNode[];
}

export function buildMenuTree(
  categories: readonly MenuCategory[],
  options: { maxLevels: number },
): MenuNode[] {
  const byParent = new Map<string | null, MenuCategory[]>();
  for (const category of categories) {
    const siblings = byParent.get(category.parentId) ?? [];
    siblings.push(category);
    byParent.set(category.parentId, siblings);
  }

  const build = (parentId: string | null, level: number): MenuNode[] => {
    const siblings = (byParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ro"));
    const nodes: MenuNode[] = [];
    for (const category of siblings) {
      // subarborele întreg decide vizibilitatea, chiar dacă nivelurile adânci nu se afișează
      if (!hasProducts(category)) continue;
      nodes.push({
        id: category.id,
        name: category.name,
        href: `${CATEGORY_URL_PREFIX}${category.path}`,
        children: level < options.maxLevels ? build(category.id, level + 1) : [],
      });
    }
    return nodes;
  };

  const hasProducts = (category: MenuCategory): boolean =>
    category.productCount > 0 ||
    (byParent.get(category.id) ?? []).some((child) => hasProducts(child));

  // doar rădăcinile adevărate (părinte nul): un copil al unui părinte care lipsește din listă nu devine rădăcină
  return build(null, 1);
}
