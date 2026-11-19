import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { cardHarness, processorDeps } from "../test-utils/payment-fixtures";
import { MAX_REJECTED_PER_HOUR, ingestPaymentWebhook } from "./payment-processor";

/** Protecția la inundare: sub atac, respingerile continuă să fie 401, dar baza nu mai crește peste plafon. */
const db = getDb();
afterAll(() => db.$disconnect());

describe("notificări respinse în masă", () => {
  it("peste plafonul pe oră răspunsul rămâne 401, dar nu se mai înregistrează", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const request = { headers: {}, rawBody: Buffer.from("{}") };
      await h.tx.paymentWebhookEvent.createMany({
        data: Array.from({ length: MAX_REJECTED_PER_HOUR }, (_, i) => ({
          provider: "demo",
          eventId: `rejected:test-${i}`,
          status: "rejected",
          rejectReason: "signature_missing",
          bodyHash: "a".repeat(64),
          processedAt: deps.clock.now,
          receivedAt: deps.clock.now,
        })),
      });
      const before = await h.tx.paymentWebhookEvent.count({ where: { status: "rejected" } });
      const result = await ingestPaymentWebhook(deps, "demo", request);
      expect(result).toMatchObject({ outcome: "rejected", status: 401 });
      expect(await h.tx.paymentWebhookEvent.count({ where: { status: "rejected" } })).toBe(before);
    });
  });
});
