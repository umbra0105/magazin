import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { addOrderEvent } from "../orders/order-service";
import { harness, q } from "../test-utils/checkout-fixtures";
import {
  claimDispatch,
  completeDispatch,
  enqueueDispatches,
  failDispatch,
  releaseDispatch,
  skipDispatch,
  sweepDispatches,
} from "./dispatch";
import { resendDispatch } from "./dispatch-resend";

/**
 * Starea unui email de trimis (Faza 11), pe date COMISE (conexiuni diferite, ca doi workeri): «o singură dată per eveniment» e
 * garanția bazei, nu a memoriei. Rândurile de test au destinatar unic și se șterg la sfârșit.
 */
const db = getDb();
const tag = randomUUID().slice(0, 8);
const recipient = (name: string) => `${name}-${tag}@exemplu.invalid`;

afterAll(async () => {
  await db.emailDispatch.deleteMany({
    where: { recipient: { endsWith: `-${tag}@exemplu.invalid` } },
  });
  await db.$disconnect();
});

const input = (name: string, over: { eventKey?: string; template?: string } = {}) => ({
  template: over.template ?? "order.processing",
  eventKey: over.eventKey ?? `event:${tag}-${name}`,
  recipient: recipient(name),
  audience: "customer" as const,
});

describe("unicitatea (eveniment, șablon, destinatar)", () => {
  it("20 de scrieri simultane ale aceluiași eveniment dau UN singur rând", async () => {
    const same = input("simultan");
    const counts = await Promise.all(
      Array.from({ length: 20 }, () => enqueueDispatches(db, [same])),
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await db.emailDispatch.count({ where: { recipient: same.recipient } })).toBe(1);
  });

  it("alt șablon, alt destinatar sau alt eveniment = rând nou", async () => {
    const base = input("variante");
    await enqueueDispatches(db, [
      base,
      { ...base, template: "order.shipped" },
      { ...base, recipient: recipient("variante-2") },
      { ...base, eventKey: `${base.eventKey}-b` },
    ]);
    expect(
      await db.emailDispatch.count({
        where: { recipient: { in: [recipient("variante"), recipient("variante-2")] } },
      }),
    ).toBe(4);
  });
});

describe("revendicarea trimiterii (două workere)", () => {
  it("10 workere deodată: exact UNUL primește rândul și o singură încercare se numără", async () => {
    const row = input("revendicare");
    await enqueueDispatches(db, [row]);
    const id = (await db.emailDispatch.findFirstOrThrow({ where: { recipient: row.recipient } }))
      .id;
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 10 }, () => claimDispatch(db, id, now)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const after = await db.emailDispatch.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({ status: "sending", attempts: 1 });
  });

  it("ciclul de viață: sending → sent (o singură dată), apoi nu mai poate fi revendicat sau marcat eșuat", async () => {
    const row = input("ciclu");
    await enqueueDispatches(db, [row]);
    const id = (await db.emailDispatch.findFirstOrThrow({ where: { recipient: row.recipient } }))
      .id;
    const t0 = new Date();
    expect(await claimDispatch(db, id, t0)).not.toBeNull();
    await completeDispatch(db, id, t0);
    await completeDispatch(db, id, new Date(t0.getTime() + 60_000)); // idempotent: `sentAt` rămâne primul
    expect(await claimDispatch(db, id, t0)).toBeNull();
    await failDispatch(db, id, "ar trebui ignorat");
    await releaseDispatch(db, id, "ar trebui ignorat");
    const done = await db.emailDispatch.findUniqueOrThrow({ where: { id } });
    expect(done).toMatchObject({ status: "sent", sentAt: t0, lastError: null, attempts: 1 });
  });

  it("eșec reîncercabil: sending → queued cu eroarea curățată; la a doua încercare reușită, eroarea dispare", async () => {
    const row = input("reincercare");
    await enqueueDispatches(db, [row]);
    const id = (await db.emailDispatch.findFirstOrThrow({ where: { recipient: row.recipient } }))
      .id;
    await claimDispatch(db, id, new Date());
    await releaseDispatch(db, id, "SEND_FAILED:   timeout\n la conectare ");
    expect(await db.emailDispatch.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "queued",
      lastError: "SEND_FAILED: timeout la conectare",
      claimedAt: null,
    });
    await claimDispatch(db, id, new Date());
    await completeDispatch(db, id, new Date());
    expect(await db.emailDispatch.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "sent",
      attempts: 2,
      lastError: null,
    });
  });

  it("eșec definitiv (dead-letter) și «de sărit»: stări terminale, vizibile, cu motiv", async () => {
    const a = input("moarta");
    const b = input("sarita");
    await enqueueDispatches(db, [a, b]);
    const idA = (await db.emailDispatch.findFirstOrThrow({ where: { recipient: a.recipient } })).id;
    const idB = (await db.emailDispatch.findFirstOrThrow({ where: { recipient: b.recipient } })).id;
    await claimDispatch(db, idA, new Date());
    await failDispatch(db, idA, "x".repeat(1000));
    await skipDispatch(db, idB, "destinatar invalid");
    const failed = await db.emailDispatch.findUniqueOrThrow({ where: { id: idA } });
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toHaveLength(300);
    expect(await db.emailDispatch.findUniqueOrThrow({ where: { id: idB } })).toMatchObject({
      status: "skipped",
      lastError: "destinatar invalid",
    });
  });
});

describe("CHECK-urile tabelului", () => {
  it("`sentAt` apare DOAR la «sent»: «una setată, una nulă» se respinge în ambele sensuri; stări și audiențe necunoscute la fel", async () => {
    const row = input("check");
    await enqueueDispatches(db, [row]);
    const id = (await db.emailDispatch.findFirstOrThrow({ where: { recipient: row.recipient } }))
      .id;
    const run = (sql: string) =>
      db.$executeRawUnsafe(sql).then(
        () => "trecut",
        () => "respins",
      );
    expect(await run(`UPDATE email_dispatch SET status = 'sent' WHERE id = '${id}'`)).toBe(
      "respins",
    );
    expect(await run(`UPDATE email_dispatch SET "sentAt" = now() WHERE id = '${id}'`)).toBe(
      "respins",
    );
    expect(await run(`UPDATE email_dispatch SET status = 'trimis' WHERE id = '${id}'`)).toBe(
      "respins",
    );
    expect(await run(`UPDATE email_dispatch SET audience = 'public' WHERE id = '${id}'`)).toBe(
      "respins",
    );
    expect(await run(`UPDATE email_dispatch SET attempts = -1 WHERE id = '${id}'`)).toBe("respins");
    expect(
      await run(`UPDATE email_dispatch SET status = 'sent', "sentAt" = now() WHERE id = '${id}'`),
    ).toBe("trecut");
  });
});

describe("măturătorul", () => {
  it("rândurile queued vechi sunt de pus în coadă; o trimitere rămasă în aer devine «failed» și NU se retrimite automat", async () => {
    const queued = input("matur-queued");
    const stale = input("matur-stale");
    const fresh = input("matur-fresh");
    await enqueueDispatches(db, [queued, stale, fresh]);
    const find = (r: { recipient: string }) =>
      db.emailDispatch.findFirstOrThrow({ where: { recipient: r.recipient } });
    const staleRow = await find(stale);
    const freshRow = await find(fresh);
    const queuedRow = await find(queued);
    const claimedAt = new Date("2030-01-01T10:00:00.000Z");
    await claimDispatch(db, staleRow.id, claimedAt);
    await db.emailDispatch.update({
      where: { id: queuedRow.id },
      data: { createdAt: new Date("2030-01-01T09:00:00.000Z") },
    });
    await db.emailDispatch.update({
      where: { id: freshRow.id },
      data: { createdAt: new Date("2030-01-01T10:59:59.000Z") },
    });
    const now = new Date("2030-01-01T11:00:00.000Z");
    const result = await sweepDispatches(db, {
      now,
      minAgeMs: 30_000,
      staleSendingMs: 15 * 60_000,
      limit: 5000,
    });
    expect(result.dueIds).toContain(queuedRow.id);
    expect(result.dueIds).not.toContain(freshRow.id);
    expect(result.dueIds).not.toContain(staleRow.id);
    expect(result.staleFailed).toBeGreaterThanOrEqual(1);
    expect(await db.emailDispatch.findUniqueOrThrow({ where: { id: staleRow.id } })).toMatchObject({
      status: "failed",
    });
    // a doua trecere: nimic de recuperat, trimiterea eșuată nu reapare ca «de pus în coadă»
    const again = await sweepDispatches(db, {
      now,
      minAgeMs: 30_000,
      staleSendingMs: 15 * 60_000,
      limit: 5000,
    });
    expect(again.dueIds).not.toContain(staleRow.id);
  });
});

describe("«Retrimite email»", () => {
  it("creează un rând NOU (cheie proprie), scrie OrderEvent și refuză rândurile în curs", async () => {
    await harness(async (h) => {
      const product = await h.product({ physical: "100" });
      const owner = await h.fill([{ variantId: product.variantId, quantity: q("1") }]);
      const { orderId } = await h.checkout.place(owner, await h.input(owner));
      const original = await h.tx.emailDispatch.findFirstOrThrow({ where: { orderId } });
      // în curs (queued): nu se retrimite
      expect(await resendDispatch(h.tx, original.id, { actorLabel: "op@exemplu.ro" })).toBeNull();
      await claimDispatch(h.tx, original.id, new Date());
      await completeDispatch(h.tx, original.id, new Date());
      const resent = await resendDispatch(h.tx, original.id, { actorLabel: "op@exemplu.ro" });
      expect(resent).not.toBeNull();
      const next = await h.tx.emailDispatch.findUniqueOrThrow({
        where: { id: resent?.newId ?? "" },
      });
      expect(next).toMatchObject({
        template: original.template,
        recipient: original.recipient,
        orderId,
        status: "queued",
      });
      expect(next.eventKey).not.toBe(original.eventKey);
      const event = await h.tx.orderEvent.findFirstOrThrow({
        where: { orderId, type: "email.resent" },
      });
      expect(event.actorLabel).toBe("op@exemplu.ro");
      // a doua retrimitere a aceluiași original e permisă (e o acțiune explicită) și dă iar un rând nou
      await claimDispatch(h.tx, next.id, new Date());
      await completeDispatch(h.tx, next.id, new Date());
      const third = await resendDispatch(h.tx, original.id, { actorLabel: "op@exemplu.ro" });
      expect(third?.newId).not.toBe(resent?.newId);
      await addOrderEvent(h.tx, orderId, { type: "note.added", message: "n" });
    });
  });
});
