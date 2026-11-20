-- Faza 11, pasul 6 (decizia A, 2026-11-20): OFERTA DE PLATĂ. Migrare ADITIVĂ: patru tabele noi; schema comenzii nu se schimbă.
-- O ofertă înghață liniile și totalurile calculate de motorul de prețuri; clientul o plătește printr-un link cu jeton (în bază
-- stă doar amprenta SHA-256). La plată, oferta devine comandă reală prin CheckoutService; legătura e UNICĂ (o singură comandă).
CREATE TABLE "order_offer_counter" (
    "id" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "order_offer_counter_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "order_offer_counter" ADD CONSTRAINT "order_offer_counter_single_check" CHECK ("id" = 'offer' AND "lastValue" >= 0);

CREATE TABLE "order_offer" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "creatorId" TEXT NOT NULL,
    "creatorLabel" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "shipping" JSONB NOT NULL,
    "billing" JSONB,
    "company" JSONB,
    "shippingOfferCode" TEXT NOT NULL,
    "shippingKind" TEXT NOT NULL,
    "subtotalMinor" INTEGER NOT NULL,
    "shippingMinor" INTEGER NOT NULL,
    "taxMinor" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "taxRateBps" INTEGER NOT NULL,
    "convertedOrderId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "staleReason" TEXT,
    "staleAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "order_offer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_offer_number_key" ON "order_offer"("number");
CREATE UNIQUE INDEX "order_offer_tokenHash_key" ON "order_offer"("tokenHash");
CREATE UNIQUE INDEX "order_offer_convertedOrderId_key" ON "order_offer"("convertedOrderId");
CREATE INDEX "order_offer_status_expiresAt_idx" ON "order_offer"("status", "expiresAt");
CREATE INDEX "order_offer_createdAt_idx" ON "order_offer"("createdAt");

ALTER TABLE "order_offer" ADD CONSTRAINT "order_offer_convertedOrderId_fkey"
    FOREIGN KEY ("convertedOrderId") REFERENCES "customer_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- stări; «converted» ⇔ comanda și momentul setate, explicit pe fiecare coloană (un CHECK cu rezultat NULL TRECE)
ALTER TABLE "order_offer" ADD CONSTRAINT "order_offer_status_check"
    CHECK ("status" IN ('active', 'converted', 'expired', 'stale', 'cancelled'));
ALTER TABLE "order_offer" ADD CONSTRAINT "order_offer_converted_check" CHECK (
    ("status" = 'converted' AND "convertedOrderId" IS NOT NULL AND "convertedAt" IS NOT NULL)
    OR ("status" <> 'converted' AND "convertedOrderId" IS NULL AND "convertedAt" IS NULL)
);
ALTER TABLE "order_offer" ADD CONSTRAINT "order_offer_stale_check" CHECK (
    ("status" = 'stale' AND "staleReason" IS NOT NULL AND "staleAt" IS NOT NULL)
    OR ("status" <> 'stale')
);
ALTER TABLE "order_offer" ADD CONSTRAINT "order_offer_cancelled_check" CHECK (
    ("status" = 'cancelled' AND "cancelledAt" IS NOT NULL)
    OR ("status" <> 'cancelled' AND "cancelledAt" IS NULL)
);
ALTER TABLE "order_offer" ADD CONSTRAINT "order_offer_kind_check" CHECK ("shippingKind" IN ('courier', 'pickup'));
-- totaluri înghețate: nenegative; total = produse + transport (oferta e doar cu card: fără taxă de ramburs)
ALTER TABLE "order_offer" ADD CONSTRAINT "order_offer_totals_check" CHECK (
    "subtotalMinor" >= 0 AND "shippingMinor" >= 0 AND "taxMinor" >= 0 AND "totalMinor" > 0
    AND "totalMinor" = "subtotalMinor" + "shippingMinor"
);
ALTER TABLE "order_offer" ADD CONSTRAINT "order_offer_token_check" CHECK (char_length("tokenHash") = 64);

CREATE TABLE "order_offer_line" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "variantId" TEXT,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "quantity" BIGINT NOT NULL,
    "unitSymbol" TEXT NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "lineTotalMinor" INTEGER NOT NULL,
    "vatMinor" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "leadTimeDays" INTEGER,
    "position" INTEGER NOT NULL,
    CONSTRAINT "order_offer_line_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_offer_line_offerId_position_key" ON "order_offer_line"("offerId", "position");
CREATE INDEX "order_offer_line_variantId_idx" ON "order_offer_line"("variantId");
ALTER TABLE "order_offer_line" ADD CONSTRAINT "order_offer_line_offerId_fkey"
    FOREIGN KEY ("offerId") REFERENCES "order_offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_offer_line" ADD CONSTRAINT "order_offer_line_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "order_offer_line" ADD CONSTRAINT "order_offer_line_values_check" CHECK (
    "quantity" > 0 AND "unitPriceMinor" >= 0 AND "lineTotalMinor" >= 0 AND "vatMinor" >= 0 AND "vatMinor" <= "lineTotalMinor"
    AND "state" IN ('in_stock', 'limited', 'on_order')
);

CREATE TABLE "order_offer_event" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "actorLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_offer_event_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "order_offer_event_offerId_createdAt_idx" ON "order_offer_event"("offerId", "createdAt");
ALTER TABLE "order_offer_event" ADD CONSTRAINT "order_offer_event_offerId_fkey"
    FOREIGN KEY ("offerId") REFERENCES "order_offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
