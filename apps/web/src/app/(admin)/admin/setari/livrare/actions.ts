"use server";

import { z } from "zod";
import { ShippingZoneService } from "@ecom/core";
import { getDb } from "@ecom/db";
import { DomainError, ValidationError } from "@ecom/shared";
import { getAudit } from "@/lib/admin-writes";
import { parseMoneyInput } from "@/lib/money-input";
import { withPermission } from "@/lib/session";

/**
 * Zonele de livrare (rezerva pe județe când furnizorul de tarife nu răspunde): `/admin/setari/livrare`. Scrierea cere
 * `settings.write`. Sumele vin ca text în lei (virgulă sau punct, cel mult 2 zecimale) și se salvează în bani; regulile
 * (județ în cel mult o zonă activă, limite) sunt în `ShippingZoneService`. Fiecare scriere reușită intră în jurnalul de audit,
 * cu starea dinainte și de după. Erorile se întorc pe câmp, ca formularul să pună focusul pe primul câmp greșit.
 */
const zoneForm = z.strictObject({
  id: z.string().min(1).max(64).optional(),
  name: z.string().max(200),
  isActive: z.boolean(),
  countyCodes: z.array(z.number().int()).max(60),
  methodName: z.string().max(200),
  carrier: z.string().max(200),
  type: z.enum(["flat", "weight"]),
  price: z.string().max(40),
  includedKg: z.string().max(20),
  perExtraKg: z.string().max(40),
  freeAbove: z.string().max(40),
  codFee: z.string().max(40),
  days: z.string().max(10),
});

export type SaveZoneResult =
  { ok: true } | { ok: false; errors: Record<string, string>; overlapZone?: string };

/** Kilograme: număr cu cel mult 3 zecimale (greutatea nu e sumă de bani). */
function parseKg(text: string): number | null {
  const cleaned = text.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,3})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value <= 1000 ? value : null;
}

export const saveShippingZone = withPermission(
  "settings.write",
  async (raw: unknown, subject): Promise<SaveZoneResult> => {
    const parsed = zoneForm.safeParse(raw);
    if (!parsed.success) return { ok: false, errors: { form: "invalid" } };
    const data = parsed.data;
    const errors: Record<string, string> = {};

    const name = data.name.trim();
    if (name.length < 2) errors["name"] = "name";
    const methodName = data.methodName.trim();
    if (methodName.length < 2) errors["methodName"] = "methodName";
    if (data.countyCodes.length === 0) errors["counties"] = "counties";
    const price = parseMoneyInput(data.price);
    if (price === null) errors["price"] = "money";
    const codFee = parseMoneyInput(data.codFee === "" ? "0" : data.codFee);
    if (codFee === null) errors["codFee"] = "money";
    const freeText = data.freeAbove.trim();
    const freeAbove = freeText === "" ? null : parseMoneyInput(freeText);
    if (freeText !== "" && (freeAbove === null || freeAbove < 1)) errors["freeAbove"] = "money";

    let includedKg = 0;
    let perExtraKg = 0;
    if (data.type === "weight") {
      const kg = parseKg(data.includedKg === "" ? "0" : data.includedKg);
      if (kg === null) errors["includedKg"] = "number";
      else includedKg = kg;
      const extra = parseMoneyInput(data.perExtraKg === "" ? "0" : data.perExtraKg);
      if (extra === null) errors["perExtraKg"] = "money";
      else perExtraKg = extra;
    }

    const daysText = data.days.trim();
    let days: number | null = null;
    if (daysText !== "") {
      if (!/^\d{1,3}$/.test(daysText) || Number(daysText) > 365) errors["days"] = "number";
      else days = Number(daysText);
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors };

    const service = new ShippingZoneService(getDb());
    const before = data.id ? ((await service.list()).find((z) => z.id === data.id) ?? null) : null;
    try {
      const saved = await service.save({
        ...(data.id && { id: data.id }),
        name,
        isActive: data.isActive,
        countyCodes: data.countyCodes,
        method: {
          name: methodName,
          carrier: data.carrier.trim() === "" ? null : data.carrier.trim(),
          type: data.type,
          priceMinor: price ?? 0,
          includedKg,
          perExtraKgMinor: perExtraKg,
          freeAboveMinor: freeAbove,
          codFeeMinor: codFee ?? 0,
          estimatedDays: days,
          isActive: data.isActive,
        },
      });
      await getAudit().record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: before ? "shipping-zone.update" : "shipping-zone.create",
        entity: "shipping_zone",
        entityId: saved.id,
        before,
        after: saved,
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof DomainError && error.code === "SHIPPING_ZONE_OVERLAP") {
        const zone = (error.details as { zone?: unknown } | undefined)?.zone;
        return {
          ok: false,
          errors: { counties: "overlap" },
          ...(typeof zone === "string" && { overlapZone: zone }),
        };
      }
      if (error instanceof ValidationError) return { ok: false, errors: { form: "invalid" } };
      throw error;
    }
  },
  { action: "shipping-zone.save", entity: "shipping_zone" },
);

const zoneRef = z.strictObject({ id: z.string().min(1).max(64) });

export const removeShippingZone = withPermission(
  "settings.write",
  async (raw: unknown, subject): Promise<{ ok: boolean }> => {
    const parsed = zoneRef.safeParse(raw);
    if (!parsed.success) return { ok: false };
    const service = new ShippingZoneService(getDb());
    const before = (await service.list()).find((zone) => zone.id === parsed.data.id) ?? null;
    const removed = await service.remove(parsed.data.id);
    if (removed) {
      await getAudit().record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "shipping-zone.delete",
        entity: "shipping_zone",
        entityId: parsed.data.id,
        before,
      });
    }
    return { ok: removed };
  },
  { action: "shipping-zone.delete", entity: "shipping_zone" },
);
