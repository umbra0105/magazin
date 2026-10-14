import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { CostPriceService, projectVariantForAdmin } from "./cost-price";
import { createPrismaCostPriceStore } from "./cost-price-store";

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);
const COST = 424242;

async function withService<T>(
  fn: (c: {
    tx: TestTx;
    service: CostPriceService;
    as: (role: string) => ReturnType<PermissionService["loadSubject"]>;
    variantId: string;
    logLines: string[];
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const product = await tx.product.create({ data: { slug: `p-${uid()}`, title: "Produs" } });
    const variant = await tx.productVariant.create({
      data: { productId: product.id, sku: `SKU-${uid()}`, price: 19900 },
    });
    const logLines: string[] = [];
    const service = new CostPriceService({
      store: createPrismaCostPriceStore(tx),
      audit: new AuditService(createPrismaAuditStore(tx)),
      logger: createLogger({
        level: "debug",
        destination: {
          write(chunk: string) {
            logLines.push(chunk);
          },
        },
      }),
      now: () => new Date("2026-10-14T12:00:00Z"),
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `cost-${role}-${n++}`, name: role, email: `cost-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      return new PermissionService(tx).loadSubject(user.id);
    };
    return fn({ tx, service, as, variantId: variant.id, logLines });
  });
}

describe("costul de achiziție pe baza reală", () => {
  it("Owner/Admin scriu; Manager și Contabil doar văd; Editor, Suport și Depozit nu au acces", async () => {
    await withService(async ({ service, as, variantId }) => {
      const input = { variantId, costPrice: COST, effectiveDate: new Date("2026-10-01") };
      expect(await service.setCost(await as("owner"), input)).toEqual({ applied: true });
      expect(await service.setCost(await as("admin"), { ...input, costPrice: COST + 1 })).toEqual({
        applied: true,
      });
      for (const role of ["manager", "accountant"]) {
        const subject = await as(role);
        await expect(service.setCost(subject, input)).rejects.toMatchObject({
          code: "AUTH_FORBIDDEN",
        });
        expect((await service.getCost(subject, variantId)).costPrice).toBe(COST + 1);
      }
      for (const role of ["editor", "support", "warehouse"]) {
        const subject = await as(role);
        await expect(service.getCost(subject, variantId)).rejects.toMatchObject({
          code: "AUTH_FORBIDDEN",
        });
        await expect(service.setCost(subject, input)).rejects.toMatchObject({
          code: "AUTH_FORBIDDEN",
        });
      }
    });
  });

  it("scrie varianta și istoricul atomic; o intrare mai veche rămâne doar în istoric", async () => {
    await withService(async ({ tx, service, as, variantId }) => {
      const owner = await as("owner");
      await service.setCost(owner, {
        variantId,
        costPrice: 1000,
        effectiveDate: new Date("2026-09-10"),
      });
      await service.setCost(owner, {
        variantId,
        costPrice: 1200,
        effectiveDate: new Date("2026-10-01"),
      });
      const older = await service.setCost(owner, {
        variantId,
        costPrice: 800,
        effectiveDate: new Date("2026-08-01"),
      });
      expect(older).toEqual({ applied: false });

      const row = await tx.productVariant.findUniqueOrThrow({ where: { id: variantId } });
      expect(row.costPrice).toBe(1200);
      expect(row.costPriceDate).toEqual(new Date("2026-10-01"));
      const history = await service.getHistory(owner, variantId);
      expect(history.map((h) => h.costPrice)).toEqual([1200, 1000, 800]);
      expect(history.every((h) => h.source === "manual")).toBe(true);
    });
  });

  it("auditul din baza reală și logurile nu conțin valoarea; ID-ul și autorul da", async () => {
    await withService(async ({ tx, service, as, variantId, logLines }) => {
      const owner = await as("owner");
      await service.setCost(owner, {
        variantId,
        costPrice: COST,
        effectiveDate: new Date("2026-10-03"),
      });
      const rows = await tx.auditLog.findMany({ where: { entityId: variantId } });
      expect(rows).toHaveLength(1);
      const blob = JSON.stringify(rows);
      expect(blob).not.toContain(String(COST));
      expect(blob).not.toContain("2026-10-03");
      expect(rows[0]).toMatchObject({ action: "product.cost.update", outcome: "success" });
      expect(logLines.join("")).not.toContain(String(COST));
    });
  });

  it("proiecția pentru admin pe rândul real: fără view, cheia de cost lipsește", async () => {
    await withService(async ({ tx, service, as, variantId }) => {
      await service.setCost(await as("owner"), {
        variantId,
        costPrice: COST,
        effectiveDate: new Date("2026-10-01"),
      });
      const row = await tx.productVariant.findUniqueOrThrow({ where: { id: variantId } });
      const forEditor = projectVariantForAdmin(await as("editor"), row);
      expect("costPrice" in forEditor).toBe(false);
      expect("costPriceDate" in forEditor).toBe(false);
      expect(JSON.stringify(forEditor)).not.toContain(String(COST));
      expect(projectVariantForAdmin(await as("manager"), row).costPrice).toBe(COST);
    });
  });
});
