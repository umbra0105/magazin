import { describe, expect, it } from "vitest";
import type { AuditFilter, AuditRow, AuditService } from "../../audit/audit-service";
import { DEFAULT_ROLES } from "../../rbac/catalog";
import type { PermissionSubject } from "../../rbac/can";
import { ProductExportService } from "./export-service";

/**
 * Istoricul exporturilor nu e o listă nelimitată: se cer cel mult `limit` rânduri (implicit 25, cel mult 200), serviciul cere
 * unul în plus ca să știe dacă există mai multe («Încarcă mai multe»), iar fără permisiunea de export nu citește nimic.
 */
const subject = (roleKey: string): PermissionSubject => {
  const role = DEFAULT_ROLES.find((r) => r.key === roleKey);
  return {
    userId: `u-${roleKey}`,
    email: `${roleKey}@test.invalid`,
    roles: [roleKey],
    permissions: new Set(role?.permissions ?? []),
  };
};

function service(total: number) {
  const calls: AuditFilter[] = [];
  const audit = {
    list: async (filter: AuditFilter): Promise<AuditRow[]> => {
      calls.push(filter);
      const count = Math.min(total, filter.limit ?? total);
      return Array.from(
        { length: count },
        (_, index) =>
          ({
            id: `a${index}`,
            action: "product.export",
            createdAt: new Date(Date.now() - index * 1000),
            actorLabel: null,
            outcome: "success",
            after: { format: "csv", scope: "all", rows: 1, products: 1 },
          }) as unknown as AuditRow,
      );
    },
  } as unknown as AuditService;
  const exporter = new ProductExportService({
    audit,
    store: {} as never,
    getSettings: async () => ({ maxRows: 1000 }),
    getTimezone: async () => "Europe/Bucharest",
  });
  return { exporter, calls };
}

describe("ProductExportService.historyPage", () => {
  it("cere limita + 1 rânduri și spune dacă mai există (implicit 25)", async () => {
    const { exporter, calls } = service(60);
    const page = await exporter.historyPage(subject("owner"));
    expect(calls[0]?.limit).toBe(26);
    expect(page.items).toHaveLength(25);
    expect(page.hasMore).toBe(true);
    expect(page.limit).toBe(25);
  });

  it("fără rânduri în plus: hasMore = false", async () => {
    const { exporter } = service(10);
    const page = await exporter.historyPage(subject("owner"), 25);
    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(false);
  });

  it("limita se strânge între 1 și 200, iar valorile nevalide cad pe implicit", async () => {
    const { exporter, calls } = service(500);
    expect((await exporter.historyPage(subject("owner"), 1000)).limit).toBe(200);
    expect((await exporter.historyPage(subject("owner"), 0)).limit).toBe(25);
    expect((await exporter.historyPage(subject("owner"), Number.NaN)).limit).toBe(25);
    expect((await exporter.historyPage(subject("owner"), 50.7)).limit).toBe(50);
    expect(calls.map((c) => c.limit)).toEqual([201, 26, 26, 51]);
  });

  it("fără permisiunea de export nu citește nimic și aruncă", async () => {
    const { exporter, calls } = service(5);
    const nobody = subject("viewer-inexistent");
    await expect(exporter.historyPage(nobody)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
