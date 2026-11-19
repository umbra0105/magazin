import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction } from "../test-utils/rollback";
import { fallbackOffers } from "./fallback-tariffs";
import { ShippingZoneService, type ZoneInput } from "./zone-service";

const db = getDb();
afterAll(() => db.$disconnect());

const zone = (over: Partial<ZoneInput> = {}): ZoneInput => ({
  name: "Zona test",
  isActive: true,
  countyCodes: [96, 97],
  method: {
    name: "Curier zonă",
    carrier: "Curier propriu",
    type: "weight",
    priceMinor: 2000,
    includedKg: 5,
    perExtraKgMinor: 300,
    freeAboveMinor: 50_000,
    codFeeMinor: 500,
    estimatedDays: 3,
    isActive: true,
  },
  ...over,
});

/** Zonele sunt globale; testele compară înainte/după (baza poate avea zone proprii) și lucrează în tranzacție anulată. */
describe("zonele de livrare din admin", () => {
  it("creează o zonă cu metoda ei și o citește înapoi", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const service = new ShippingZoneService(tx);
      const before = (await service.list()).length;
      const saved = await service.save(zone());
      expect(saved).toMatchObject({ name: "Zona test", countyCodes: [96, 97], isActive: true });
      expect(saved.method).toMatchObject({
        type: "weight",
        priceMinor: 2000,
        includedKg: 5,
        perExtraKgMinor: 300,
      });
      expect((await service.list()).length).toBe(before + 1);
    });
  });

  it("modificarea păstrează o singură metodă și schimbă tarifele", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const service = new ShippingZoneService(tx);
      const created = await service.save(zone());
      const updated = await service.save({
        ...zone({ name: "Zona nouă", countyCodes: [96] }),
        id: created.id,
        method: { ...zone().method, priceMinor: 2500, freeAboveMinor: null },
      });
      expect(updated).toMatchObject({ id: created.id, name: "Zona nouă", countyCodes: [96] });
      expect(updated.method).toMatchObject({ priceMinor: 2500, freeAboveMinor: null });
      expect(await tx.shippingMethod.count({ where: { zoneId: created.id } })).toBe(1);
    });
  });

  it("județele unei zone active nu pot apărea în alta (suprapunere refuzată); o zonă inactivă nu blochează", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const service = new ShippingZoneService(tx);
      await service.save(zone());
      await expect(
        service.save(zone({ name: "Alta", countyCodes: [97, 98] })),
      ).rejects.toMatchObject({
        code: "SHIPPING_ZONE_OVERLAP",
      });
      await expect(
        service.save(zone({ name: "Inactivă", countyCodes: [97], isActive: false })),
      ).resolves.toBeTruthy();
      await expect(
        service.save(zone({ name: "Fără suprapunere", countyCodes: [98] })),
      ).resolves.toBeTruthy();
    });
  });

  it("o zonă inactivă nu ține județele ocupate: o zonă activă le poate lua după ea", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const service = new ShippingZoneService(tx);
      await service.save(zone({ name: "Veche, inactivă", countyCodes: [95], isActive: false }));
      const active = await service.save(zone({ name: "Nouă, activă", countyCodes: [95] }));
      expect(active.countyCodes).toEqual([95]);
    });
  });

  it("județele se salvează fără dubluri și în ordine; editarea unei zone nu se suprapune cu ea însăși", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const service = new ShippingZoneService(tx);
      const saved = await service.save(zone({ countyCodes: [97, 96, 97, 96] }));
      expect(saved.countyCodes).toEqual([96, 97]);
      const row = await tx.shippingZone.findUniqueOrThrow({ where: { id: saved.id } });
      expect(row.countyCodes).toEqual([96, 97]);
      const again = await service.save({ ...zone({ countyCodes: [96, 97] }), id: saved.id });
      expect(again.id).toBe(saved.id);
    });
  });

  it("refuză date greșite: fără județe, nume prea scurt, sume negative sau prag zero", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const service = new ShippingZoneService(tx);
      for (const bad of [
        zone({ countyCodes: [] }),
        zone({ name: "x" }),
        zone({ method: { ...zone().method, priceMinor: -1 } }),
        zone({ method: { ...zone().method, freeAboveMinor: 0 } }),
        zone({ method: { ...zone().method, type: "pickup" as never } }),
      ]) {
        await expect(service.save(bad)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
    });
  });

  it("tarifele salvate din admin ajung în rezerva de livrare (aceeași formă citită de ShippingService)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const service = new ShippingZoneService(tx);
      const saved = await service.save(zone());
      const rows = await tx.shippingZone.findMany({
        where: { id: saved.id },
        include: { methods: true },
      });
      const offers = fallbackOffers({
        zones: rows.map((row) => ({
          id: row.id,
          name: row.name,
          isActive: row.isActive,
          countyCodes: row.countyCodes,
          methods: row.methods.map((m) => ({
            id: m.id,
            code: m.code,
            name: m.name,
            carrier: m.carrier,
            type: m.type as "flat" | "weight",
            priceMinor: m.priceMinor,
            rules: m.rules,
            freeAboveMinor: m.freeAboveMinor,
            codFeeMinor: m.codFeeMinor,
            estimatedDays: m.estimatedDays,
            isActive: m.isActive,
          })),
        })),
        countyCode: 96,
        chargeableGrams: 7001,
        subtotalMinor: 10_000,
      });
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({ priceMinor: 2900, codFeeMinor: 500, estimatedDays: 3 });
    });
  });

  it("ștergerea scoate zona și metoda ei (cascadă); o zonă inexistentă dă false", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const service = new ShippingZoneService(tx);
      const saved = await service.save(zone());
      expect(await service.remove(saved.id)).toBe(true);
      expect(await tx.shippingMethod.count({ where: { zoneId: saved.id } })).toBe(0);
      expect(await service.remove(saved.id)).toBe(false);
    });
  });
});
