import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { IntegrationService } from "./integration-service";
import { createPrismaIntegrationStore } from "./prisma-store";

const db = getDb();
const service = new IntegrationService(
  createPrismaIntegrationStore(db),
  randomBytes(32).toString("base64"),
);

describe("IntegrationService (Postgres real)", () => {
  beforeEach(async () => {
    await db.integration.deleteMany();
  });

  afterAll(async () => {
    await db.integration.deleteMany();
    await db.$disconnect();
  });

  it("în coloana din DB stă doar valoarea criptată v1:", async () => {
    await service.save({
      type: "payment",
      provider: "euplatesc",
      credentials: { merchantKey: "MERCHANT-KEY-0042" },
      isActive: true,
    });
    const row = await db.integration.findUniqueOrThrow({
      where: { type_provider: { type: "payment", provider: "euplatesc" } },
    });
    expect(row.credentials?.startsWith("v1:")).toBe(true);
    expect(row.credentials).not.toContain("MERCHANT");
    expect(row.isActive).toBe(true);
    expect(await service.getCredentials("payment", "euplatesc")).toEqual({
      merchantKey: "MERCHANT-KEY-0042",
    });
  });
});
