import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient } from "@ecom/db";
import { formatQuantity, parseQuantity, parseSignedDelta, type Quantity } from "@ecom/shared";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
  purgeStockLeftovers,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { StockService, type LineOutcome } from "./stock-service";

/**
 * Faza 5, punctul 5: concurența pe Postgres REAL. Datele sunt COMISE și fiecare cerere rulează în tranzacția ei, pe
 * conexiunea ei (pool de 40), exact ca în producție. Fiecare scenariu verifică rezultatul ȘI invariantele (contoarele
 * `reserved`/`committed` sunt egale cu sumele rândurilor care le justifică; nimic negativ).
 */
const db = createDbClient({ max: 40 });
const service = new StockService({ db });

let ctx: StockContext;

// Datele sunt comise: un rest al unei rulări întrerupte ar fi văzut de testele altor fișiere (ex. exportul numără produsele).
beforeAll(async () => {
  await purgeStockLeftovers(db);
});

beforeEach(async () => {
  ctx = await createStockContext(db);
});

afterEach(async () => {
  await purgeStockContext(db, ctx);
});

afterAll(async () => {
  await purgeStockLeftovers(db);
  await db.$disconnect();
});

const q = (text: string): Quantity => parseQuantity(text);
const soon = (): Date => new Date(Date.now() + 15 * 60_000);
const ref = (name: string) => ({ refType: "order", refId: `${ctx.tag}-${name}` });
const line = (variantId: string, quantity: string) => ({
  variantId,
  warehouseId: ctx.warehouseId,
  quantity: q(quantity),
});

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

const item = (variantId: string) =>
  db.inventoryItem.findUniqueOrThrow({
    where: { variantId_warehouseId: { variantId, warehouseId: ctx.warehouseId } },
  });

async function expectConsistent(variantId: string): Promise<void> {
  const check = await service.checkConsistency(variantId, ctx.warehouseId);
  expect(
    check,
    JSON.stringify(check, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
  ).toMatchObject({
    ok: true,
  });
}

const outcomes = (results: LineOutcome[][]): string[] => results.flat().map((o) => o.outcome);

describe("rezervare: nicio supravânzare", () => {
  it("10 cereri deodată pe ultima bucată → una singură reușește", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "1" }] });
    const v = variants[0]!;
    const { ok, failed } = await race(10, (i) =>
      service.reserve(ref(`r${i}`), [line(v.id, "1")], soon()),
    );
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(9);
    expect(new Set(failed.map((f) => f.code))).toEqual(new Set(["STOCK_INSUFFICIENT"]));
    const row = await item(v.id);
    expect(row.reserved).toBe(q("1"));
    expect(await db.stockReservation.count({ where: { variantId: v.id, status: "active" } })).toBe(
      1,
    );
    expect(await db.stockReservation.count({ where: { variantId: v.id } })).toBe(1);
    await expectConsistent(v.id);
  });

  it("100 de cereri deodată pe stoc 10 → exact 10 reușesc", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "10" }] });
    const v = variants[0]!;
    const { ok, failed } = await race(100, (i) =>
      service.reserve(ref(`r${i}`), [line(v.id, "1")], soon()),
    );
    expect(ok).toHaveLength(10);
    expect(failed).toHaveLength(90);
    expect(failed.every((f) => f.code === "STOCK_INSUFFICIENT")).toBe(true);
    expect((await item(v.id)).reserved).toBe(q("10"));
    expect(await db.stockReservation.count({ where: { variantId: v.id, status: "active" } })).toBe(
      10,
    );
    await expectConsistent(v.id);
  });

  it("cantități zecimale: 10 cereri de 0,3 pe stoc 1,0 → exact 3, rămân 0,1", async () => {
    const { variants } = await addStockProduct(db, ctx, {
      step: "0,3",
      variants: [{ physical: "1" }],
    });
    const v = variants[0]!;
    const { ok, failed } = await race(10, (i) =>
      service.reserve(ref(`z${i}`), [line(v.id, "0,3")], soon()),
    );
    expect(ok).toHaveLength(3);
    expect(failed.every((f) => f.code === "STOCK_INSUFFICIENT")).toBe(true);
    const row = await item(v.id);
    expect(formatQuantity(row.reserved as Quantity)).toBe("0,9");
    expect(formatQuantity((row.physical - row.reserved) as Quantity)).toBe("0,1");
    await expectConsistent(v.id);
  });

  it("liner: 5 cereri de câte o rolă (41,25 mp) pe 100 mp → exact 2", async () => {
    const { variants } = await addStockProduct(db, ctx, {
      step: "41,25",
      variants: [{ physical: "100" }],
    });
    const v = variants[0]!;
    const { ok } = await race(5, (i) =>
      service.reserve(ref(`l${i}`), [line(v.id, "41,25")], soon()),
    );
    expect(ok).toHaveLength(2);
    expect(formatQuantity((await item(v.id)).reserved as Quantity)).toBe("82,5");
    await expectConsistent(v.id);
  });

  it("cereri de mai mulți pași deodată: 6 × (2 pași de 2,03) pe 10 mp → exact 2 reușesc (4 pași = 8,12)", async () => {
    const { variants } = await addStockProduct(db, ctx, {
      step: "2,03",
      variants: [{ physical: "10" }],
    });
    const v = variants[0]!;
    const { ok } = await race(6, (i) =>
      service.reserve(ref(`m${i}`), [line(v.id, "4,06")], soon()),
    );
    expect(ok).toHaveLength(2);
    expect(formatQuantity((await item(v.id)).reserved as Quantity)).toBe("8,12");
    await expectConsistent(v.id);
  });

  it("un multiplu greșit al pasului se refuză chiar dacă stocul ajunge (0,4 cu pasul 0,3)", async () => {
    const { variants } = await addStockProduct(db, ctx, {
      step: "0,3",
      variants: [{ physical: "10" }],
    });
    const v = variants[0]!;
    const { ok, failed } = await race(5, (i) =>
      service.reserve(ref(`p${i}`), [line(v.id, "0,4")], soon()),
    );
    expect(ok).toHaveLength(0);
    expect(new Set(failed.map((f) => f.code))).toEqual(new Set(["QUANTITY_NOT_MULTIPLE_OF_STEP"]));
    expect((await item(v.id)).reserved).toBe(0n);
    expect(await db.stockReservation.count({ where: { variantId: v.id } })).toBe(0);
    // 0,6 = 2 pași se acceptă
    await service.reserve(ref("ok"), [line(v.id, "0,6")], soon());
    expect(formatQuantity((await item(v.id)).reserved as Quantity)).toBe("0,6");
  });

  it("tamponul de siguranță nu se vinde: stoc 5, tampon 3 → exact 2 din 10 cereri", async () => {
    const { variants } = await addStockProduct(db, ctx, {
      variants: [{ physical: "5", buffer: "3" }],
    });
    const v = variants[0]!;
    const { ok } = await race(10, (i) => service.reserve(ref(`b${i}`), [line(v.id, "1")], soon()));
    expect(ok).toHaveLength(2);
    await expectConsistent(v.id);
  });
});

describe("rezervare: idempotență (aceeași comandă, apeluri repetate sau simultane)", () => {
  it("aceeași comandă rezervată de 6 ori deodată → o singură rezervare, restul «already_reserved»", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "5" }] });
    const v = variants[0]!;
    const { ok, failed } = await race(6, () =>
      service.reserve(ref("aceeasi"), [line(v.id, "2")], soon()),
    );
    expect(failed).toHaveLength(0);
    const kinds = outcomes(ok);
    expect(kinds.filter((k) => k === "reserved")).toHaveLength(1);
    expect(kinds.filter((k) => k === "already_reserved")).toHaveLength(5);
    expect((await item(v.id)).reserved).toBe(q("2"));
    expect(await db.stockReservation.count({ where: { variantId: v.id } })).toBe(1);
    await expectConsistent(v.id);
  });
});

describe("coșuri cu mai multe linii", () => {
  it("coșuri în ordine inversă (A,B și B,A), stoc suficient → niciun deadlock, toate reușesc", async () => {
    const { variants } = await addStockProduct(db, ctx, {
      variants: [{ physical: "1000" }, { physical: "1000" }],
    });
    const [a, b] = [variants[0]!, variants[1]!];
    const { ok, failed } = await race(60, (i) =>
      service.reserve(
        ref(`c${i}`),
        i % 2 === 0 ? [line(a.id, "1"), line(b.id, "1")] : [line(b.id, "1"), line(a.id, "1")],
        soon(),
      ),
    );
    expect(failed.map((f) => f.message)).toEqual([]);
    expect(ok).toHaveLength(60);
    expect((await item(a.id)).reserved).toBe(q("60"));
    expect((await item(b.id)).reserved).toBe(q("60"));
    await expectConsistent(a.id);
    await expectConsistent(b.id);
  });

  it("stoc 1 + 1 și coșuri A,B / B,A deodată → un singur coș reușește întreg; niciun rest parțial", async () => {
    const { variants } = await addStockProduct(db, ctx, {
      variants: [{ physical: "1" }, { physical: "1" }],
    });
    const [a, b] = [variants[0]!, variants[1]!];
    const { ok, failed } = await race(20, (i) =>
      service.reserve(
        ref(`s${i}`),
        i % 2 === 0 ? [line(a.id, "1"), line(b.id, "1")] : [line(b.id, "1"), line(a.id, "1")],
        soon(),
      ),
    );
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(19);
    expect(failed.every((f) => f.code === "STOCK_INSUFFICIENT")).toBe(true);
    expect((await item(a.id)).reserved).toBe(q("1"));
    expect((await item(b.id)).reserved).toBe(q("1"));
    expect(await db.stockReservation.count({ where: { variantId: { in: [a.id, b.id] } } })).toBe(2);
    await expectConsistent(a.id);
    await expectConsistent(b.id);
  });

  it("o linie nu încape → toate liniile coșului se anulează (A are stoc, B nu)", async () => {
    const { variants } = await addStockProduct(db, ctx, {
      variants: [{ physical: "10" }, { physical: "0" }],
    });
    const [a, b] = [variants[0]!, variants[1]!];
    const { ok, failed } = await race(8, (i) =>
      service.reserve(ref(`t${i}`), [line(a.id, "1"), line(b.id, "1")], soon()),
    );
    expect(ok).toHaveLength(0);
    expect(failed).toHaveLength(8);
    expect((await item(a.id)).reserved).toBe(0n);
    expect(await db.stockReservation.count({ where: { variantId: { in: [a.id, b.id] } } })).toBe(0);
  });
});

describe("confirmarea plății: webhook dublu", () => {
  it("8 confirmări simultane ale aceleiași comenzi → o singură angajare", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "5" }] });
    const v = variants[0]!;
    await service.reserve(ref("plata"), [line(v.id, "2")], soon());
    const { ok, failed } = await race(8, () => service.confirmReservation(ref("plata")));
    expect(failed.map((f) => f.message)).toEqual([]);
    const kinds = outcomes(ok);
    expect(kinds.filter((k) => k === "committed")).toHaveLength(1);
    expect(kinds.filter((k) => k === "already_committed")).toHaveLength(7);
    const row = await item(v.id);
    expect(row.committed).toBe(q("2"));
    expect(row.reserved).toBe(0n);
    expect(await db.stockCommitment.count({ where: { variantId: v.id } })).toBe(1);
    expect(await db.stockMovement.count({ where: { variantId: v.id, kind: "commit" } })).toBe(1);
    expect(
      await db.stockReservation.count({ where: { variantId: v.id, status: "confirmed" } }),
    ).toBe(1);
    await expectConsistent(v.id);
  });
});

describe("confirmare simultană cu expirarea", () => {
  it("25 de curse confirmare ↔ job de expirare: de fiecare dată se angajează EXACT o dată, nimic scurs", async () => {
    for (let round = 0; round < 25; round++) {
      const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "3" }] });
      const v = variants[0]!;
      const r = ref(`cursa${round}`);
      // rezervare deja expirată, dar încă neeliberată de job
      await service.reserve(r, [line(v.id, "1")], new Date(Date.now() - 1_000));
      const { failed } = await race(2, async (i) =>
        i === 0
          ? await service.confirmReservation(r)
          : await service.expireDue({ variantIds: [v.id] }),
      );
      expect(
        failed.map((f) => f.message),
        `runda ${round}`,
      ).toEqual([]);
      const row = await item(v.id);
      expect(row.committed, `runda ${round}: angajat`).toBe(q("1"));
      expect(row.reserved, `runda ${round}: rezervat`).toBe(0n);
      expect(await db.stockCommitment.count({ where: { variantId: v.id, status: "open" } })).toBe(
        1,
      );
      expect(await db.stockMovement.count({ where: { variantId: v.id, kind: "commit" } })).toBe(1);
      await expectConsistent(v.id);
    }
  });

  it("expirarea câștigă și stocul e luat de altcineva → confirmarea eșuează curat, fără scădere dublă", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "1" }] });
    const v = variants[0]!;
    await service.reserve(ref("veche"), [line(v.id, "1")], new Date(Date.now() - 1_000));
    await service.expireDue({ variantIds: [v.id] });
    await service.reserve(ref("noua"), [line(v.id, "1")], soon()); // altcineva ia ultima bucată
    const { ok, failed } = await race(4, () => service.confirmReservation(ref("veche")));
    expect(ok).toHaveLength(0);
    expect(new Set(failed.map((f) => f.code))).toEqual(new Set(["STOCK_RESERVATION_LOST"]));
    const row = await item(v.id);
    expect(row.committed).toBe(0n);
    expect(row.reserved).toBe(q("1"));
    await expectConsistent(v.id);
  });

  it("4 joburi de expirare deodată → fiecare rezervare se eliberează o singură dată", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "10" }] });
    const v = variants[0]!;
    // expiră la scurt timp după creare (rezervările următoare ar elibera-o ele însele dacă ar fi deja expirate)
    const soonExpired = new Date(Date.now() + 1_500);
    for (let i = 0; i < 6; i++) await service.reserve(ref(`e${i}`), [line(v.id, "1")], soonExpired);
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    const { ok, failed } = await race(4, () => service.expireDue({ variantIds: [v.id] }));
    expect(failed).toHaveLength(0);
    expect(ok.reduce((n, r) => n + r.expired, 0)).toBe(6);
    expect((await item(v.id)).reserved).toBe(0n);
    expect(await db.stockReservation.count({ where: { variantId: v.id, status: "expired" } })).toBe(
      6,
    );
    await expectConsistent(v.id);
  });

  it("eliberarea rezervării ↔ plata în același timp (20 de curse): plata câștigă mereu, stocul se angajează o singură dată", async () => {
    for (let round = 0; round < 20; round++) {
      const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "2" }] });
      const v = variants[0]!;
      const r = ref(`anulare${round}`);
      await service.reserve(r, [line(v.id, "1")], soon());
      const { failed } = await race(2, async (i) =>
        i === 0 ? await service.confirmReservation(r) : await service.release(r),
      );
      // dacă eliberarea câștigă, confirmarea reia cantitatea (stoc există); dacă confirmarea câștigă, eliberarea găsește 0
      expect(
        failed.map((f) => f.message),
        `runda ${round}`,
      ).toEqual([]);
      const row = await item(v.id);
      expect(row.committed, `runda ${round}: angajat`).toBe(q("1"));
      expect(row.reserved, `runda ${round}: rezervat`).toBe(0n);
      expect(await db.stockCommitment.count({ where: { variantId: v.id, status: "open" } })).toBe(
        1,
      );
      expect(await db.stockMovement.count({ where: { variantId: v.id, kind: "commit" } })).toBe(1);
      await expectConsistent(v.id);
    }
  });
});

describe("angajare directă (ramburs: scade imediat la plasare)", () => {
  it("10 comenzi deodată pe ultima bucată → una singură se angajează", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "1" }] });
    const v = variants[0]!;
    const { ok, failed } = await race(10, (i) =>
      service.commitDirect(ref(`ram${i}`), [line(v.id, "1")]),
    );
    expect(ok).toHaveLength(1);
    expect(failed.every((f) => f.code === "STOCK_INSUFFICIENT")).toBe(true);
    expect((await item(v.id)).committed).toBe(q("1"));
    expect(await db.stockCommitment.count({ where: { variantId: v.id } })).toBe(1);
    await expectConsistent(v.id);
  });

  it("aceeași comandă angajată de 5 ori deodată → o singură angajare", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "5" }] });
    const v = variants[0]!;
    const { ok, failed } = await race(5, () =>
      service.commitDirect(ref("dubla"), [line(v.id, "2")]),
    );
    expect(failed).toHaveLength(0);
    const kinds = outcomes(ok);
    expect(kinds.filter((k) => k === "committed")).toHaveLength(1);
    expect(kinds.filter((k) => k === "already_committed")).toHaveLength(4);
    expect((await item(v.id)).committed).toBe(q("2"));
    await expectConsistent(v.id);
  });
});

describe("poza SmartBill față de rezervări și facturi", () => {
  async function snapshot(takenAt: Date) {
    const row = await db.stockSnapshot.create({
      data: { warehouseId: ctx.warehouseId, takenAt, source: "import" },
    });
    ctx.snapshotIds.push(row.id);
    return row.id;
  }

  it("poză aplicată în timp ce 10 clienți rezervă: contoare coerente, rezervări după poză respectă fizicul nou", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "5" }] });
    const v = variants[0]!;
    const snapshotId = await snapshot(new Date());
    const { ok } = await race(11, async (i) =>
      i === 10
        ? await service.applySnapshot({
            variantId: v.id,
            warehouseId: ctx.warehouseId,
            snapshotId,
            quantity: q("3"),
            takenAt: new Date(),
            safetyWindowMinutes: 30,
          })
        : await service.reserve(ref(`pz${i}`), [line(v.id, "1")], soon()),
    );
    const reserves = ok.filter((r): r is LineOutcome[] => Array.isArray(r));
    expect(reserves.length).toBeGreaterThanOrEqual(3);
    expect(reserves.length).toBeLessThanOrEqual(5);
    const row = await item(v.id);
    expect(row.physical).toBe(q("3"));
    expect(row.reserved).toBe(BigInt(reserves.length) * q("1"));
    await expectConsistent(v.id);
  });

  it("factura marcată ↔ poza aplicată deodată: comanda e oglindită SAU rămâne angajată, niciodată scăzută de două ori", async () => {
    for (let round = 0; round < 15; round++) {
      const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "5" }] });
      const v = variants[0]!;
      const r = ref(`fact${round}`);
      await service.commitDirect(r, [line(v.id, "1")]);
      const photoAt = new Date();
      const snapshotId = await snapshot(photoAt);
      const invoicedAt = new Date(photoAt.getTime() - 2 * 3_600_000);
      const { failed } = await race(2, async (i) =>
        i === 0
          ? await service.markInvoiced(r, invoicedAt)
          : await service.applySnapshot({
              variantId: v.id,
              warehouseId: ctx.warehouseId,
              snapshotId,
              quantity: q("4"), // SmartBill: 5 − 1 facturată
              takenAt: photoAt,
              safetyWindowMinutes: 30,
            }),
      );
      expect(
        failed.map((f) => f.message),
        `runda ${round}`,
      ).toEqual([]);
      const row = await item(v.id);
      const commitment = await db.stockCommitment.findFirstOrThrow({ where: { variantId: v.id } });
      expect(row.physical).toBe(q("4"));
      if (commitment.status === "mirrored") expect(row.committed, `runda ${round}`).toBe(0n);
      else {
        expect(commitment.status).toBe("open");
        expect(row.committed, `runda ${round}`).toBe(q("1"));
      }
      await expectConsistent(v.id);
      // o poză ulterioară, cu factura deja marcată, o oglindește oricum
      const later = await snapshot(new Date(photoAt.getTime() + 60_000));
      await service.applySnapshot({
        variantId: v.id,
        warehouseId: ctx.warehouseId,
        snapshotId: later,
        quantity: q("4"),
        takenAt: new Date(photoAt.getTime() + 60_000),
        safetyWindowMinutes: 30,
      });
      expect((await item(v.id)).committed, `runda ${round}: după poza următoare`).toBe(0n);
      await expectConsistent(v.id);
    }
  });
});

describe("igiena datelor comise", () => {
  it("un context rămas la jumătate (test întrerupt) este șters complet de purgeStockLeftovers", async () => {
    const orphan = await createStockContext(db);
    const added = await addStockProduct(db, orphan, { variants: [{ physical: "5" }] });
    await service.reserve(
      { refType: "order", refId: `${orphan.tag}-rest` },
      [{ variantId: added.variants[0]!.id, warehouseId: orphan.warehouseId, quantity: q("2") }],
      soon(),
    );
    const traces = async () => ({
      products: await db.product.count({ where: { slug: { startsWith: "st-" } } }),
      reservations: await db.stockReservation.count({
        where: { refId: { startsWith: orphan.tag } },
      }),
      warehouses: await db.warehouse.count({ where: { code: { startsWith: "w_" } } }),
      units: await db.measureUnit.count({ where: { code: { startsWith: "u_" } } }),
    });
    const protectedBefore = await protectedCounts();
    expect((await traces()).products).toBeGreaterThan(0);
    await purgeStockLeftovers(db);
    expect(await traces()).toEqual({ products: 0, reservations: 0, warehouses: 0, units: 0 });
    // depozitul implicit și unitățile de sistem (câte or fi: baza poate fi seed-uită sau doar migrată) nu se ating
    expect(await protectedCounts()).toEqual(protectedBefore);
  });

  it("purgeStockLeftovers nu șterge un depozit implicit sau o unitate de sistem, nici când codurile lor seamănă cu ale fixture-ului", async () => {
    // Sentinele cu prefixele pe care curăță funcția (w_, u_). Doar filtrele (isDefault = false, isSystem = false) le
    // salvează: fără ele, triggerele din bază resping ștergerea și curățarea aruncă. Independent de seed: dacă baza
    // are deja un depozit implicit (indexul unic permite unul singur), îl scoatem TEMPORAR din rol și îl repunem la final.
    const seededDefault = await db.warehouse.findFirst({ where: { isDefault: true } });
    if (seededDefault) {
      await db.warehouse.update({ where: { id: seededDefault.id }, data: { isDefault: false } });
    }
    const defaultsBefore = await protectedCounts();
    let warehouseId: string | undefined;
    let unitId: string | undefined;
    try {
      warehouseId = (
        await db.warehouse.create({
          data: { code: `w_sentinela${ctx.tag}`, name: "Sentinelă implicit", isDefault: true },
        })
      ).id;
      unitId = (
        await db.measureUnit.create({
          data: {
            code: `u_sentinela${ctx.tag}`,
            name: "Sentinelă sistem",
            symbol: "s",
            decimals: 0,
            isSystem: true,
          },
        })
      ).id;
      await purgeStockLeftovers(db);
      expect(await db.warehouse.findUnique({ where: { id: warehouseId } })).not.toBeNull();
      expect(await db.measureUnit.findUnique({ where: { id: unitId } })).not.toBeNull();
    } finally {
      // triggerele din bază nu lasă să dispară un depozit implicit sau o unitate de sistem: întâi le scoatem din rol
      if (warehouseId) {
        await db.warehouse.update({ where: { id: warehouseId }, data: { isDefault: false } });
        await db.warehouse.delete({ where: { id: warehouseId } });
      }
      if (unitId) {
        await db.measureUnit.update({ where: { id: unitId }, data: { isSystem: false } });
        await db.measureUnit.delete({ where: { id: unitId } });
      }
      if (seededDefault) {
        await db.warehouse.update({ where: { id: seededDefault.id }, data: { isDefault: true } });
      }
    }
    const after = await protectedCounts();
    expect(after.systemUnits).toBe(defaultsBefore.systemUnits);
    expect(after.defaultWarehouses).toBe(seededDefault ? 1 : 0);
  });
});

/** Câte depozite implicite și unități de sistem există acum (0 într-o bază doar migrată, 1 și 10 într-una seed-uită). */
async function protectedCounts() {
  return {
    defaultWarehouses: await db.warehouse.count({ where: { isDefault: true } }),
    systemUnits: await db.measureUnit.count({ where: { isSystem: true } }),
  };
}

describe("ajustări fizice: concurență", () => {
  const adjust = (
    variantId: string,
    delta: string,
    reason: "sale_in_store" | "receipt" | "inventory_correction" = "inventory_correction",
    effectiveAt?: Date,
  ) =>
    service.adjustPhysical({
      variantId,
      warehouseId: ctx.warehouseId,
      delta: parseSignedDelta(delta),
      reason,
      note: "concurență",
      ...(effectiveAt && { effectiveAt }),
    });

  const adjustmentMoves = (variantId: string) =>
    db.stockMovement.findMany({ where: { variantId, kind: "adjustment" } });

  it("10 vânzări de câte 1 deodată pe stoc 5 → exact 5 reușesc, stocul ajunge la 0, fiecare vede un alt «stoc după»", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "5" }] });
    const v = variants[0]!;
    const { ok, failed } = await race(10, () => adjust(v.id, "-1", "sale_in_store"));
    expect(ok).toHaveLength(5);
    expect(failed).toHaveLength(5);
    expect(new Set(failed.map((f) => f.code))).toEqual(new Set(["STOCK_ADJUSTMENT_BELOW_ZERO"]));
    expect((await item(v.id)).physical).toBe(0n);
    const moves = await adjustmentMoves(v.id);
    expect(moves).toHaveLength(5);
    // execuție serială: fiecare ajustare a văzut o valoare diferită (4,3,2,1,0), nu două peste aceeași
    expect(new Set(moves.map((m) => m.physicalAfter))).toEqual(
      new Set([q("4"), q("3"), q("2"), q("1"), 0n]),
    );
    await expectConsistent(v.id);
  });

  it("100 de scăderi deodată pe stoc 10 → exact 10, niciodată sub zero", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "10" }] });
    const v = variants[0]!;
    const { ok, failed } = await race(100, () => adjust(v.id, "-1"));
    expect(ok).toHaveLength(10);
    expect(failed.every((f) => f.code === "STOCK_ADJUSTMENT_BELOW_ZERO")).toBe(true);
    expect((await item(v.id)).physical).toBe(0n);
    expect(await adjustmentMoves(v.id)).toHaveLength(10);
  });

  it("10 × -0,3 pe 1,0 → 3 reușesc (rămân 0,1); ajustările nu au pas de vânzare, dar nici nu coboară sub zero", async () => {
    const { variants } = await addStockProduct(db, ctx, {
      step: "0,3",
      variants: [{ physical: "1" }],
    });
    const v = variants[0]!;
    const { ok } = await race(10, () => adjust(v.id, "-0,3"));
    expect(ok).toHaveLength(3);
    expect((await item(v.id)).physical).toBe(q("0,1"));
  });

  it("recepții și vânzări amestecate: stocul final = recepțiile − vânzările reușite, suma registrului = stocul", async () => {
    const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "0" }] });
    const v = variants[0]!;
    const { ok, failed } = await race(30, (i) =>
      i % 3 === 0 ? adjust(v.id, "+2", "receipt") : adjust(v.id, "-1", "sale_in_store"),
    );
    const receipts = ok.filter((r) => r.delta > 0n).length;
    const sales = ok.filter((r) => r.delta < 0n).length;
    expect(receipts).toBe(10);
    expect(failed.every((f) => f.code === "STOCK_ADJUSTMENT_BELOW_ZERO")).toBe(true);
    const row = await item(v.id);
    expect(row.physical).toBe(q(String(receipts * 2 - sales)));
    const moves = await adjustmentMoves(v.id);
    expect(moves).toHaveLength(ok.length);
    expect(moves.reduce((sum, m) => sum + m.deltaPhysical, 0n)).toBe(row.physical);
    await expectConsistent(v.id);
  });

  it("ajustări ↔ rezervări pe același rând: contoare coerente, nimic negativ, fiecare reușită are urma ei", async () => {
    for (let round = 0; round < 8; round++) {
      const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "3" }] });
      const v = variants[0]!;
      const { ok } = await race(8, async (i) =>
        i % 2 === 0
          ? await service.reserve(ref(`r${round}-${i}`), [line(v.id, "1")], soon())
          : await adjust(v.id, "-1", "sale_in_store"),
      );
      const reserved = ok.filter((r) => Array.isArray(r)).length;
      const adjusted = ok.length - reserved;
      const row = await item(v.id);
      expect(row.physical, `runda ${round}`).toBe(q(String(3 - adjusted)));
      expect(row.reserved, `runda ${round}`).toBe(q(String(reserved)));
      expect(await adjustmentMoves(v.id), `runda ${round}`).toHaveLength(adjusted);
      expect(row.physical >= 0n && row.reserved >= 0n).toBe(true);
      await expectConsistent(v.id);
    }
  });

  it("ajustare ↔ poză, cu ora efectivă DUPĂ poză: în orice ordine, rezultatul e același (10 − 1 = 9)", async () => {
    for (let round = 0; round < 12; round++) {
      const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "10" }] });
      const v = variants[0]!;
      const takenAt = new Date(Date.now() - 10 * 60_000);
      const snapshotId = (
        await db.stockSnapshot.create({
          data: { warehouseId: ctx.warehouseId, takenAt, source: "import" },
        })
      ).id;
      ctx.snapshotIds.push(snapshotId);
      const results = await Promise.all([
        service.applySnapshot({
          variantId: v.id,
          warehouseId: ctx.warehouseId,
          snapshotId,
          quantity: q("10"),
          takenAt,
          safetyWindowMinutes: 30,
        }),
        adjust(v.id, "-1", "sale_in_store", new Date()),
      ]);
      expect(results[0]).toMatchObject({ applied: true });
      expect((await item(v.id)).physical, `runda ${round}`).toBe(q("9"));
      await expectConsistent(v.id);
    }
  });

  it("ajustare ↔ poză, cu ora efectivă ÎNAINTEA pozei: rezultatul urmează ordinea reală (avertisment ⇔ poza a fost prima)", async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 12; round++) {
      const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "10" }] });
      const v = variants[0]!;
      const takenAt = new Date(Date.now() - 5 * 60_000);
      const snapshotId = (
        await db.stockSnapshot.create({
          data: { warehouseId: ctx.warehouseId, takenAt, source: "import" },
        })
      ).id;
      ctx.snapshotIds.push(snapshotId);
      const [, adjustment] = await Promise.all([
        service.applySnapshot({
          variantId: v.id,
          warehouseId: ctx.warehouseId,
          snapshotId,
          quantity: q("10"),
          takenAt,
          safetyWindowMinutes: 30,
        }),
        adjust(v.id, "-1", "sale_in_store", new Date(takenAt.getTime() - 60_000)),
      ]);
      const physical = (await item(v.id)).physical;
      if (adjustment.warnings.includes("effective_before_snapshot")) {
        // poza a fost prima: ajustarea scade acum, peste o poză care o conține (risc acceptat)
        expect(physical, `runda ${round}`).toBe(q("9"));
        outcomes.add("poza-prima");
      } else {
        // ajustarea a fost prima: poza o înlocuiește
        expect(physical, `runda ${round}`).toBe(q("10"));
        outcomes.add("ajustarea-prima");
      }
      await expectConsistent(v.id);
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });
});
