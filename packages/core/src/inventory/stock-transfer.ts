import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type PrismaClient } from "@ecom/db";
import {
  MAX_QUANTITY,
  assertOrderQuantity,
  formatQuantity,
  isAmbiguousSeparatorText,
  parseQuantity,
  quantityFromTicks,
  type Quantity,
  type QuantityDelta,
} from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { parseInput } from "../catalog/product-schemas";
import { assertCan, type PermissionSubject } from "../rbac/can";
import { ADJUSTMENT_NOTE_MAX, fitsUnitPrecision } from "./adjustment-rules";
import { effectiveSaleStep } from "./sale-config";
import { StockError } from "./stock-errors";
import {
  isManagedVariant,
  lockItems,
  runStockTransaction,
  sweepExpired,
  type Counters,
  type ItemKey,
  type Tx,
} from "./stock-service";
import { effectiveMeasureUnit } from "./units";
import { MultiWarehouseDisabledError } from "./warehouse-service";

/**
 * Transferul unei variante între două depozite (Faza 5, punctul 13b), în spatele steagului `multiWarehouse`. O SINGURĂ
 * tranzacție: scade din sursă, adaugă în destinație (rândul se creează dacă lipsește) și scrie DOUĂ mișcări în registrul
 * imuabil, `transfer_out` și `transfer_in`, cu aceeași referință (`stock_transfer` + id-ul transferului), ca istoricul să le lege.
 * Orice eroare anulează tot.
 *
 * Reguli:
 * - steagul oprit → `FEATURE_DISABLED`, înaintea drepturilor și a bazei; cere `inventory.write`; audit cu înainte/după;
 * - sursa dă doar ce e DISPONIBIL (`fizic − angajat − rezervat − tampon`, ca la rezervare), verificat și scris într-o singură
 *   comandă condiționată, sub blocare; marfa rezervată sau angajată nu se mută; rezervările expirate se eliberează întâi;
 * - cantitatea e multiplu EXACT al pasului de vânzare al variantei și respectă zecimalele unității (restul nevandabil, mai mic
 *   decât un pas, nu se poate muta); pasul minim de comandă nu se aplică (nu e o comandă);
 * - depozite diferite, existente și active; doar variante cu stoc gestionat;
 * - ordinea de blocare e cea fixă a rezervărilor (`variantId`, `warehouseId`, ambele rânduri într-o singură comandă), deci
 *   transferurile în sens opus și rezervările nu se blochează reciproc.
 *
 * Poza SmartBill: următoarea poză aplicată unui depozit îi rescrie cantitatea fizică, ca la orice ajustare. Un transfer care
 * atinge un depozit ce primește poze se pierde acolo dacă nu e făcut și în SmartBill; rezultatul poartă avertismentul.
 */

/** Tipul referinței comune a celor două mișcări (se potrivește cu CHECK-ul `^[a-z][a-z0-9_]*$`) */
export const TRANSFER_REF_TYPE = "stock_transfer";

const transferInputSchema = z.strictObject({
  variantId: z.string().trim().min(1, "Alege varianta"),
  fromWarehouseId: z.string().trim().min(1, "Alege depozitul sursă"),
  toWarehouseId: z.string().trim().min(1, "Alege depozitul destinație"),
  /** Cantitatea ca text cu virgulă sau punct: «2,5» */
  quantity: z.string().trim().min(1, "Cantitatea e obligatorie").max(40, "Cantitatea e prea lungă"),
  note: z
    .string()
    .trim()
    .max(ADJUSTMENT_NOTE_MAX, `Textul are cel mult ${ADJUSTMENT_NOTE_MAX} de caractere`)
    .optional(),
});

export type TransferWarningKind = "snapshot_overwrites_source" | "snapshot_overwrites_destination";

export interface TransferWarning {
  kind: TransferWarningKind;
  warehouseId: string;
  warehouseName: string;
}

/** Textul avertismentului despre poza SmartBill, pentru interfață și mesaje */
export function transferWarningMessage(warning: TransferWarning): string {
  return `Depozitul «${warning.warehouseName}» primește poze SmartBill: următoarea poză îi rescrie cantitatea, deci transferul se pierde acolo dacă nu e făcut și în SmartBill.`;
}

export interface TransferSide {
  warehouseId: string;
  physicalBefore: Quantity;
  physicalAfter: Quantity;
  movementId: string;
}

export interface TransferStockResult {
  transferId: string;
  variantId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  quantity: Quantity;
  from: TransferSide;
  to: TransferSide;
  warnings: TransferWarning[];
}

export interface StockTransferServiceDeps {
  /** Clientul bazei (tranzacție proprie) sau o tranzacție deschisă (teste: SAVEPOINT) */
  db: PrismaClient | Prisma.TransactionClient;
  audit: AuditService;
  /** Steagul `multiWarehouse`, citit la FIECARE apel */
  isEnabled: () => Promise<boolean>;
  now?: () => Date;
}

export class StockTransferService {
  constructor(private readonly deps: StockTransferServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async transfer(subject: PermissionSubject | null, input: unknown): Promise<TransferStockResult> {
    if (!(await this.deps.isEnabled())) throw new MultiWarehouseDisabledError();
    assertCan(subject, "inventory.write");
    const data = parseInput(transferInputSchema, input);
    // «1.234» poate fi 1234 sau 1,234: nu ghicim, cerem să fie scris fără ambiguitate
    if (isAmbiguousSeparatorText(data.quantity)) {
      throw new StockError(
        "STOCK_TRANSFER_AMBIGUOUS_QUANTITY",
        `«${data.quantity}» poate însemna două cantități diferite: scrie-o cu virgulă pentru zecimale (ex. 1,234) și fără separator de mii (ex. 1234)`,
      );
    }
    const quantity = parseQuantity(data.quantity);
    if (quantity <= 0n) {
      throw new StockError(
        "STOCK_TRANSFER_QUANTITY_INVALID",
        "Cantitatea transferată trebuie să fie mai mare decât zero",
      );
    }
    if (data.fromWarehouseId === data.toWarehouseId) {
      throw new StockError(
        "STOCK_TRANSFER_SAME_WAREHOUSE",
        "Depozitul sursă și cel destinație trebuie să fie diferite",
      );
    }

    const now = this.now();
    const transferId = randomUUID();
    const note = data.note === undefined || data.note === "" ? null : data.note;
    const result = await runStockTransaction(this.deps.db, (tx) =>
      this.run(tx, {
        ...data,
        quantity,
        note,
        transferId,
        now,
        actor: { id: subject.userId, label: subject.email },
      }),
    );

    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "stock.transfer",
      entity: "stock_transfer",
      entityId: result.transferId,
      before: {
        variantId: result.variantId,
        from: {
          warehouseId: result.fromWarehouseId,
          physical: formatQuantity(result.from.physicalBefore),
        },
        to: {
          warehouseId: result.toWarehouseId,
          physical: formatQuantity(result.to.physicalBefore),
        },
      },
      after: {
        quantity: formatQuantity(result.quantity),
        note,
        from: {
          warehouseId: result.fromWarehouseId,
          physical: formatQuantity(result.from.physicalAfter),
        },
        to: {
          warehouseId: result.toWarehouseId,
          physical: formatQuantity(result.to.physicalAfter),
        },
        warnings: result.warnings,
      },
    });
    return result;
  }

  private async run(
    tx: Tx,
    input: {
      variantId: string;
      fromWarehouseId: string;
      toWarehouseId: string;
      quantity: Quantity;
      note: string | null;
      transferId: string;
      now: Date;
      actor: { id: string; label: string };
    },
  ): Promise<TransferStockResult> {
    const { variantId, quantity, transferId, now, note, actor } = input;
    const source: ItemKey = { variantId, warehouseId: input.fromWarehouseId };
    const target: ItemKey = { variantId, warehouseId: input.toWarehouseId };

    // 1. depozitele: existente și active
    const warehouses = await tx.warehouse.findMany({
      where: { id: { in: [source.warehouseId, target.warehouseId] } },
      select: { id: true, name: true, isActive: true },
    });
    const byId = new Map(warehouses.map((w) => [w.id, w]));
    for (const id of [source.warehouseId, target.warehouseId]) {
      const warehouse = byId.get(id);
      if (!warehouse) {
        throw new StockError("STOCK_NO_WAREHOUSE", "Depozitul nu există", { warehouseId: id });
      }
      if (!warehouse.isActive) {
        throw new StockError(
          "STOCK_TRANSFER_WAREHOUSE_INACTIVE",
          `Depozitul «${warehouse.name}» este dezactivat: reactivează-l sau alege alt depozit`,
          { warehouseId: id },
        );
      }
    }

    // 2. varianta: gestionată, cu unitatea și pasul ei
    const variant = await tx.productVariant.findUnique({
      where: { id: variantId },
      select: {
        manageStock: true,
        saleStep: true,
        measureUnit: { select: { decimals: true } },
        product: {
          select: {
            type: true,
            manageStock: true,
            saleStep: true,
            measureUnit: { select: { decimals: true } },
          },
        },
      },
    });
    if (!variant) {
      throw new StockError("STOCK_VARIANT_NOT_FOUND", "Varianta nu există", { variantId });
    }
    if (!isManagedVariant(variant)) {
      throw new StockError(
        "STOCK_NOT_MANAGED",
        "Produsul nu are stoc gestionat: nu există nimic de transferat",
        { variantId },
      );
    }
    // o unitate nulă înseamnă «buc» (fără zecimale), fără a căuta vreun rând «buc» în bază
    const { decimals } = effectiveMeasureUnit(variant.measureUnit, variant.product.measureUnit, {
      decimals: 0,
    });
    if (!fitsUnitPrecision(quantity as bigint as QuantityDelta, decimals)) {
      throw new StockError(
        "STOCK_TRANSFER_PRECISION",
        decimals === 0
          ? "Unitatea acestui produs nu are zecimale: introdu o cantitate întreagă"
          : `Unitatea acestui produs are cel mult ${decimals} ${decimals === 1 ? "zecimală" : "zecimale"}`,
        { decimals },
      );
    }
    // pasul de vânzare: cantitate pozitivă și multiplu exact (minimul de comandă nu se aplică unui transfer)
    const step = quantityFromTicks(effectiveSaleStep(variant.saleStep, variant.product.saleStep));
    assertOrderQuantity(quantity, { step, minSteps: null });

    // 3. rândul destinației există (creat dacă lipsește); apoi ambele rânduri se blochează, într-o singură comandă, în
    // ordinea fixă a rezervărilor
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO inventory_item (id, "variantId", "warehouseId", "updatedAt")
      VALUES (${randomUUID()}, ${target.variantId}, ${target.warehouseId}, ${now})
      ON CONFLICT ("variantId", "warehouseId") DO NOTHING`);
    const locked = await lockItems(tx, [source, target]);
    const sourceRow = locked.get(`${source.variantId}\u0000${source.warehouseId}`);
    const targetRow = locked.get(`${target.variantId}\u0000${target.warehouseId}`);
    if (!targetRow) {
      throw new StockError("STOCK_VARIANT_NOT_FOUND", "Rândul de stoc al destinației nu există");
    }

    // 4. sursa: rezervările expirate se eliberează întâi; apoi scăderea e UNA SINGURĂ comandă condiționată pe disponibil
    if (sourceRow) await sweepExpired(tx, [source], now);
    const [afterSource] = sourceRow
      ? await tx.$queryRaw<Counters[]>(Prisma.sql`
          UPDATE inventory_item
          SET physical = physical - ${quantity}, "updatedAt" = ${now}
          WHERE "variantId" = ${source.variantId} AND "warehouseId" = ${source.warehouseId}
            AND physical - committed - reserved - "safetyBuffer" >= ${quantity}
          RETURNING physical, committed, reserved`)
      : [];
    if (!afterSource) {
      const [current] = sourceRow
        ? await tx.$queryRaw<Array<Counters & { safetyBuffer: bigint }>>(Prisma.sql`
            SELECT physical, committed, reserved, "safetyBuffer" FROM inventory_item
            WHERE "variantId" = ${source.variantId} AND "warehouseId" = ${source.warehouseId}`)
        : [];
      const free = current
        ? current.physical - current.committed - current.reserved - current.safetyBuffer
        : 0n;
      const available = free > 0n ? free : 0n;
      throw new StockError(
        "STOCK_TRANSFER_INSUFFICIENT",
        `Stoc disponibil insuficient în depozitul sursă: se pot muta cel mult ${formatQuantity(quantityFromTicks(available))} (cantitatea rezervată sau angajată nu se mută)`,
        {
          available: formatQuantity(quantityFromTicks(available)),
          requested: formatQuantity(quantity),
        },
      );
    }

    // 5. destinația: adăugarea rămâne sub plafon, tot într-o singură comandă
    const [afterTarget] = await tx.$queryRaw<Counters[]>(Prisma.sql`
      UPDATE inventory_item
      SET physical = physical + ${quantity}, "updatedAt" = ${now}
      WHERE "variantId" = ${target.variantId} AND "warehouseId" = ${target.warehouseId}
        AND physical + ${quantity} <= ${MAX_QUANTITY}
      RETURNING physical, committed, reserved`);
    if (!afterTarget) {
      throw new StockError(
        "STOCK_TRANSFER_OVERFLOW",
        "Transferul depășește cantitatea maximă care se poate ține în stoc în depozitul destinație",
        { requested: formatQuantity(quantity) },
      );
    }

    // 6. cele două mișcări, cu aceeași referință
    const movement = async (
      key: ItemKey,
      kind: "transfer_out" | "transfer_in",
      delta: bigint,
      after: Counters,
    ): Promise<string> => {
      const created = await tx.stockMovement.create({
        select: { id: true },
        data: {
          variantId: key.variantId,
          warehouseId: key.warehouseId,
          kind,
          deltaPhysical: delta,
          deltaCommitted: 0n,
          physicalAfter: after.physical,
          committedAfter: after.committed,
          effectiveAt: now,
          refType: TRANSFER_REF_TYPE,
          refId: transferId,
          ...(note !== null && { note }),
          actorId: actor.id,
          actorLabel: actor.label,
        },
      });
      return created.id;
    };
    const outId = await movement(source, "transfer_out", -quantity, afterSource);
    const inId = await movement(target, "transfer_in", quantity, afterTarget);

    // 7. avertismentul despre poza SmartBill: depozitele care primesc poze își rescriu cantitatea la următoarea poză
    const withSnapshots = new Set(
      (
        await tx.stockSnapshot.findMany({
          where: { warehouseId: { in: [source.warehouseId, target.warehouseId] } },
          select: { warehouseId: true },
          distinct: ["warehouseId"],
        })
      ).map((s) => s.warehouseId),
    );
    const warnings: TransferWarning[] = [];
    for (const [id, kind] of [
      [source.warehouseId, "snapshot_overwrites_source"],
      [target.warehouseId, "snapshot_overwrites_destination"],
    ] as const) {
      if (withSnapshots.has(id)) {
        warnings.push({ kind, warehouseId: id, warehouseName: byId.get(id)?.name ?? id });
      }
    }

    return {
      transferId,
      variantId,
      fromWarehouseId: source.warehouseId,
      toWarehouseId: target.warehouseId,
      quantity,
      from: {
        warehouseId: source.warehouseId,
        physicalBefore: quantityFromTicks(sourceRow?.physical ?? 0n),
        physicalAfter: quantityFromTicks(afterSource.physical),
        movementId: outId,
      },
      to: {
        warehouseId: target.warehouseId,
        physicalBefore: quantityFromTicks(targetRow.physical),
        physicalAfter: quantityFromTicks(afterTarget.physical),
        movementId: inId,
      },
      warnings,
    };
  }
}
