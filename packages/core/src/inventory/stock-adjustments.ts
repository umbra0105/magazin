import { z } from "zod";
import {
  formatQuantity,
  formatSignedDelta,
  isAmbiguousSeparatorText,
  parseSignedDelta,
} from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { parseInput } from "../catalog/product-schemas";
import { assertCan, type PermissionSubject } from "../rbac/can";
import { ADJUSTMENT_NOTE_MAX } from "./adjustment-rules";
import { ADJUSTMENT_REASONS } from "./constants";
import { StockError } from "./stock-errors";
import type { AdjustPhysicalInput, AdjustPhysicalResult } from "./stock-service";

/**
 * Ajustările manuale de stoc din admin (Faza 5, punctul 6): stratul cu permisiune, validarea intrării și audit,
 * deasupra `StockService.adjustPhysical` (care ține regulile de stoc: motiv, semn, precizie, sub zero, ora efectivă).
 * Cere `inventory.write`. Autorul ajustării este utilizatorul autentificat, nu ceva din cerere.
 */

const adjustmentInputSchema = z.strictObject({
  variantId: z.string().trim().min(1, "Alege varianta"),
  warehouseId: z.string().trim().min(1).optional(),
  /** Cantitatea cu semn, ca text cu virgulă sau punct: «-3», «+2,5» */
  quantity: z.string().trim().min(1, "Cantitatea e obligatorie").max(40, "Cantitatea e prea lungă"),
  reason: z.enum(ADJUSTMENT_REASONS, { error: "Alege un motiv" }),
  note: z
    .string()
    .trim()
    .min(1, "Textul e obligatoriu")
    .max(ADJUSTMENT_NOTE_MAX, `Textul are cel mult ${ADJUSTMENT_NOTE_MAX} de caractere`),
  effectiveAt: z.coerce.date({ error: "Ora efectivă nu este o dată validă" }).optional(),
});

/** Ce îi trebuie adminului de la serviciul de stoc (și ce se înlocuiește în teste). */
export interface StockAdjusterPort {
  adjustPhysical(input: AdjustPhysicalInput): Promise<AdjustPhysicalResult>;
}

export interface StockAdjustmentServiceDeps {
  stock: StockAdjusterPort;
  audit: AuditService;
}

export class StockAdjustmentService {
  constructor(private readonly deps: StockAdjustmentServiceDeps) {}

  async adjust(subject: PermissionSubject | null, input: unknown): Promise<AdjustPhysicalResult> {
    assertCan(subject, "inventory.write");
    const data = parseInput(adjustmentInputSchema, input);
    // «1.234» poate fi 1234 sau 1,234: nu ghicim, cerem să fie scris fără ambiguitate
    if (isAmbiguousSeparatorText(data.quantity.replace(/^[+-]/, ""))) {
      throw new StockError(
        "STOCK_ADJUSTMENT_AMBIGUOUS_QUANTITY",
        `«${data.quantity}» poate însemna două cantități diferite: scrie-o cu virgulă pentru zecimale (ex. 1,234) și fără separator de mii (ex. 1234)`,
      );
    }
    const delta = parseSignedDelta(data.quantity);

    const result = await this.deps.stock.adjustPhysical({
      variantId: data.variantId,
      ...(data.warehouseId && { warehouseId: data.warehouseId }),
      delta,
      reason: data.reason,
      note: data.note,
      ...(data.effectiveAt && { effectiveAt: data.effectiveAt }),
      actor: { id: subject.userId, label: subject.email },
    });

    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "stock.adjust",
      entity: "inventory_item",
      entityId: `${result.variantId}:${result.warehouseId}`,
      before: { physical: formatQuantity(result.physicalBefore) },
      after: {
        physical: formatQuantity(result.physicalAfter),
        delta: formatSignedDelta(result.delta),
        reason: data.reason,
        note: data.note,
        effectiveAt: result.effectiveAt.toISOString(),
        warnings: result.warnings,
      },
    });
    return result;
  }
}
