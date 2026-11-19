import type { Prisma } from "@ecom/db";
import type { PaymentProvider, ProviderStatus } from "@ecom/shared";
import type { Db } from "../db-tx";
import { flagAttention } from "./payment-db";
import { processPaymentEvent, type PaymentProcessorDeps } from "./payment-processor";

/**
 * Reconcilierea zilnică (Faza 10): compară plățile rămase «pending» (mai vechi de `minAgeMs`, mai noi de `maxAgeMs`) cu starea de
 * la procesator (`getStatus`). Diferențele NU se «repară» pe tăcute:
 *  - cazurile SIGURE (procesatorul spune «plătit» cu suma cunoscută, sau «eșuat») trec prin ACEEAȘI cale idempotentă ca
 *    webhook-ul (un eveniment înregistrat și procesat de `processPaymentEvent`);
 *  - restul (sumă necunoscută, stare neclară) intră în «necesită atenție» cu motivul `reconciliation_mismatch`, în raport;
 *  - un furnizor care nu răspunde NU pierde comenzi: după `breakerAfter` eșecuri la rând apelurile către el se opresc în rularea
 *    curentă (circuit breaker), iar plățile rămân neatinse pentru rularea următoare;
 *  - un furnizor care nu poate da starea (`getStatus` → `null`, ca Netopia) e sărit și numărat.
 */
export interface ReconcileOptions {
  minAgeMs: number;
  maxAgeMs: number;
  limit?: number;
  breakerAfter?: number;
}

export interface ReconcileReport {
  checked: number;
  applied: number;
  mismatches: Array<{ paymentId: string; reason: string }>;
  unsupported: number;
  unavailable: number;
  skippedByBreaker: number;
}

export async function reconcilePayments(
  deps: PaymentProcessorDeps,
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  const now = deps.now();
  const rows = await deps.db.payment.findMany({
    where: {
      status: "pending",
      method: "card",
      provider: { in: ["netopia", "euplatesc", "demo"] },
      createdAt: {
        lte: new Date(now.getTime() - options.minAgeMs),
        gte: new Date(now.getTime() - options.maxAgeMs),
      },
    },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 100,
  });
  const report: ReconcileReport = {
    checked: 0,
    applied: 0,
    mismatches: [],
    unsupported: 0,
    unavailable: 0,
    skippedByBreaker: 0,
  };
  const failures = new Map<string, number>();
  const providers = new Map<string, PaymentProvider | null>();
  const breaker = options.breakerAfter ?? 3;

  for (const payment of rows) {
    if ((failures.get(payment.provider) ?? 0) >= breaker) {
      report.skippedByBreaker += 1;
      continue;
    }
    if (!providers.has(payment.provider)) {
      providers.set(payment.provider, await deps.getProvider(payment.provider));
    }
    const provider = providers.get(payment.provider) ?? null;
    if (!provider) {
      report.unavailable += 1;
      continue;
    }
    report.checked += 1;
    let status: ProviderStatus | null;
    try {
      status = await provider.getStatus({
        providerRef: payment.providerRef,
        paymentRef: payment.id,
      });
      failures.set(payment.provider, 0);
    } catch {
      failures.set(payment.provider, (failures.get(payment.provider) ?? 0) + 1);
      report.unavailable += 1;
      continue;
    }
    if (status === null) {
      report.unsupported += 1;
      continue;
    }
    if (status.outcome === "pending" || status.outcome === "unknown") continue;
    if (status.outcome === "credit") continue;
    const safePaid = status.outcome === "paid" && status.amountMinor !== null;
    const safeFailed = status.outcome === "failed";
    if (!safePaid && !safeFailed) {
      await markMismatch(deps.db, payment.id, "suma tranzacției nu e cunoscută", now, report);
      continue;
    }
    // aceeași cale ca webhook-ul: un eveniment înregistrat, apoi procesat idempotent
    const eventId = `reconcile:${payment.id}:${status.outcome}`;
    const normalized: Prisma.InputJsonObject = {
      paymentRef: payment.id,
      providerRef: status.providerRef,
      outcome: status.outcome,
      rawStatus: status.rawStatus,
      amountMinor: status.amountMinor,
      currency: status.currency ?? "RON",
      cardLast4: null,
    };
    await deps.db.paymentWebhookEvent.createMany({
      data: [
        {
          provider: payment.provider,
          eventId,
          status: "received",
          bodyHash: "0".repeat(64),
          normalized,
        },
      ],
      skipDuplicates: true,
    });
    const event = await deps.db.paymentWebhookEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider: payment.provider, eventId } },
      select: { id: true },
    });
    try {
      const result = await processPaymentEvent(deps, event.id);
      if (result.status === "processed") report.applied += 1;
    } catch {
      await markMismatch(
        deps.db,
        payment.id,
        "procesarea evenimentului de reconciliere a eșuat",
        now,
        report,
      );
    }
  }
  return report;
}

async function markMismatch(
  db: Db,
  paymentId: string,
  reason: string,
  now: Date,
  report: ReconcileReport,
): Promise<void> {
  await flagAttention(db, paymentId, "reconciliation_mismatch", now);
  report.mismatches.push({ paymentId, reason });
}
