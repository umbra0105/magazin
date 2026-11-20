import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type { PaymentProvider } from "@ecom/shared";
import { CardPaymentService } from "../payments/card-payment-service";
import { CHECKOUT_TERMS_CONSENT } from "../orders/consent";
import { transitionOrder } from "../orders/order-service";
import { NOW, type Harness } from "../test-utils/checkout-fixtures";
import {
  cardHarness,
  deliver,
  paidEvent,
  processorDeps,
  type TestDeps,
} from "../test-utils/payment-fixtures";
import { OfferService, type OfferDraftInput } from "./offer-service";

/**
 * «Continuă plata» din linkul unei oferte deja convertite (Faza 11, corecția C8). Regula: oferta `converted` și comanda ei, cu
 * plata cu cardul în așteptare și în fereastra de reîncercare (`paymentRetryDeadlineAt`, fixată la plasare din
 * `payment.cardRetryHours`), oferă continuarea; plătită, anulată sau cu fereastra trecută: nu. Continuarea NU creează o a doua
 * comandă și nu are logică de bani proprie: emite jetonul «reîncearcă plata» din Faza 10 (`CardPaymentService.issueRetryToken`).
 */
const db = getDb();
afterAll(() => db.$disconnect());

const ACTOR = { id: "user-1", label: "Manager Test" };
const CONSENT = { accepted: true as const, version: CHECKOUT_TERMS_CONSENT.version };
const HOUR = 3_600_000;

interface Env {
  h: Harness;
  clock: { now: Date };
  offers: OfferService;
  deps: TestDeps;
  /** Creează o ofertă pe un produs cu stoc, o plătește (conversie) și întoarce jetonul, comanda și plata. */
  converted: () => Promise<{ token: string; orderId: string; paymentId: string; total: number }>;
}

async function withEnv<T>(fn: (env: Env) => Promise<T>): Promise<T> {
  return cardHarness(async (h) => {
    const clock = { now: NOW };
    const deps = processorDeps(h);
    const offers = new OfferService({
      db: h.tx,
      cart: h.cart,
      checkout: h.checkout,
      readSettings: async () => ({ validityHours: 72, numberPrefix: "OF-" }),
      now: () => clock.now,
    });
    const draft = (lines: OfferDraftInput["lines"]): OfferDraftInput => ({
      email: "client@exemplu.ro",
      phone: "0722 123 456",
      shipping: {
        fullName: "Ion Popescu",
        phone: "0722123456",
        countyCode: h.geo.countyCode,
        localityCode: h.geo.localityCode,
        street: "Str. Exemplu 1",
        postalCode: "123456",
      },
      billing: { sameAsShipping: true },
      company: null,
      shippingOfferCode: "demo:courier",
      lines,
    });
    const converted = async () => {
      const product = await h.product({ price: 19_900, physical: "10" });
      const created = await offers.create(
        draft([{ variantId: product.variantId, quantity: "1" }]),
        ACTOR,
      );
      const result = await offers.convert(created.token, CONSENT);
      if (!result.paymentId) throw new Error("oferta trebuia să dea o plată cu cardul");
      return {
        token: created.token,
        orderId: result.orderId,
        paymentId: result.paymentId,
        total: created.totals.totalMinor,
      };
    };
    return fn({ h, clock, offers, deps, converted });
  });
}

function cardService(h: Harness, deps: TestDeps, clock: { now: Date }) {
  const base = deps.provider;
  const provider: PaymentProvider = {
    code: base.code,
    mode: base.mode,
    createPayment: (input) => base.createPayment(input),
    verifyWebhook: (request) => base.verifyWebhook(request),
    capture: (ref, amount) => base.capture(ref, amount),
    refund: (request) => base.refund(request),
    getStatus: (ref) => base.getStatus(ref),
    testConnection: () => base.testConnection(),
  };
  return new CardPaymentService({
    db: h.tx,
    getProvider: async () => provider,
    readSettings: async () => ({
      reservationMinutes: 15,
      transferReservationWorkdays: 3,
      timeZone: "Europe/Bucharest",
      nonWorkingDates: [],
      cardRetryHours: 24,
      cardProvider: { code: "demo", mode: "demo" },
    }),
    now: () => clock.now,
    returnUrl: (id) => `https://magazin.test/comanda/plata/${id}`,
    notifyUrl: (name) => `https://magazin.test/api/webhooks/payments/${name}`,
  });
}

describe("«Continuă plata» pe oferta convertită", () => {
  it("plata în așteptare, în fereastră: oferta convertită oferă continuarea către ACEEAȘI comandă", async () => {
    await withEnv(async ({ h, offers, converted }) => {
      const { token, orderId } = await converted();
      const view = await offers.publicView(token);
      expect(view).toMatchObject({ status: "converted", canContinuePayment: true });
      expect(await offers.paymentContinuation(token)).toEqual({ orderId });
      // nicio comandă nouă
      expect(await h.tx.order.count({ where: { email: "client@exemplu.ro" } })).toBe(1);
    });
  });

  it("din oferta convertită se ajunge, prin mecanismul din Faza 10, la plata aceleiași comenzi (fără comandă nouă)", async () => {
    await withEnv(async ({ h, offers, deps, clock, converted }) => {
      const { token, orderId } = await converted();
      const continuation = await offers.paymentContinuation(token);
      expect(continuation).not.toBeNull();
      const cards = cardService(h, deps, clock);
      const retry = await cards.issueRetryToken(continuation?.orderId ?? "");
      expect(await cards.resolveRetryToken(retry.token)).toEqual({ orderId });
      const started = await cards.startRetry(retry.token);
      expect(started.orderId).toBe(orderId);
      expect(await h.tx.order.count({ where: { email: "client@exemplu.ro" } })).toBe(1);
      expect(await h.tx.payment.count({ where: { orderId } })).toBe(2);
    });
  });

  it("oferta încă activă (nepltită): nu e «converted», deci nu oferă continuarea", async () => {
    await withEnv(async ({ h, offers }) => {
      const product = await h.product({ physical: "10" });
      const created = await offers.create(
        {
          email: "alt@exemplu.ro",
          phone: "0722 123 456",
          shipping: {
            fullName: "Ion Popescu",
            phone: "0722123456",
            countyCode: h.geo.countyCode,
            localityCode: h.geo.localityCode,
            street: "Str. Exemplu 1",
            postalCode: "123456",
          },
          billing: { sameAsShipping: true },
          company: null,
          shippingOfferCode: "demo:courier",
          lines: [{ variantId: product.variantId, quantity: "1" }],
        },
        ACTOR,
      );
      expect(await offers.publicView(created.token)).toMatchObject({
        status: "active",
        canContinuePayment: false,
      });
      expect(await offers.paymentContinuation(created.token)).toBeNull();
    });
  });

  it("plata confirmată: nu mai oferă continuarea (comanda e plătită)", async () => {
    await withEnv(async ({ offers, deps, converted }) => {
      const { token, paymentId, total } = await converted();
      const { processed } = await deliver(deps, paidEvent(paymentId, total));
      expect(processed).toBe(true);
      expect(await offers.publicView(token)).toMatchObject({
        status: "converted",
        canContinuePayment: false,
      });
      expect(await offers.paymentContinuation(token)).toBeNull();
    });
  });

  it("comanda anulată: nu mai oferă continuarea", async () => {
    await withEnv(async ({ h, offers, clock, converted }) => {
      const { token, orderId } = await converted();
      await transitionOrder(
        h.tx,
        orderId,
        { status: "cancelled", paymentStatus: "cancelled", fulfillmentStatus: "cancelled" },
        { type: "order.cancelled", message: "Anulată în test" },
        clock.now,
      );
      expect(await offers.publicView(token)).toMatchObject({
        status: "converted",
        canContinuePayment: false,
      });
      expect(await offers.paymentContinuation(token)).toBeNull();
    });
  });

  it("fereastra de reîncercare a trecut: nu mai oferă continuarea, deși comanda încă nu a fost anulată", async () => {
    await withEnv(async ({ h, offers, clock, converted }) => {
      const { token, orderId } = await converted();
      const order = await h.tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { paymentRetryDeadlineAt: true, status: true },
      });
      expect(order.status).toBe("pending");
      const deadline = order.paymentRetryDeadlineAt as Date;
      // exact la termen: închis (aceeași regulă ca în Faza 10: «> acum»); cu o clipă înainte: încă deschis
      clock.now = new Date(deadline.getTime() - 1_000);
      expect(await offers.paymentContinuation(token)).toEqual({ orderId });
      clock.now = deadline;
      expect(await offers.paymentContinuation(token)).toBeNull();
      clock.now = new Date(NOW.getTime() + 25 * HOUR);
      expect(await offers.publicView(token)).toMatchObject({
        status: "converted",
        canContinuePayment: false,
      });
    });
  });

  it("o tentativă eșuată nu închide continuarea (comanda rămâne în așteptare)", async () => {
    await withEnv(async ({ h, offers, converted }) => {
      const { token, orderId, paymentId } = await converted();
      await h.tx.payment.update({ where: { id: paymentId }, data: { status: "failed" } });
      expect(await offers.paymentContinuation(token)).toEqual({ orderId });
    });
  });

  it("fiecare condiție contează de una singură: comandă care nu e «pending», plată care nu e «pending», altă metodă, ofertă care nu e «converted»", async () => {
    await withEnv(async ({ h, offers, converted }) => {
      const { token, orderId } = await converted();
      const offer = await h.tx.orderOffer.findFirstOrThrow({
        where: { convertedOrderId: orderId },
      });
      expect(await offers.paymentContinuation(token)).toEqual({ orderId });
      const order = (data: Record<string, string>) =>
        h.tx.order.update({ where: { id: orderId }, data });
      const cases: Array<{ name: string; apply: () => Promise<unknown> }> = [
        {
          name: "comanda «confirmed», plata încă «pending»",
          apply: () => order({ status: "confirmed" }),
        },
        {
          name: "plata comenzii «failed», comanda «pending»",
          apply: () => order({ paymentStatus: "failed" }),
        },
        {
          name: "comanda cu altă metodă decât cardul",
          apply: () => order({ paymentMethod: "cod" }),
        },
        {
          name: "oferta «cancelled», cu comanda încă legată",
          apply: () =>
            h.tx.orderOffer.update({ where: { id: offer.id }, data: { status: "cancelled" } }),
        },
      ];
      let applied = 0;
      for (const { name, apply } of cases) {
        await h.tx.$executeRawUnsafe("SAVEPOINT s");
        try {
          await apply();
        } catch {
          // starea nici nu poate exista în bază (gardă a schemei): nu mai e nimic de verificat pentru acest caz
          await h.tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT s");
          continue;
        }
        applied += 1;
        expect(await offers.paymentContinuation(token), name).toBeNull();
        await h.tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT s");
        expect(await offers.paymentContinuation(token), `${name} (refăcută)`).toEqual({ orderId });
      }
      expect(applied).toBeGreaterThanOrEqual(2);
    });
  });

  it("o plată care cere atenția adminului (sumă diferită) închide continuarea până o rezolvă el", async () => {
    await withEnv(async ({ h, offers, converted }) => {
      const { token, orderId, paymentId } = await converted();
      await h.tx.payment.update({
        where: { id: paymentId },
        data: { attentionReason: "amount_mismatch", attentionAt: NOW },
      });
      expect(await offers.paymentContinuation(token)).toBeNull();
      expect(await offers.publicView(token)).toMatchObject({ canContinuePayment: false });
      // rezolvată de admin: comanda e din nou continuabilă
      await h.tx.payment.update({
        where: { id: paymentId },
        data: { attentionResolvedAt: NOW },
      });
      expect(await offers.paymentContinuation(token)).toEqual({ orderId });
    });
  });

  it("jeton necunoscut sau stricat: același răspuns «nimic» (nu se deosebesc)", async () => {
    await withEnv(async ({ offers }) => {
      expect(await offers.paymentContinuation("x".repeat(43))).toBeNull();
      expect(await offers.paymentContinuation("scurt")).toBeNull();
      expect(await offers.paymentContinuation("")).toBeNull();
    });
  });

  it("vederea publică nu expune comanda, plata sau datele personale ale continuării", async () => {
    await withEnv(async ({ offers, converted }) => {
      const { token, orderId, paymentId } = await converted();
      const text = JSON.stringify(await offers.publicView(token));
      expect(text).not.toContain(orderId);
      expect(text).not.toContain(paymentId);
      expect(text).not.toContain("client@exemplu.ro");
      expect(text).not.toContain("0722");
    });
  });
});
