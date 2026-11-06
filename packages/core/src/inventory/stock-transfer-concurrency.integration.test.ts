import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient } from "@ecom/db";
import { parseQuantity, type Quantity } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { MemoryAudit } from "../test-utils/memory-audit";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
  purgeStockLeftovers,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { StockService } from "./stock-service";
import { StockTransferService, TRANSFER_REF_TYPE } from "./stock-transfer";

/**
 * Faza 5, punctul 13b: concurența transferului pe Postgres REAL, cu date COMISE (fiecare cerere în tranzacția și pe conexiunea
 * ei, pool de 40, ca în producție). Invariantele pe care le păzește: cantitatea totală dintr-o pereche de depozite se
 * conservă, nimic nu devine negativ, nicio rezervare nu se pierde, transferurile în sens opus nu se blochează reciproc (nicio
 * eroare de deadlock nu ajunge la apelant), iar contoarele rămân egale cu rândurile care le justifică.
 */
const db = createDbClient({ max: 40 });
// Spațiul de nume al fișierului (date comise): curățarea resturilor șterge doar ce are acest prefix, nu și datele altui fișier
// rulat în paralel (15e; unic pe fișier, păzit de testul de arhitectură `stock-fixtures-namespace`).
const STOCK_NAMESPACE = "strf";
const stock = new StockService({ db });
const audit = new MemoryAudit();
const service = new StockTransferService({
  db,
  audit: new AuditService(audit),
  isEnabled: async () => true,
});
const owner: PermissionSubject = {
  userId: "user-owner",
  email: "owner@test.invalid",
  roles: ["owner"],
  permissions: new Set(),
};

let ctx: StockContext;
let other: string;

beforeAll(async () => {
  await purgeStockLeftovers(db, STOCK_NAMESPACE);
});

beforeEach(async () => {
  ctx = await createStockContext(db, { namespace: STOCK_NAMESPACE });
  other = (
    await db.warehouse.create({ data: { code: `w_${ctx.tag}b`, name: `Destinație ${ctx.tag}` } })
  ).id;
});

afterEach(async () => {
  await purgeStockContext(db, ctx);
  await db.warehouse.delete({ where: { id: other } });
});

afterAll(async () => {
  await purgeStockLeftovers(db, STOCK_NAMESPACE);
  await db.$disconnect();
});

const q = (text: string): Quantity => parseQuantity(text);
const soon = (): Date => new Date(Date.now() + 15 * 60_000);

async function race<T>(count: number, fn: (index: number) => Promise<T>) {
  const settled = await Promise.allSettled(Array.from({ length: count }, (_, index) => fn(index)));
  const ok: T[] = [];
  const failed: Array<{ code?: string; message: string }> = [];
  for (const result of settled) {
    if (result.status === "fulfilled") ok.push(result.value);
    else failed.push(result.reason as { code?: string; message: string });
  }
  return { ok, failed };
}

/** Toate eșecurile au un cod din lista dată (un deadlock sau o altă eroare scăpată la apelant ar apărea aici) */
function expectOnlyCodes(
  failed: Array<{ code?: string; message: string }>,
  allowed: string[],
): void {
  const unexpected = failed.filter((f) => !allowed.includes(f.code ?? ""));
  expect(unexpected.map((f) => `${f.code}: ${f.message}`)).toEqual([]);
}

const transfer = (variantId: string, from: string, to: string, quantity: string) =>
  service.transfer(owner, {
    variantId,
    fromWarehouseId: from,
    toWarehouseId: to,
    quantity,
  });

const row = (variantId: string, warehouseId: string) =>
  db.inventoryItem.findUnique({ where: { variantId_warehouseId: { variantId, warehouseId } } });

async function totalPhysical(variantId: string): Promise<bigint> {
  const rows = await db.inventoryItem.findMany({
    where: { variantId, warehouseId: { in: [ctx.warehouseId, other] } },
  });
  return rows.reduce((sum, r) => sum + r.physical, 0n);
}

async function expectConsistent(variantId: string): Promise<void> {
  for (const warehouseId of [ctx.warehouseId, other]) {
    const check = await stock.checkConsistency(variantId, warehouseId);
    expect(
      check,
      JSON.stringify(check, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
    ).toMatchObject({ ok: true });
  }
}

/** Mișcările transferurilor: câte intrări și ieșiri, și că fiecare referință are exact una din fiecare */
async function expectLinkedMovements(variantId: string, expectedPairs: number): Promise<void> {
  const moves = await db.stockMovement.findMany({
    where: { variantId, refType: TRANSFER_REF_TYPE },
    select: { kind: true, refId: true, deltaPhysical: true },
  });
  expect(moves).toHaveLength(expectedPairs * 2);
  const byRef = new Map<string, string[]>();
  for (const m of moves) byRef.set(m.refId ?? "", [...(byRef.get(m.refId ?? "") ?? []), m.kind]);
  expect(byRef.size).toBe(expectedPairs);
  for (const kinds of byRef.values()) expect(kinds.sort()).toEqual(["transfer_in", "transfer_out"]);
  expect(moves.reduce((sum, m) => sum + m.deltaPhysical, 0n)).toBe(0n);
}

describe("transferuri simultane în sens opus între aceleași două depozite", () => {
  it("30 + 30 de transferuri de 1, stoc 100 în fiecare depozit → toate reușesc, fără deadlock, totalul se conservă", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "100" }] });
    const v = variants[0]!;
    await db.inventoryItem.create({
      data: { variantId: v.id, warehouseId: other, physical: q("100") },
    });
    const { ok, failed } = await race(60, (i) =>
      i % 2 === 0
        ? transfer(v.id, ctx.warehouseId, other, "1")
        : transfer(v.id, other, ctx.warehouseId, "1"),
    );
    expect(failed.map((f) => `${f.code}: ${f.message}`)).toEqual([]);
    expect(ok).toHaveLength(60);
    expect((await row(v.id, ctx.warehouseId))?.physical).toBe(q("100"));
    expect((await row(v.id, other))?.physical).toBe(q("100"));
    expect(await totalPhysical(v.id)).toBe(q("200"));
    await expectLinkedMovements(v.id, 60);
    await expectConsistent(v.id);
  });

  it("stoc strâns (10 + 10), 25 de fiecare parte: unele pică cu «stoc insuficient», nimic altceva; totalul se conservă, nimic negativ", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "10" }] });
    const v = variants[0]!;
    await db.inventoryItem.create({
      data: { variantId: v.id, warehouseId: other, physical: q("10") },
    });
    const { ok, failed } = await race(50, (i) =>
      i % 2 === 0
        ? transfer(v.id, ctx.warehouseId, other, "1")
        : transfer(v.id, other, ctx.warehouseId, "1"),
    );
    expectOnlyCodes(failed, ["STOCK_TRANSFER_INSUFFICIENT"]);
    expect(ok.length + failed.length).toBe(50);
    expect(ok.length).toBeGreaterThanOrEqual(20); // măcar cele 10 + 10 care au stoc de la început
    const a = (await row(v.id, ctx.warehouseId))!.physical;
    const b = (await row(v.id, other))!.physical;
    expect(a).toBeGreaterThanOrEqual(0n);
    expect(b).toBeGreaterThanOrEqual(0n);
    expect(a + b).toBe(q("20"));
    await expectLinkedMovements(v.id, ok.length);
    await expectConsistent(v.id);
  });

  it("două variante transferate încrucișat deodată (V1 A→B și V2 B→A, de multe ori) → fără deadlock", async () => {
    const one = (await addStockProduct(db, ctx, { variants: [{ physical: "50" }] })).variants[0]!;
    const two = (await addStockProduct(db, ctx, { variants: [{ physical: "50" }] })).variants[0]!;
    await db.inventoryItem.update({
      where: { variantId_warehouseId: { variantId: two.id, warehouseId: ctx.warehouseId } },
      data: { physical: 0n },
    });
    await db.inventoryItem.create({
      data: { variantId: two.id, warehouseId: other, physical: q("50") },
    });
    await db.inventoryItem.create({
      data: { variantId: one.id, warehouseId: other, physical: 0n },
    });
    const { ok, failed } = await race(40, (i) =>
      i % 2 === 0
        ? transfer(one.id, ctx.warehouseId, other, "1")
        : transfer(two.id, other, ctx.warehouseId, "1"),
    );
    expect(failed.map((f) => `${f.code}: ${f.message}`)).toEqual([]);
    expect(ok).toHaveLength(40);
    expect(await totalPhysical(one.id)).toBe(q("50"));
    expect(await totalPhysical(two.id)).toBe(q("50"));
    expect((await row(one.id, other))?.physical).toBe(q("20"));
    expect((await row(two.id, ctx.warehouseId))?.physical).toBe(q("20"));
  });
});

describe("transferuri simultane din aceeași sursă", () => {
  it("12 transferuri de 1 din sursa cu stoc 5 → exact 5 reușesc, 7 pică cu «stoc insuficient»; destinația are exact 5", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "5" }] });
    const v = variants[0]!;
    const { ok, failed } = await race(12, () => transfer(v.id, ctx.warehouseId, other, "1"));
    expect(ok).toHaveLength(5);
    expect(failed).toHaveLength(7);
    expect(new Set(failed.map((f) => f.code))).toEqual(new Set(["STOCK_TRANSFER_INSUFFICIENT"]));
    expect((await row(v.id, ctx.warehouseId))?.physical).toBe(0n);
    expect((await row(v.id, other))?.physical).toBe(q("5"));
    expect(await db.inventoryItem.count({ where: { variantId: v.id } })).toBe(2);
    await expectLinkedMovements(v.id, 5);
    await expectConsistent(v.id);
  });

  it("destinația nu are rând: 10 transferuri deodată creează un singur rând, fără pierderi", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "10" }] });
    const v = variants[0]!;
    const { ok, failed } = await race(10, () => transfer(v.id, ctx.warehouseId, other, "1"));
    expect(failed.map((f) => `${f.code}: ${f.message}`)).toEqual([]);
    expect(ok).toHaveLength(10);
    expect(await db.inventoryItem.count({ where: { variantId: v.id, warehouseId: other } })).toBe(
      1,
    );
    expect((await row(v.id, other))?.physical).toBe(q("10"));
    expect((await row(v.id, ctx.warehouseId))?.physical).toBe(0n);
  });

  it("cantități zecimale: 10 transferuri de 0,3 din 1,0 → exact 3", async () => {
    const { variants } = await addStockProduct(db, ctx, {
      step: "0,3",
      variants: [{ physical: "1" }],
    });
    const v = variants[0]!;
    const { ok, failed } = await race(10, () => transfer(v.id, ctx.warehouseId, other, "0,3"));
    expect(ok).toHaveLength(3);
    expect(new Set(failed.map((f) => f.code))).toEqual(new Set(["STOCK_TRANSFER_INSUFFICIENT"]));
    expect((await row(v.id, ctx.warehouseId))?.physical).toBe(q("0,1"));
    expect((await row(v.id, other))?.physical).toBe(q("0,9"));
  });
});

describe("transferuri și rezervări simultane pe aceeași sursă", () => {
  it("15 transferuri de 1 și 15 rezervări de 1 pe stoc 10 → exact 10 reușesc în total; nimic nu se pierde", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "10" }] });
    const v = variants[0]!;
    const { ok, failed } = await race(30, (i) =>
      i % 2 === 0
        ? transfer(v.id, ctx.warehouseId, other, "1").then(() => "transfer" as const)
        : stock
            .reserve(
              { refType: "order", refId: `${ctx.tag}-r${i}` },
              [{ variantId: v.id, warehouseId: ctx.warehouseId, quantity: q("1") }],
              soon(),
            )
            .then(() => "reserve" as const),
    );
    expect(ok).toHaveLength(10);
    expect(failed).toHaveLength(20);
    expectOnlyCodes(failed, ["STOCK_TRANSFER_INSUFFICIENT", "STOCK_INSUFFICIENT"]);
    const transfers = ok.filter((x) => x === "transfer").length;
    const reservations = ok.filter((x) => x === "reserve").length;
    const source = (await row(v.id, ctx.warehouseId))!;
    // fizic + ce a plecat = 10; rezervat = rezervările reușite; disponibil = 0
    expect(source.physical).toBe(q("10") - q(String(transfers)));
    expect(source.reserved).toBe(q(String(reservations)));
    expect(source.physical - source.committed - source.reserved).toBe(0n);
    expect((await row(v.id, other))?.physical ?? 0n).toBe(q(String(transfers)));
    expect(await db.stockReservation.count({ where: { variantId: v.id, status: "active" } })).toBe(
      reservations,
    );
    await expectLinkedMovements(v.id, transfers);
    await expectConsistent(v.id);
  });

  it("transfer cât disponibilul și rezervare cât disponibilul, deodată → una singură reușește, niciodată ambele", async () => {
    for (let round = 0; round < 5; round++) {
      const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "3" }] });
      const v = variants[0]!;
      const { ok } = await race(2, (i) =>
        i === 0
          ? transfer(v.id, ctx.warehouseId, other, "3").then(() => "transfer" as const)
          : stock
              .reserve(
                { refType: "order", refId: `${ctx.tag}-x${round}` },
                [{ variantId: v.id, warehouseId: ctx.warehouseId, quantity: q("3") }],
                soon(),
              )
              .then(() => "reserve" as const),
      );
      expect(ok, `runda ${round}`).toHaveLength(1);
      const source = (await row(v.id, ctx.warehouseId))!;
      expect(source.physical - source.committed - source.reserved).toBeGreaterThanOrEqual(0n);
      await expectConsistent(v.id);
    }
  });
});
