import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { NOW, codeOf, harness, orderOf, q, type Harness } from "../test-utils/checkout-fixtures";
import { setInstallationStatus } from "./order-installation";

/** Starea cererii de instalare (Faza 11, docs/15 §4): doar urmărire, nu atinge sumele, stocul sau statusurile comenzii. */
const db = getDb();
afterAll(() => db.$disconnect());

const WHO = { actorLabel: "operator@exemplu.ro", now: NOW };

async function place(h: Harness, installation: boolean) {
  const product = await h.product({ physical: "100" });
  const owner = await h.fill([{ variantId: product.variantId, quantity: q("1") }]);
  return h.checkout.place(
    owner,
    await h.input(
      owner,
      installation ? { installation: { requested: true, note: "Piscină 8x4" } } : {},
    ),
  );
}

describe("cererea de instalare", () => {
  it("la plasare cererea e «requested», cu momentul; fără cerere nu există stare", async () => {
    await harness(async (h) => {
      const wants = await orderOf(h.tx, (await place(h, true)).orderId);
      expect(wants).toMatchObject({ installationRequested: true, installationStatus: "requested" });
      expect(wants.installationStatusAt).toEqual(NOW);
      const plain = await orderOf(h.tx, (await place(h, false)).orderId);
      expect(plain).toMatchObject({ installationRequested: false, installationStatus: null });
    });
  });

  it("schimbarea stării scrie OrderEvent (fără textul clientului), nu atinge sumele sau statusurile și e idempotentă", async () => {
    await harness(async (h) => {
      const { orderId } = await place(h, true);
      const before = await orderOf(h.tx, orderId);
      expect(await setInstallationStatus(h.tx, orderId, "contacted", WHO)).toEqual({
        changed: true,
      });
      expect(await setInstallationStatus(h.tx, orderId, "contacted", WHO)).toEqual({
        changed: false,
      });
      await setInstallationStatus(h.tx, orderId, "scheduled", WHO);
      const after = await orderOf(h.tx, orderId);
      expect(after.installationStatus).toBe("scheduled");
      for (const field of ["status", "paymentStatus", "fulfillmentStatus", "totalMinor"] as const) {
        expect(after[field], field).toEqual(before[field]);
      }
      const events = after.events.filter((e) => e.type === "order.installation_status");
      expect(events.map((e) => e.data)).toEqual([
        { from: "requested", to: "contacted" },
        { from: "contacted", to: "scheduled" },
      ]);
      expect(JSON.stringify(events)).not.toContain("Piscină");
    });
  });

  it("refuză o stare necunoscută, o comandă fără cerere și una inexistentă", async () => {
    await harness(async (h) => {
      const wants = await place(h, true);
      const plain = await place(h, false);
      expect(await codeOf(setInstallationStatus(h.tx, wants.orderId, "poate", WHO))).toBe(
        "ORDER_INSTALLATION_INVALID",
      );
      expect(await codeOf(setInstallationStatus(h.tx, plain.orderId, "contacted", WHO))).toBe(
        "ORDER_INSTALLATION_INVALID",
      );
      expect(await codeOf(setInstallationStatus(h.tx, "nu-exista", "contacted", WHO))).toBe(
        "ORDER_NOT_FOUND",
      );
    });
  });

  it("CHECK-ul din bază: «una setată, una nulă» se respinge; starea trebuie să fie una cunoscută", async () => {
    await harness(async (h) => {
      const wants = await place(h, true);
      const plain = await place(h, false);
      const attempt = async (orderId: string, set: string) => {
        await h.tx.$executeRawUnsafe("SAVEPOINT i");
        try {
          await h.tx.$executeRawUnsafe(`UPDATE customer_order SET ${set} WHERE id = '${orderId}'`);
          return "trecut";
        } catch {
          return "respins";
        } finally {
          await h.tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT i");
        }
      };
      expect(await attempt(wants.orderId, `"installationStatus" = NULL`)).toBe("respins");
      expect(await attempt(wants.orderId, `"installationStatus" = 'poate'`)).toBe("respins");
      expect(await attempt(wants.orderId, `"installationStatus" = 'done'`)).toBe("trecut");
      expect(await attempt(plain.orderId, `"installationStatus" = 'requested'`)).toBe("respins");
      expect(await attempt(plain.orderId, `"installationRequested" = true`)).toBe("respins");
      expect(
        await attempt(
          plain.orderId,
          `"installationRequested" = true, "installationStatus" = 'requested'`,
        ),
      ).toBe("trecut");
    });
  });
});
