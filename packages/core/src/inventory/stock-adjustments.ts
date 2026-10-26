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
import { ADJUSTMENT_REASONS, LOW_STOCK_STEPS_MAX } from "./constants";
import { StockError } from "./stock-errors";
import type {
  AdjustPhysicalInput,
  AdjustPhysicalResult,
  SetLowStockStepsInput,
  SetLowStockStepsResult,
} from "./stock-service";

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

const thresholdInputSchema = z.strictObject({
  variantId: z.string().trim().min(1, "Alege varianta"),
  warehouseId: z.string().trim().min(1).optional(),
  /** Pragul propriu în pași, sau `null` = fără prag propriu (setarea globală). Lipsa lui e o eroare, nu «șterge». */
  steps: z
    .number({ error: "Pragul trebuie să fie un număr întreg de pași" })
    .int("Pragul trebuie să fie un număr întreg de pași")
    .min(0, "Pragul nu poate fi negativ")
    .max(LOW_STOCK_STEPS_MAX, `Pragul poate fi cel mult ${LOW_STOCK_STEPS_MAX} de pași`)
    .nullable(),
});

/** Ce îi trebuie adminului de la serviciul de stoc (și ce se înlocuiește în teste). */
export interface StockAdjusterPort {
  adjustPhysical(input: AdjustPhysicalInput): Promise<AdjustPhysicalResult>;
  setLowStockSteps(input: SetLowStockStepsInput): Promise<SetLowStockStepsResult>;
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

  /**
   * Pragul «stoc mic» propriu al unei variante (în pași; `null` = setarea globală). Cere `inventory.write`. Se scrie audit
   * doar când valoarea s-a schimbat; nu e o mișcare de stoc (nu intră în registrul imuabil).
   */
  async setLowStockThreshold(
    subject: PermissionSubject | null,
    input: unknown,
  ): Promise<SetLowStockStepsResult> {
    assertCan(subject, "inventory.write");
    const data = parseInput(thresholdInputSchema, input);
    const result = await this.deps.stock.setLowStockSteps({
      variantId: data.variantId,
      ...(data.warehouseId && { warehouseId: data.warehouseId }),
      steps: data.steps,
    });
    if (result.before !== result.after) {
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "stock.threshold.update",
        entity: "inventory_item",
        entityId: `${result.variantId}:${result.warehouseId}`,
        before: { lowStockSteps: result.before },
        after: { lowStockSteps: result.after },
      });
    }
    return result;
  }
}
