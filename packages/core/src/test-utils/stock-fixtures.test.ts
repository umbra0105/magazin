import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@ecom/db";
import {
  assertStockNamespace,
  createStockContext,
  assertStockTestDatabase,
  purgeStockContext,
  purgeStockLeftovers,
  type StockContext,
} from "./stock-fixtures";

/**
 * Curățarea fixture-ului de stoc oprește TEMPORAR un trigger de imuabilitate și șterge mișcări: refuză să ruleze pe orice
 * bază al cărei nume nu conține cuvântul «test». Aici o dovedim cu un client fals (fără bază reală): pe o bază de
 * dezvoltare sau de producție nu se emite NICIO instrucțiune de ștergere și nu se pornește nicio tranzacție.
 */
function fakeClient(databaseName: string) {
  const calls = { transaction: vi.fn(), find: vi.fn() };
  const client = {
    $queryRaw: vi.fn(async () => [{ name: databaseName }]),
    $transaction: calls.transaction,
    product: { findMany: calls.find },
    warehouse: { findMany: calls.find },
    measureUnit: { findMany: calls.find },
  };
  return { client: client as unknown as PrismaClient, calls };
}

const context: StockContext = {
  tag: "abc",
  warehouseId: "w",
  unitId: "u",
  ownsWarehouse: true,
  productIds: ["p"],
  variantIds: ["v"],
  snapshotIds: [],
};

describe("curățarea fixture-ului de stoc refuză bazele fără «test» în nume", () => {
  const forbidden = [
    "ecom",
    "ecom_dev",
    "ecom_prod",
    "magazin",
    "contest",
    "latest_orders",
    "attestation",
  ];

  it.each(forbidden)("«%s»: purgeStockContext refuză, fără tranzacție", async (name) => {
    const { client, calls } = fakeClient(name);
    await expect(purgeStockContext(client, context)).rejects.toThrow(/REFUZ/);
    expect(calls.transaction).not.toHaveBeenCalled();
  });

  it.each(forbidden)(
    "«%s»: purgeStockLeftovers refuză, fără căutare și fără tranzacție",
    async (name) => {
      const { client, calls } = fakeClient(name);
      await expect(purgeStockLeftovers(client, "abcd")).rejects.toThrow(/REFUZ/);
      expect(calls.find).not.toHaveBeenCalled();
      expect(calls.transaction).not.toHaveBeenCalled();
    },
  );

  it("un rezultat fără nume de bază (răspuns gol) refuză, nu trece", async () => {
    const client = { $queryRaw: vi.fn(async () => []) } as unknown as PrismaClient;
    await expect(assertStockTestDatabase(client)).rejects.toThrow(/REFUZ/);
  });

  it.each(["ecom_test", "test", "ecom-test-2", "TEST_ecom", "ecom_test_ci"])(
    "«%s»: baza de test e acceptată",
    async (name) => {
      const { client } = fakeClient(name);
      await expect(assertStockTestDatabase(client)).resolves.toBeUndefined();
    },
  );
});

describe("spațiul de nume al curățării resturilor (15e)", () => {
  it.each(["", "a", "Abc", "abc1", "ab_c", "ab-c", "a".repeat(13), "ab cd", "../x"])(
    "«%s» nu e un spațiu de nume valid: refuz înainte de orice acces la bază",
    async (namespace) => {
      expect(() => assertStockNamespace(namespace)).toThrow(/Spațiul de nume/);
      const { client, calls } = fakeClient("ecom_test");
      await expect(purgeStockLeftovers(client, namespace)).rejects.toThrow(/Spațiul de nume/);
      expect(client.$queryRaw).not.toHaveBeenCalled();
      expect(calls.find).not.toHaveBeenCalled();
      expect(calls.transaction).not.toHaveBeenCalled();
    },
  );

  it.each(["", "Abc", "ab_c", "a"])(
    "createStockContext refuză «%s» înainte de orice acces la bază",
    async (namespace) => {
      const { client, calls } = fakeClient("ecom_test");
      await expect(createStockContext(client, { namespace })).rejects.toThrow(/Spațiul de nume/);
      expect(calls.find).not.toHaveBeenCalled();
      expect(calls.transaction).not.toHaveBeenCalled();
    },
  );

  it.each(["ab", "sact", "a".repeat(12)])("«%s» e acceptat", (namespace) => {
    expect(() => assertStockNamespace(namespace)).not.toThrow();
  });

  it("caută doar produsele, depozitele și unitățile cu prefixul spațiului de nume (niciodată «st-», «w_», «u_» goale)", async () => {
    const { client, calls } = fakeClient("ecom_test");
    calls.find.mockResolvedValue([]);
    await expect(purgeStockLeftovers(client, "sact")).resolves.toBe(0);
    const wheres = calls.find.mock.calls.map((call) =>
      JSON.stringify((call[0] as { where: unknown }).where),
    );
    expect(wheres).toHaveLength(3);
    expect(wheres.some((w) => w.includes('"startsWith":"st-sact_"'))).toBe(true);
    expect(wheres.some((w) => w.includes('"startsWith":"w_sact_"'))).toBe(true);
    expect(wheres.some((w) => w.includes('"startsWith":"u_sact_"'))).toBe(true);
    for (const where of wheres) {
      expect(where).not.toMatch(/"startsWith":"(st-|w_|u_)"/);
    }
  });
});
