-- Faza 12: EXPEDIERI (AWB). Migrare ADITIVĂ: două tabele noi; schema comenzii nu se schimbă.
-- O expediere = un AWB al unei comenzi (creat prin API la curier sau introdus manual la transportul paletizat) sau un AWB de retur.
CREATE TABLE "shipment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'outbound',
    "mode" TEXT NOT NULL,
    "provider" TEXT,
    "carrier" TEXT NOT NULL,
    "awb" TEXT NOT NULL,
    "trackingUrl" TEXT,
    "providerRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "statusDetail" TEXT,
    "codAmountMinor" INTEGER NOT NULL DEFAULT 0,
    "parcelCount" INTEGER NOT NULL DEFAULT 1,
    "weightGrams" INTEGER,
    "parentId" TEXT,
    "creatorLabel" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shipment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shipment_event" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shipment_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shipment_provider_awb_key" ON "shipment"("provider", "awb");
CREATE INDEX "shipment_orderId_idx" ON "shipment"("orderId");
CREATE INDEX "shipment_status_lastSyncedAt_idx" ON "shipment"("status", "lastSyncedAt");
CREATE UNIQUE INDEX "shipment_event_shipmentId_eventKey_key" ON "shipment_event"("shipmentId", "eventKey");
CREATE INDEX "shipment_event_shipmentId_occurredAt_idx" ON "shipment_event"("shipmentId", "occurredAt");

ALTER TABLE "shipment" ADD CONSTRAINT "shipment_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "customer_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_event" ADD CONSTRAINT "shipment_event_shipmentId_fkey"
    FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Valori permise. Comparații explicite pe fiecare coloană (un CHECK cu rezultat NULL TRECE).
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_kind_check" CHECK ("kind" IN ('outbound', 'return'));
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_status_check"
    CHECK ("status" IN ('created', 'picked_up', 'in_transit', 'delivered', 'returned', 'cancelled'));
-- manual ⇔ fără furnizor; provider ⇔ furnizor setat
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_mode_check" CHECK (
    ("mode" = 'manual' AND "provider" IS NULL)
    OR ("mode" = 'provider' AND "provider" IS NOT NULL AND "provider" IN ('wootpro', 'sameday', 'demo'))
);
-- returul are expediere-părinte; expedierea la client nu
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_parent_check" CHECK (
    ("kind" = 'return' AND "parentId" IS NOT NULL)
    OR ("kind" = 'outbound' AND "parentId" IS NULL)
);
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_awb_check" CHECK (length(btrim("awb")) > 0 AND length(btrim("carrier")) > 0);
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_amounts_check" CHECK (
    "codAmountMinor" >= 0 AND "parcelCount" >= 1 AND ("weightGrams" IS NULL OR "weightGrams" >= 0)
);
-- «livrată» ⇒ momentul livrării; «anulată» ⇔ momentul anulării
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_delivered_check" CHECK (
    ("status" = 'delivered' AND "deliveredAt" IS NOT NULL) OR ("status" <> 'delivered')
);
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_cancelled_check" CHECK (
    ("status" = 'cancelled' AND "cancelledAt" IS NOT NULL)
    OR ("status" <> 'cancelled' AND "cancelledAt" IS NULL)
);
-- cel mult o expediere outbound neanulată pe comandă și un retur neanulat pe expediere
CREATE UNIQUE INDEX "shipment_one_active_outbound" ON "shipment"("orderId")
    WHERE "kind" = 'outbound' AND "status" <> 'cancelled';
CREATE UNIQUE INDEX "shipment_one_active_return" ON "shipment"("parentId")
    WHERE "kind" = 'return' AND "status" <> 'cancelled';
