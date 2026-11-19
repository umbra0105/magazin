import { DomainError, ValidationError } from "@ecom/shared";
import { z } from "zod";
import { inTx, type Db } from "../db-tx";

/**
 * Zonele de livrare pe județe cu tarife fixe (REZERVA când furnizorul de tarife nu răspunde), editabile din admin. O zonă are un
 * singur tarif (o metodă): preț fix sau preț de bază pentru un număr de kg incluși plus un tarif pe fiecare kg început în plus,
 * un prag propriu de transport gratuit, o taxă de ramburs și un termen estimat. Un județ aparține cel mult unei zone ACTIVE
 * (suprapunerile se refuză), ca oferta de rezervă să fie previzibilă. Sumele sunt `int` în bani, cu TVA inclus.
 */

const MONEY_MAX = 1_000_000_000;

export const zoneInputSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(2, "Scrie numele zonei").max(100),
  isActive: z.boolean(),
  /** Codurile `JUD` din SIRUTA ale județelor zonei. */
  countyCodes: z.array(z.number().int().min(1).max(99)).min(1, "Alege cel puțin un județ").max(60),
  method: z.object({
    name: z.string().trim().min(2, "Scrie numele metodei").max(100),
    carrier: z.string().trim().max(100).nullable(),
    type: z.enum(["flat", "weight"]),
    priceMinor: z.number().int().min(0).max(MONEY_MAX),
    includedKg: z.number().min(0).max(1000),
    perExtraKgMinor: z.number().int().min(0).max(MONEY_MAX),
    freeAboveMinor: z.number().int().min(1).max(MONEY_MAX).nullable(),
    codFeeMinor: z.number().int().min(0).max(MONEY_MAX),
    estimatedDays: z.number().int().min(0).max(365).nullable(),
    isActive: z.boolean(),
  }),
});
export type ZoneInput = z.infer<typeof zoneInputSchema>;

export interface ZoneDto extends Omit<ZoneInput, "id"> {
  id: string;
}

const METHOD_CODE_PREFIX = "zona-";

export class ShippingZoneService {
  constructor(private readonly db: Db) {}

  async list(): Promise<ZoneDto[]> {
    const zones = await this.db.shippingZone.findMany({
      orderBy: [{ position: "asc" }, { name: "asc" }],
      include: { methods: { orderBy: { position: "asc" }, take: 1 } },
    });
    return zones.flatMap((zone) => {
      const method = zone.methods[0];
      if (!method) return [];
      const rules = (method.rules ?? {}) as { includedKg?: unknown; perExtraKgMinor?: unknown };
      return [
        {
          id: zone.id,
          name: zone.name,
          isActive: zone.isActive,
          countyCodes: [...zone.countyCodes].sort((a, b) => a - b),
          method: {
            name: method.name,
            carrier: method.carrier,
            type: method.type === "weight" ? ("weight" as const) : ("flat" as const),
            priceMinor: method.priceMinor,
            includedKg: typeof rules.includedKg === "number" ? rules.includedKg : 0,
            perExtraKgMinor: typeof rules.perExtraKgMinor === "number" ? rules.perExtraKgMinor : 0,
            freeAboveMinor: method.freeAboveMinor,
            codFeeMinor: method.codFeeMinor,
            estimatedDays: method.estimatedDays,
            isActive: method.isActive,
          },
        },
      ];
    });
  }

  /** Creează sau actualizează o zonă (cu metoda ei). Aruncă `ValidationError` pe date greșite și pe suprapuneri de județe. */
  async save(raw: unknown): Promise<ZoneDto> {
    const parsed = zoneInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("Zona de livrare nu este validă", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const input = parsed.data;
    const countyCodes = [...new Set(input.countyCodes)].sort((a, b) => a - b);
    return inTx(this.db, async (tx) => {
      if (input.isActive) {
        const others = await tx.shippingZone.findMany({
          where: { isActive: true, ...(input.id ? { id: { not: input.id } } : {}) },
          select: { name: true, countyCodes: true },
        });
        const overlap = others.find((zone) =>
          zone.countyCodes.some((code) => countyCodes.includes(code)),
        );
        if (overlap) {
          throw new DomainError(
            "SHIPPING_ZONE_OVERLAP",
            `Un județ ales aparține deja zonei active «${overlap.name}»`,
            { zone: overlap.name },
          );
        }
      }
      const rules = {
        includedKg: input.method.includedKg,
        perExtraKgMinor: input.method.perExtraKgMinor,
      };
      const methodData = {
        name: input.method.name,
        carrier: input.method.carrier && input.method.carrier !== "" ? input.method.carrier : null,
        type: input.method.type,
        priceMinor: input.method.priceMinor,
        rules,
        freeAboveMinor: input.method.freeAboveMinor,
        codFeeMinor: input.method.codFeeMinor,
        estimatedDays: input.method.estimatedDays,
        isActive: input.method.isActive,
      };
      let zoneId: string;
      if (input.id) {
        const existing = await tx.shippingZone.findUnique({
          where: { id: input.id },
          select: { id: true },
        });
        if (!existing)
          throw new DomainError("SHIPPING_ZONE_NOT_FOUND", "Zona nu există", { id: input.id });
        await tx.shippingZone.update({
          where: { id: input.id },
          data: { name: input.name, isActive: input.isActive, countyCodes },
        });
        const method = await tx.shippingMethod.findFirst({
          where: { zoneId: input.id },
          select: { id: true },
        });
        if (method) await tx.shippingMethod.update({ where: { id: method.id }, data: methodData });
        else {
          await tx.shippingMethod.create({
            data: { zoneId: input.id, code: `${METHOD_CODE_PREFIX}${input.id}`, ...methodData },
          });
        }
        zoneId = input.id;
      } else {
        const zone = await tx.shippingZone.create({
          select: { id: true },
          data: { name: input.name, isActive: input.isActive, countyCodes },
        });
        await tx.shippingMethod.create({
          data: { zoneId: zone.id, code: `${METHOD_CODE_PREFIX}${zone.id}`, ...methodData },
        });
        zoneId = zone.id;
      }
      const saved = (await new ShippingZoneService(tx).list()).find((zone) => zone.id === zoneId);
      if (!saved)
        throw new DomainError("SHIPPING_ZONE_NOT_FOUND", "Zona nu a putut fi citită după salvare");
      return saved;
    });
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.db.shippingZone.deleteMany({ where: { id } });
    return removed.count > 0;
  }
}
