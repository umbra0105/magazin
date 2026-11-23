import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type { DeliveryAccessRequest, MediaDeliveryProvider } from "@ecom/shared";
import { DIGITAL_PORTS, addOrderEvent, transitionOrder } from "../orders/order-service";
import type { TestTx } from "../test-utils/rollback";
import { createFile, digitalFixture, type DigitalFixture } from "../test-utils/digital-fixtures";
import { requestAccess, type AccessDeps } from "./digital-access";
import { scheduleDigitalAccess } from "./digital-grant";

/**
 * Faza 14b, concurența pe Postgres REAL, cu date COMISE și conexiuni separate (pool): limita de descărcări e atomică (din N cereri
 * simultane pe ultimele unități reușesc exact atâtea câte au rămas) și două evenimente simultane de plată sau livrare nu creează
 * două drepturi de acces. Fișier propriu (datele comise nu se amestecă cu testele în tranzacție anulată); ce se creează aici se
 * șterge la sfârșit.
 */
const pool = getDb();
const asTx = pool as unknown as TestTx;
const created: DigitalFixture[] = [];

afterAll(async () => {
  const orderIds = created.map((f) => f.orderId);
  const productIds = created.flatMap((f) => f.digitalProductIds);
  // drepturile și jurnalul se șterg în cascadă odată cu comanda; abia apoi produsele (drepturile le țineau cu RESTRICT)
  await pool.order.deleteMany({ where: { id: { in: orderIds } } });
  await pool.product.deleteMany({ where: { id: { in: productIds } } });
  await pool.user.deleteMany({ where: { id: { in: created.map((f) => f.userId) } } });
  await pool.salesChannel.deleteMany({ where: { id: { in: created.map((f) => f.channelId) } } });
  await pool.$disconnect();
});

async function committed(options: Parameters<typeof digitalFixture>[1]): Promise<DigitalFixture> {
  const f = await digitalFixture(asTx, options);
  created.push(f);
  return f;
}

const fakeProvider = (): MediaDeliveryProvider =>
  ({
    code: "local",
    label: "Fals",
    async createAccess(request: DeliveryAccessRequest) {
      return {
        kind: "url" as const,
        url: "https://cdn.exemplu.test/x",
        expiresAt: new Date(request.now.getTime() + request.expiresInSeconds * 1000),
        watermarked: false,
      };
    },
  }) as unknown as MediaDeliveryProvider;

const deps: AccessDeps = {
  db: pool,
  readSettings: async () => ({ linkSeconds: 120, maxIpsPerEntitlement: 1000, ipWindowHours: 24 }),
  getProvider: async () => fakeProvider(),
};

const pay = (orderId: string) =>
  pool.$transaction((tx) =>
    transitionOrder(
      tx,
      orderId,
      { status: "confirmed", paymentStatus: "paid" },
      { type: "payment.confirmed", message: "plătită" },
      new Date(),
    ),
  );

describe("limita de descărcări sub concurență", () => {
  it("două cereri simultane pe ultima unitate: una reușește, una primește DIGITAL_LIMIT_REACHED", async () => {
    const f = await committed({ maxDownloads: 1 });
    await pay(f.orderId);
    const ent = await pool.digitalEntitlement.findFirstOrThrow({ where: { orderId: f.orderId } });
    const file = await createFile(asTx, f.digitalProductIds[0] as string);

    const ask = () =>
      requestAccess(
        deps,
        { userId: f.userId, token: ent.accessToken, assetId: file.id },
        { ip: "203.0.113.1", userAgent: "t" },
      ).then(
        () => "ok" as const,
        (error: { code?: string }) => error.code ?? "eroare",
      );
    const results = await Promise.all([ask(), ask()]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "DIGITAL_LIMIT_REACHED")).toHaveLength(1);
    const fresh = await pool.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } });
    expect(fresh.downloadCount).toBe(1);
    expect(await pool.digitalAccessLog.count({ where: { entitlementId: ent.id } })).toBe(1);
  });

  it("12 cereri simultane cu 3 unități rămase: exact 3 reușesc, contorul și jurnalul rămân la 3", async () => {
    const f = await committed({ maxDownloads: 3 });
    await pay(f.orderId);
    const ent = await pool.digitalEntitlement.findFirstOrThrow({ where: { orderId: f.orderId } });
    const file = await createFile(asTx, f.digitalProductIds[0] as string);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        requestAccess(
          deps,
          { userId: f.userId, token: ent.accessToken, assetId: file.id },
          { ip: null, userAgent: null },
        ).then(
          () => "ok" as const,
          (error: { code?: string }) => error.code ?? "eroare",
        ),
      ),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(3);
    expect(results.filter((r) => r === "DIGITAL_LIMIT_REACHED")).toHaveLength(9);
    const fresh = await pool.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } });
    expect(fresh.downloadCount).toBe(3);
    expect(await pool.digitalAccessLog.count({ where: { entitlementId: ent.id } })).toBe(3);
  });

  it("fără limită, toate cererile simultane reușesc și contorul le numără pe toate", async () => {
    const f = await committed({ maxDownloads: null });
    await pay(f.orderId);
    const ent = await pool.digitalEntitlement.findFirstOrThrow({ where: { orderId: f.orderId } });
    const file = await createFile(asTx, f.digitalProductIds[0] as string);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        requestAccess(
          deps,
          { userId: f.userId, token: ent.accessToken, assetId: file.id },
          { ip: null, userAgent: null },
        ),
      ),
    );
    const fresh = await pool.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } });
    expect(fresh.downloadCount).toBe(8);
  });

  it("retragerea simultană cu descărcările: după retragere nu mai reușește nicio cerere, iar contorul = jurnalul", async () => {
    const f = await committed({ maxDownloads: null });
    await pay(f.orderId);
    const ent = await pool.digitalEntitlement.findFirstOrThrow({ where: { orderId: f.orderId } });
    const file = await createFile(asTx, f.digitalProductIds[0] as string);
    const revoke = pool.digitalEntitlement.update({
      where: { id: ent.id },
      data: { revokedAt: new Date(), revokedReason: "Rambursat" },
    });
    const asks = Array.from({ length: 10 }, () =>
      requestAccess(
        deps,
        { userId: f.userId, token: ent.accessToken, assetId: file.id },
        { ip: null, userAgent: null },
      ).then(
        () => "ok" as const,
        (error: { code?: string }) => error.code ?? "eroare",
      ),
    );
    await Promise.all([revoke, ...asks]);
    const fresh = await pool.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } });
    expect(await pool.digitalAccessLog.count({ where: { entitlementId: ent.id } })).toBe(
      fresh.downloadCount,
    );
    // după ce retragerea e comisă, nicio cerere nouă nu mai reușește
    await expect(
      requestAccess(
        deps,
        { userId: f.userId, token: ent.accessToken, assetId: file.id },
        { ip: null, userAgent: null },
      ),
    ).rejects.toMatchObject({ code: "DIGITAL_REVOKED" });
    const after = await pool.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } });
    expect(after.downloadCount).toBe(fresh.downloadCount);
  });
});

describe("acordarea sub concurență", () => {
  it("șase evenimente simultane pe aceeași comandă plătită: un singur drept pe linie și un singur eveniment de acordare", async () => {
    const f = await committed({ digitalLines: 2 });
    // comanda e deja plătită, dar fără drepturi (ca în cazul unui retry): evenimentele concurente le acordă
    await pool.order.update({
      where: { id: f.orderId },
      data: { status: "confirmed", paymentStatus: "paid" },
    });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        pool.$transaction((tx) =>
          scheduleDigitalAccess(
            tx,
            f.orderId,
            { id: `ev-${i}`, type: "payment.confirmed" },
            DIGITAL_PORTS,
          ),
        ),
      ),
    );
    expect(await pool.digitalEntitlement.count({ where: { orderId: f.orderId } })).toBe(2);
    expect(
      await pool.orderEvent.count({ where: { orderId: f.orderId, type: "digital.granted" } }),
    ).toBe(1);
  });

  it("plata confirmată și o rambursare integrală simultane: starea finală e coerentă (retras, nu acordat pe jumătate)", async () => {
    const f = await committed({});
    await pay(f.orderId);
    await Promise.all([
      pool.$transaction((tx) =>
        transitionOrder(
          tx,
          f.orderId,
          { paymentStatus: "refunded" },
          { type: "payment.refunded", message: "rambursată" },
          new Date(),
        ),
      ),
      pool.$transaction((tx) =>
        addOrderEvent(tx, f.orderId, { type: "payment.confirmed", message: "încă o dată" }),
      ),
    ]);
    const rows = await pool.digitalEntitlement.findMany({ where: { orderId: f.orderId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).not.toBeNull();
  });
});
