import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { loadReturnableLines } from "../returns/return-lines";
import { inRolledBackTransaction } from "../test-utils/rollback";
import { digitalFixture } from "../test-utils/digital-fixtures";

/**
 * Faza 14b, D6: clientul NU are retur pe liniile digitale. Aceeași funcție alimentează lista din cont și validarea de pe server a
 * cererii de retur: o linie digitală nu apare în listă, deci nici nu poate fi cerută.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

describe("retururile și produsele digitale", () => {
  it("lista de linii returnabile are doar liniile fizice ale comenzii mixte", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { digitalLines: 1, physicalLines: 2 });
      const lines = await loadReturnableLines(tx, f.orderId);
      expect(lines.map((l) => l.orderLineId).sort()).toEqual([...f.physicalLineIds].sort());
      expect(lines.some((l) => f.digitalLineIds.includes(l.orderLineId))).toBe(false);
    });
  });

  it("o comandă doar digitală nu are nicio linie returnabilă", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { digitalLines: 2 });
      expect(await loadReturnableLines(tx, f.orderId)).toEqual([]);
    });
  });
});
