import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient } from "@ecom/db";
import { parseQuantity, parseSignedDelta, type Quantity } from "@ecom/shared";
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
 * Faza 5, punctul 14: testul de concurență FINAL. Testele de concurență ale punctelor 5, 11, 12, 13 apără fiecare câte o
 * operație; aici toate operațiile de stoc rulează DEODATĂ pe aceleași rânduri (rezervare, eliberare, confirmare, angajare
 * directă, ajustare, transfer, expirare), pe Postgres REAL, cu date comise și câte o conexiune pe cerere (pool de 40),
 * ca în producție. Se verifică invariantele care trebuie să țină oricare ar fi ordinea în care s-au intercalat cererile:
 *   1. niciun deadlock și nicio altă eroare decât refuzurile de domeniu;
 *   2. nimic negativ; contoarele «rezervat» / «angajat» sunt egale cu rândurile care le justifică;
 *   3. fără supravânzare: cât timp nimic nu scade stocul fizic, «fizic − angajat − rezervat» nu coboară sub zero;
 *   4. registrul de mișcări explică exact stocul fizic (inițial + suma mișcărilor = fizic), iar transferul conservă totalul.
 */
const db = createDbClient({ max: 40 });
// Spațiul de nume al fișierului (date comise): curățarea resturilor șterge doar ce are acest prefix, nu și datele altui fișier
// rulat în paralel (15e; unic pe fișier, păzit de testul de arhitectură `stock-fixtures-namespace`).
const STOCK_NAMESPACE = "sfin";
const stock = new StockService({ db });
const transfers = new StockTransferService({
  db,
  audit: new AuditService(new MemoryAudit()),
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
    await db.warehouse.create({ data: { code: `w_${ctx.tag}f`, name: `Al doilea ${ctx.tag}` } })
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

/** Refuzurile de domeniu pe care le poate produce un amestec de operații; orice alt cod (deadlock, 40P01, 500) pică testul */
const DOMAIN_REFUSALS = [
  "STOCK_INSUFFICIENT",
  "STOCK_ADJUSTMENT_BELOW_ZERO",
  "STOCK_TRANSFER_INSUFFICIENT",
  "STOCK_RESERVATION_LOST",
];

type Outcome =
  | { kind: "ok"; op: string; adjust?: { variantId: string; delta: bigint } }
  | { kind: "refused"; code: string; message: string };

async function settle(
  op: string,
  run: () => Promise<unknown>,
  adjust?: { variantId: string; delta: bigint },
): Promise<Outcome> {
  try {
    await run();
    return { kind: "ok", op, ...(adjust && { adjust }) };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { kind: "refused", code: e.code ?? "NO_CODE", message: e.message ?? String(error) };
  }
}

const row = (variantId: string, warehouseId: string) =>
  db.inventoryItem.findUniqueOrThrow({
    where: { variantId_warehouseId: { variantId, warehouseId } },
  });

async function expectConsistent(variantId: string): Promise<void> {
  for (const warehouseId of [ctx.warehouseId, other]) {
    const check = await stock.checkConsistency(variantId, warehouseId);
    expect(
      check,
      JSON.stringify(check, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
    ).toMatchObject({ ok: true });
  }
}

/** Toate cererile pornesc în același moment; fiecare pe conexiunea și în tranzacția ei */
async function launch(
  count: number,
  make: (index: number) => Promise<Outcome>,
): Promise<Outcome[]> {
  return Promise.all(Array.from({ length: count }, (_, index) => make(index)));
}

function expectOnlyDomainRefusals(outcomes: Outcome[]): void {
  const unexpected = outcomes.filter(
    (o): o is Extract<Outcome, { kind: "refused" }> =>
      o.kind === "refused" && !DOMAIN_REFUSALS.includes(o.code),
  );
  expect(unexpected.map((o) => `${o.code}: ${o.message}`)).toEqual([]);
}

/** Face stocul scadent: rezervările active rămase devin expirate, ca după 15 minute */
async function ageActiveReservations(variantIds: string[]): Promise<void> {
  await db.$executeRaw`
    UPDATE stock_reservation
    SET "expiresAt" = now() - interval '1 minute', "createdAt" = now() - interval '20 minutes'
    WHERE status = 'active' AND "variantId" = ANY(${variantIds}::text[])`;
}

describe("amestec final: operații care NU scad stocul fizic, deodată pe două depozite", () => {
  it("rezervări, eliberări, confirmări, angajări directe și expirări (2 valuri, 240 de cereri) → fără supravânzare, contoare exacte", async () => {
    const { variants } = await addStockProduct(db, ctx, {
      variants: [{ physical: "20" }, { physical: "20" }],
    });
    for (const v of variants) {
      await db.inventoryItem.create({
        data: { variantId: v.id, warehouseId: other, physical: q("20") },
      });
    }
    const ids = variants.map((v) => v.id);
    const wave = async (offset: number): Promise<Outcome[]> =>
      launch(120, (i) => {
        const n = offset + i;
        const v = variants[n % 2]!;
        const warehouseId = n % 4 < 2 ? ctx.warehouseId : other;
        const mine = `${ctx.tag}-n${n}`;
        const earlier = `${ctx.tag}-n${n - 8}`;
        switch (n % 6) {
          case 0:
          case 1:
            return settle("reserve", () =>
              stock.reserve(
                { refType: "order", refId: mine },
                [{ variantId: v.id, warehouseId, quantity: q("1") }],
                soon(),
              ),
            );
          case 2:
            return settle("confirm", () =>
              stock.confirmReservation({ refType: "order", refId: earlier }),
            );
          case 3:
            return settle("release", () => stock.release({ refType: "order", refId: earlier }));
          case 4:
            return settle("commit", () =>
              stock.commitDirect({ refType: "order", refId: mine }, [
                { variantId: v.id, warehouseId, quantity: q("1") },
              ]),
            );
          default:
            return settle("expire", () => stock.expireDue({ variantIds: ids }));
        }
      });

    const first = await wave(0);
    await ageActiveReservations(ids);
    const second = await wave(120);
    const all = [...first, ...second];

    expectOnlyDomainRefusals(all);
    // au avut loc și reușite, și refuzuri: testul chiar a strâns stocul
    expect(all.filter((o) => o.kind === "ok").length).toBeGreaterThan(40);
    expect(all.filter((o) => o.kind === "refused").length).toBeGreaterThan(0);

    for (const v of variants) {
      for (const warehouseId of [ctx.warehouseId, other]) {
        const r = await row(v.id, warehouseId);
        expect(r.physical, "fizicul nu s-a atins").toBe(q("20"));
        expect(r.reserved).toBeGreaterThanOrEqual(0n);
        expect(r.committed).toBeGreaterThanOrEqual(0n);
        // fără supravânzare: niciodată mai mult angajat + rezervat decât există
        expect(r.physical - r.committed - r.reserved).toBeGreaterThanOrEqual(0n);
      }
      await expectConsistent(v.id);
      // fiecare angajare deschisă are exact o comandă (aceeași comandă nu angajează de două ori aceeași variantă)
      const open = await db.stockCommitment.findMany({
        where: { variantId: v.id, status: "open" },
        select: { refType: true, refId: true, warehouseId: true },
      });
      const keys = open.map((c) => `${c.refType}/${c.refId}/${c.warehouseId}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("amestec final: toate operațiile, inclusiv ajustări și transferuri, deodată", () => {
  it("rezervări, angajări, confirmări, ajustări ±, transferuri în ambele sensuri și expirări (2 valuri, 240 de cereri) → registrul explică stocul, transferul conservă totalul", async () => {
    const { variants } = await addStockProduct(db, ctx, {
      variants: [{ physical: "15" }, { physical: "15" }],
    });
    for (const v of variants) {
      await db.inventoryItem.create({
        data: { variantId: v.id, warehouseId: other, physical: q("15") },
      });
    }
    const ids = variants.map((v) => v.id);
    const wave = async (offset: number): Promise<Outcome[]> =>
      launch(120, (i) => {
        const n = offset + i;
        const v = variants[n % 2]!;
        const a = n % 4 < 2 ? ctx.warehouseId : other;
        const b = a === ctx.warehouseId ? other : ctx.warehouseId;
        const mine = `${ctx.tag}-m${n}`;
        const earlier = `${ctx.tag}-m${n - 9}`;
        switch (n % 9) {
          case 0:
            return settle("reserve", () =>
              stock.reserve(
                { refType: "order", refId: mine },
                [{ variantId: v.id, warehouseId: a, quantity: q("1") }],
                soon(),
              ),
            );
          case 1:
            return settle("confirm", () =>
              stock.confirmReservation({ refType: "order", refId: earlier }),
            );
          case 2:
            return settle("release", () => stock.release({ refType: "order", refId: earlier }));
          case 3:
            return settle("commit", () =>
              stock.commitDirect({ refType: "order", refId: mine }, [
                { variantId: v.id, warehouseId: a, quantity: q("1") },
              ]),
            );
          case 4:
            return settle(
              "sale",
              () =>
                stock.adjustPhysical({
                  variantId: v.id,
                  warehouseId: a,
                  delta: parseSignedDelta("-1"),
                  reason: "sale_in_store",
                  note: "concurență finală",
                }),
              { variantId: v.id, delta: -q("1") },
            );
          case 5:
            return settle(
              "receipt",
              () =>
                stock.adjustPhysical({
                  variantId: v.id,
                  warehouseId: b,
                  delta: parseSignedDelta("2"),
                  reason: "receipt",
                  note: "concurență finală",
                }),
              { variantId: v.id, delta: q("2") },
            );
          case 6:
          case 7:
            return settle("transfer", () =>
              transfers.transfer(owner, {
                variantId: v.id,
                fromWarehouseId: a,
                toWarehouseId: b,
                quantity: "1",
              }),
            );
          default:
            return settle("expire", () => stock.expireDue({ variantIds: ids }));
        }
      });

    const first = await wave(0);
    await ageActiveReservations(ids);
    const second = await wave(120);
    const all = [...first, ...second];

    expectOnlyDomainRefusals(all);
    const done = (op: string) => all.filter((o) => o.kind === "ok" && o.op === op).length;
    expect(done("transfer")).toBeGreaterThan(0);
    expect(done("sale") + done("receipt")).toBeGreaterThan(0);
    expect(done("reserve") + done("commit")).toBeGreaterThan(0);

    for (const v of variants) {
      const adjusted = all.reduce(
        (sum, o) => (o.kind === "ok" && o.adjust?.variantId === v.id ? sum + o.adjust.delta : sum),
        0n,
      );
      let totalPhysical = 0n;
      for (const warehouseId of [ctx.warehouseId, other]) {
        const r = await row(v.id, warehouseId);
        expect(r.physical).toBeGreaterThanOrEqual(0n);
        expect(r.reserved).toBeGreaterThanOrEqual(0n);
        expect(r.committed).toBeGreaterThanOrEqual(0n);
        totalPhysical += r.physical;
        // registrul explică exact stocul: inițial (15) + suma mișcărilor fizice din acest depozit
        const moved = await db.stockMovement.aggregate({
          _sum: { deltaPhysical: true },
          where: { variantId: v.id, warehouseId },
        });
        expect(r.physical, "fizic = inițial + mișcări").toBe(
          q("15") + (moved._sum.deltaPhysical ?? 0n),
        );
      }
      // transferul doar mută: totalul = inițial + ajustările reușite
      expect(totalPhysical).toBe(q("30") + adjusted);
      await expectConsistent(v.id);
    }

    // fiecare transfer reușit are exact o ieșire și o intrare cu aceeași referință, de sumă zero
    const moves = await db.stockMovement.findMany({
      where: { variantId: { in: ids }, refType: TRANSFER_REF_TYPE },
      select: { kind: true, refId: true, deltaPhysical: true },
    });
    const byRef = new Map<string, string[]>();
    for (const m of moves) byRef.set(m.refId ?? "", [...(byRef.get(m.refId ?? "") ?? []), m.kind]);
    expect(byRef.size).toBe(done("transfer"));
    for (const kinds of byRef.values())
      expect(kinds.sort()).toEqual(["transfer_in", "transfer_out"]);
    expect(moves.reduce((sum, m) => sum + m.deltaPhysical, 0n)).toBe(0n);
  });
});
