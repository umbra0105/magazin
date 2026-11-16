import type { Prisma } from "@ecom/db";

/**
 * Istoricul de adrese (Faza 7, C-43): când se schimbă slugul unui produs sau al unui brand, ori calea unei categorii,
 * adresa veche rămâne în `slug_redirect` și vitrina o redirecționează permanent (301) către adresa curentă a ENTITĂȚII.
 * Redirecționările pointează spre entitate, nu spre adresa următoare, deci nu există lanțuri: oricâte redenumiri, un salt.
 *
 * Planul e calculat de funcții pure (testate separat); scrierea se face în ACEEAȘI tranzacție cu schimbarea adresei
 * (magazinele de produse, categorii și branduri), ca să nu existe o adresă schimbată fără istoric.
 */

export type RedirectKind = "product" | "category" | "brand";

export interface RedirectEntry {
  kind: RedirectKind;
  oldKey: string;
  targetId: string;
}

export interface RedirectPlan {
  /** Adrese vechi de păstrat (spre entitate). */
  add: RedirectEntry[];
  /** Adrese care sunt ACUM pagini vii: se scot din istoric, ca o pagină vie să nu fie umbrită de o redirecționare. */
  reclaim: string[];
}

/** Cheia canonică din istoric: litere mici, fără spații la capete (adresele sunt oricum fără diferență de majuscule). */
export function redirectKey(key: string): string {
  return key.trim().toLowerCase();
}

/** Produs sau brand: o adresă veche devine redirecționare doar dacă s-a schimbat cu adevărat (nu doar litere mari/mici). */
export function planSlugRedirects(
  kind: Exclude<RedirectKind, "category">,
  targetId: string,
  oldSlug: string,
  newSlug: string,
): RedirectPlan {
  const oldKey = redirectKey(oldSlug);
  const newKey = redirectKey(newSlug);
  if (oldKey === newKey) return { add: [], reclaim: [] };
  return { add: [{ kind, oldKey, targetId }], reclaim: [newKey] };
}

/**
 * Categorii: `before` și `after` au aceleași categorii (cele atinse de o redenumire sau mutare), cu calea dinainte și de
 * după. Orice cale schimbată lasă calea veche spre categorie. O cale veche care a devenit calea vie a altei categorii
 * (schimb de căi) nu se păstrează: pagina vie are prioritate.
 */
export function planCategoryRedirects(
  before: readonly { id: string; path: string }[],
  after: readonly { id: string; path: string }[],
): RedirectPlan {
  const newPaths = new Map(after.map((c) => [c.id, redirectKey(c.path)]));
  const live = new Set(newPaths.values());
  const add: RedirectEntry[] = [];
  for (const old of before) {
    const next = newPaths.get(old.id);
    if (next === undefined) continue;
    const oldKey = redirectKey(old.path);
    if (oldKey === next || live.has(oldKey)) continue;
    add.push({ kind: "category", oldKey, targetId: old.id });
  }
  const reclaim = before
    .filter((c) => {
      const next = newPaths.get(c.id);
      return next !== undefined && next !== redirectKey(c.path);
    })
    .map((c) => newPaths.get(c.id) as string)
    .sort();
  return { add, reclaim };
}

/** Aplică planul pe `kind` în tranzacția curentă: întâi scoate adresele devenite vii, apoi scrie cele vechi (upsert). */
export async function applyRedirectPlan(
  tx: Prisma.TransactionClient,
  kind: RedirectKind,
  plan: RedirectPlan,
): Promise<void> {
  if (plan.reclaim.length > 0) {
    await tx.slugRedirect.deleteMany({ where: { kind, oldKey: { in: plan.reclaim } } });
  }
  for (const entry of plan.add) {
    await tx.slugRedirect.upsert({
      where: { kind_oldKey: { kind: entry.kind, oldKey: entry.oldKey } },
      create: entry,
      update: { targetId: entry.targetId },
    });
  }
}

/** Entitatea spre care duce o adresă veche, sau `null`. Vitrina verifică separat că entitatea există și e vizibilă. */
export async function findRedirectTarget(
  db: Pick<Prisma.TransactionClient, "slugRedirect">,
  kind: RedirectKind,
  key: string,
): Promise<string | null> {
  const row = await db.slugRedirect.findUnique({
    where: { kind_oldKey: { kind, oldKey: redirectKey(key) } },
    select: { targetId: true },
  });
  return row?.targetId ?? null;
}
