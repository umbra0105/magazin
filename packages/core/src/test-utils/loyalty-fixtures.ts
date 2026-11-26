import { randomUUID } from "node:crypto";
import { adjustPoints } from "../loyalty/ledger";
import { NOW, type Harness } from "./checkout-fixtures";
import { userWorld, type World } from "./digital-checkout";
import type { TestTx } from "./rollback";

/**
 * Fixture-uri pentru loialitate (Faza 15b). Programul se pornește în tranzacția testului (flag și setări), fără seed; punctele se
 * dau printr-o ajustare, ca în admin. Datele pleacă din ceasul injectat `NOW`.
 */
export const LOYALTY_NOW_DAY = 86_400_000;

export async function setSetting(tx: TestTx, key: string, value: unknown): Promise<void> {
  const group = key.split(".")[0] as string;
  const json = value as never;
  if (value === null) {
    // `null` se scrie prin ștergerea rândului: setarea revine la implicit (gol)
    await tx.setting.deleteMany({ where: { key } });
    return;
  }
  await tx.setting.upsert({
    where: { key },
    create: { key, group, value: json },
    update: { value: json },
  });
}

/** Pornește programul: flag, `enabled` și (implicit) `vatMode = base_reduced`. `overrides` suprascrie sau adaugă setări. */
export async function enableLoyalty(
  tx: TestTx,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await tx.featureFlag.upsert({
    where: { key: "loyalty" },
    create: { key: "loyalty", enabled: true },
    update: { enabled: true },
  });
  const settings: Record<string, unknown> = {
    enabled: true,
    vatMode: "base_reduced",
    earnRate: 10_000,
    pointValue: 100,
    minRedeemPoints: 10,
    minCashAmount: 100,
    maxRedeemPercent: null,
    earnOnDiscountedItems: true,
    expiryMonths: 12,
    expiryWarningDays: 30,
    releasedGraceDays: 30,
    ...overrides,
  };
  for (const [name, value] of Object.entries(settings)) {
    await setSetting(tx, `loyalty.${name}`, value);
  }
}

export async function givePoints(
  tx: TestTx,
  customerId: string,
  points: number,
  expiresInDays = 365,
): Promise<void> {
  await adjustPoints(tx, {
    customerId,
    points,
    reason: "puncte de test",
    actorId: "u_test",
    expiresAt: new Date(NOW.getTime() + expiresInDays * LOYALTY_NOW_DAY),
    now: NOW,
    key: randomUUID(),
  });
}

/** Un cumpărător cu cont, programul pornit și `points` puncte în cont. */
export async function loyaltyWorld(
  h: Harness,
  points = 500,
  overrides: Record<string, unknown> = {},
): Promise<World> {
  await enableLoyalty(h.tx, overrides);
  const world = await userWorld(h);
  if (points > 0) await givePoints(h.tx, world.userId, points);
  return world;
}

/** Pune clientul într-un grup nou (tip și acumulare după argumente). */
export async function putInGroup(
  tx: TestTx,
  userId: string,
  data: {
    pricingType: "none" | "discount" | "cost_plus";
    discountBps?: number;
    markupBps?: number;
    earnsLoyaltyPoints: boolean;
  },
): Promise<void> {
  const group = await tx.customerGroup.create({
    data: { name: "Grup test", slug: `loy-${randomUUID()}`, ...data },
  });
  await tx.user.update({ where: { id: userId }, data: { customerGroupId: group.id } });
}
