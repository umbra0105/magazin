import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { workbookBuffer } from "../../../../integrations/src/spreadsheet/test-utils/report-workbook";
import { AuditService } from "../../audit/audit-service";
import { DEFAULT_ROLES } from "../../rbac/catalog";
import type { PermissionSubject } from "../../rbac/can";
import { MemoryAudit } from "../../test-utils/memory-audit";
import { NIR_TEMPLATE_HEADER } from "./nir-report";
import { createPrismaNirStore } from "./nir-store";
import { NirImportService } from "./nir-service";

/**
 * Concurența importului NIR pe Postgres REAL, cu date comise (conexiuni separate), scrisă odată cu importul: două importuri
 * simultane ale aceluiași fișier nu dublează istoricul și nu coboară o dată; două importuri cu date diferite pe aceleași produse
 * lasă data cea mai nouă. Nu trece prin `audit_log` (imuabil): auditul e în memorie. Datele proprii se șterg la final.
 */
const db = getDb();
const NOW = new Date("2030-06-15T12:00:00.000Z");
const DAY = 86_400_000;
const tag = randomUUID().slice(0, 8);
const uid = (): string => randomUUID().slice(0, 8);
const pad = (n: number) => String(n).padStart(2, "0");
const ago = (days: number): string => {
  const d = new Date(NOW.getTime() - days * DAY);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
};
const iso = (days: number): string =>
  new Date(NOW.getTime() - days * DAY).toISOString().slice(0, 10);

const staffId = `staff_${tag}`;
const owner: PermissionSubject = {
  userId: staffId,
  email: `owner-${tag}@exemplu.test`,
  roles: ["owner"],
  permissions: new Set(DEFAULT_ROLES.find((r) => r.key === "owner")?.permissions ?? []),
};

const productIds: string[] = [];
const importIds: string[] = [];

const service = () =>
  new NirImportService({
    store: createPrismaNirStore(db),
    audit: new AuditService(new MemoryAudit()),
    now: () => NOW,
  });

async function makeVariants(count: number): Promise<Array<{ id: string; sku: string }>> {
  const out: Array<{ id: string; sku: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const product = await db.product.create({
      data: { slug: `nirc-${tag}-${uid()}`, title: "Produs NIR concurență", status: "active" },
    });
    productIds.push(product.id);
    const variant = await db.productVariant.create({
      data: { productId: product.id, sku: `NC-${tag}-${uid()}`, price: 20_000 },
    });
    out.push({ id: variant.id, sku: variant.sku });
  }
  return out;
}

const file = (lines: Array<{ sku: string; date: string; cost: number }>) =>
  new Uint8Array(
    workbookBuffer(
      [
        [
          [...NIR_TEMPLATE_HEADER],
          ...lines.map((l) => [
            "D",
            "Produs",
            l.sku,
            l.date,
            "Receptie",
            "NIR",
            "buc",
            3,
            0,
            l.cost,
            0,
            0,
          ]),
        ],
      ],
      "xlsx",
    ),
  );

async function preview(bytes: Uint8Array) {
  const view = await service().preview(owner, { name: "m.xlsx", bytes });
  importIds.push(view.id);
  return view.id;
}

afterAll(async () => {
  await db.nirImport.deleteMany({ where: { id: { in: importIds } } });
  await db.product.deleteMany({ where: { id: { in: productIds } } });
  await db.user.deleteMany({ where: { id: staffId } });
  await db.$disconnect();
});

describe("importuri simultane", () => {
  it("setup: autorul importurilor există", async () => {
    await db.user.create({ data: { id: staffId, name: "Staff", email: owner.email } });
  });

  it("același fișier, importat de două ori deodată: un singur rând de istoric pe variantă, costul neatins de al doilea", async () => {
    for (let round = 0; round < 6; round += 1) {
      const variants = await makeVariants(12);
      const bytes = file(variants.map((v) => ({ sku: v.sku, date: ago(2), cost: 10 })));
      const [a, b] = [await preview(bytes), await preview(bytes)];
      const outcomes = await Promise.all([
        service().confirm(owner, a),
        service().confirm(owner, b),
      ]);
      expect(outcomes.map((o) => o.status)).toEqual(["completed", "completed"]);
      for (const variant of variants) {
        const rows = await db.costPriceHistory.findMany({ where: { variantId: variant.id } });
        expect(rows).toHaveLength(1);
        const stored = await db.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
        expect(stored.costPrice).toBe(1_000);
      }
      // cele două rapoarte împreună au actualizat fiecare variantă exact o dată
      const updated = outcomes.reduce((sum, o) => sum + o.report.counters.updated, 0);
      const unchanged = outcomes.reduce((sum, o) => sum + o.report.counters.unchanged, 0);
      expect(updated).toBe(12);
      expect(unchanged).toBe(12);
    }
  });

  it("două importuri cu date diferite pe aceleași produse, în orice ordine: rămâne data cea mai nouă și nicio dată nu coboară", async () => {
    for (let round = 0; round < 8; round += 1) {
      const variants = await makeVariants(10);
      const older = await preview(
        file(variants.map((v) => ({ sku: v.sku, date: ago(6), cost: 10 }))),
      );
      const newer = await preview(
        file(variants.map((v) => ({ sku: v.sku, date: ago(1), cost: 25 }))),
      );
      // ordinea de pornire alternează între runde
      const order = round % 2 === 0 ? [older, newer] : [newer, older];
      await Promise.all(order.map((id) => service().confirm(owner, id)));
      for (const variant of variants) {
        const stored = await db.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
        expect(stored.costPrice).toBe(2_500);
        expect(stored.costPriceDate?.toISOString().slice(0, 10)).toBe(iso(1));
        const rows = await db.costPriceHistory.findMany({
          where: { variantId: variant.id },
          orderBy: { effectiveDate: "asc" },
        });
        // fie ambele (cea veche aplicată prima), fie doar cea nouă (cea veche a găsit deja o dată mai nouă); niciodată duplicate
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows.length).toBeLessThanOrEqual(2);
        expect(new Set(rows.map((r) => r.effectiveDate.toISOString())).size).toBe(rows.length);
        expect(rows[rows.length - 1]?.costPrice).toBe(2_500);
      }
    }
  });
});
