-- Faza 13: FACTURI (SmartBill și DEMO). Migrare ADITIVĂ: trei tabele noi; schema comenzii nu se schimbă.
-- `invoice` = documentul fiscal (proformă, factură, storno) ȘI rândul de outbox al emiterii; `invoice_line` = linii înghețate;
-- `invoice_event` = jurnal care doar se adaugă.
CREATE TABLE "invoice" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "docKey" TEXT NOT NULL,
    "parentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "provider" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "series" TEXT,
    "number" TEXT,
    "providerRef" TEXT,
    "pdfUrl" TEXT,
    "efacturaStatus" TEXT NOT NULL DEFAULT 'not_applicable',
    "efacturaCheckedAt" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'RON',
    "totalMinor" INTEGER NOT NULL,
    "taxMinor" INTEGER NOT NULL,
    "useStock" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastError" TEXT,
    "lockedAt" TIMESTAMP(3),
    "alertedAt" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3),
    "requestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invoice_line" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "orderLineId" TEXT,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "unitName" TEXT NOT NULL,
    "quantityTicks" BIGINT NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "lineTotalMinor" INTEGER NOT NULL,
    "netMinor" INTEGER NOT NULL,
    "taxMinor" INTEGER NOT NULL,
    "taxRateBps" INTEGER NOT NULL,
    "dischargeStock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invoice_event" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invoice_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invoice_orderId_docKey_key" ON "invoice"("orderId", "docKey");
CREATE INDEX "invoice_status_nextAttemptAt_idx" ON "invoice"("status", "nextAttemptAt");
CREATE INDEX "invoice_orderId_idx" ON "invoice"("orderId");
CREATE UNIQUE INDEX "invoice_line_invoiceId_position_key" ON "invoice_line"("invoiceId", "position");
CREATE INDEX "invoice_event_invoiceId_createdAt_idx" ON "invoice_event"("invoiceId", "createdAt");

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "customer_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoice_event" ADD CONSTRAINT "invoice_event_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Valori permise. Comparații explicite pe fiecare coloană (un CHECK cu rezultat NULL TRECE).
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_kind_check" CHECK ("kind" IN ('proforma', 'invoice', 'storno'));
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_status_check"
    CHECK ("status" IN ('queued', 'issuing', 'issued', 'failed', 'skipped'));
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_efactura_check"
    CHECK ("efacturaStatus" IN ('not_applicable', 'unknown', 'pending', 'sent', 'validated', 'error'));
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_provider_check"
    CHECK (("provider" IS NULL) OR ("provider" IN ('smartbill', 'demo')));
-- cheia documentului se potrivește cu tipul
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_dockey_check" CHECK (
    ("kind" = 'proforma' AND "docKey" = 'proforma')
    OR ("kind" = 'invoice' AND "docKey" = 'invoice')
    OR ("kind" = 'storno' AND "docKey" LIKE 'storno:%' AND length("docKey") > 7)
);
-- stornoul are factura-părinte; proforma și factura nu
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_parent_check" CHECK (
    ("kind" = 'storno' AND "parentId" IS NOT NULL)
    OR ("kind" IN ('proforma', 'invoice') AND "parentId" IS NULL)
);
-- emis ⇔ documentul are furnizor, serie, număr, referință și moment; altfel niciunul dintre ele
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_issued_check" CHECK (
    ("status" = 'issued' AND "provider" IS NOT NULL AND "series" IS NOT NULL AND "number" IS NOT NULL
        AND "providerRef" IS NOT NULL AND "issuedAt" IS NOT NULL)
    OR ("status" <> 'issued' AND "provider" IS NULL AND "series" IS NULL AND "number" IS NULL
        AND "providerRef" IS NULL AND "issuedAt" IS NULL)
);
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_amounts_check" CHECK (
    "totalMinor" >= 0 AND "taxMinor" >= 0 AND "taxMinor" <= "totalMinor" AND "attempts" >= 0
);

ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_kind_check" CHECK ("kind" IN ('product', 'shipping', 'cod_fee'));
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_amounts_check" CHECK (
    "quantityTicks" > 0 AND "unitPriceMinor" >= 0 AND "lineTotalMinor" >= 0 AND "netMinor" >= 0 AND "taxMinor" >= 0
    AND "taxRateBps" >= 0 AND "taxRateBps" <= 10000 AND "netMinor" + "taxMinor" = "lineTotalMinor"
);
-- SmartBill: cel mult 2 zecimale la cantitate (1 unitate = 10000 zecimi de miime, deci multiplu de 100)
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_quantity_check" CHECK ("quantityTicks" % 100 = 0);
-- produs ⇔ linie de comandă și SKU; transport și taxă de ramburs: niciuna
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_source_check" CHECK (
    ("kind" = 'product' AND "orderLineId" IS NOT NULL AND "sku" IS NOT NULL)
    OR ("kind" IN ('shipping', 'cod_fee') AND "orderLineId" IS NULL AND "sku" IS NULL)
);

-- Un document emis nu își mai schimbă câmpurile fiscale (doar starea e-Factura, linkul și evidența încercărilor). Un document
-- real (nesimulat) emis nu se șterge; cele simulate (DEMO) se pot șterge la curățarea datelor de probă.
CREATE FUNCTION "invoice_issued_immutable"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'issued' AND OLD."simulated" = false THEN
      RAISE EXCEPTION 'invoice_issued_immutable: documentul % emis nu se poate șterge', OLD."id";
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'issued' AND (
       NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."docKey" IS DISTINCT FROM OLD."docKey"
    OR NEW."parentId" IS DISTINCT FROM OLD."parentId"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."simulated" IS DISTINCT FROM OLD."simulated"
    OR NEW."series" IS DISTINCT FROM OLD."series"
    OR NEW."number" IS DISTINCT FROM OLD."number"
    OR NEW."providerRef" IS DISTINCT FROM OLD."providerRef"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."totalMinor" IS DISTINCT FROM OLD."totalMinor"
    OR NEW."taxMinor" IS DISTINCT FROM OLD."taxMinor"
    OR NEW."useStock" IS DISTINCT FROM OLD."useStock"
    OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
  ) THEN
    RAISE EXCEPTION 'invoice_issued_immutable: documentul % a fost emis și nu mai poate fi schimbat', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "invoice_issued_immutable_trg" BEFORE UPDATE OR DELETE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION "invoice_issued_immutable"();

-- Liniile unui document sunt înghețate: nu se modifică și nu se șterg direct (ștergerea prin cascadă din document rămâne
-- posibilă la curățarea datelor simulate).
CREATE FUNCTION "invoice_line_frozen"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'invoice_line_frozen: liniile unui document nu se modifică';
  END IF;
  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'invoice_line_frozen: liniile unui document nu se șterg';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "invoice_line_frozen_trg" BEFORE UPDATE OR DELETE ON "invoice_line"
  FOR EACH ROW EXECUTE FUNCTION "invoice_line_frozen"();

-- Jurnalul: doar se adaugă.
CREATE FUNCTION "invoice_event_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'invoice_event_append_only: jurnalul documentului nu se modifică';
  END IF;
  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'invoice_event_append_only: jurnalul documentului nu se șterge';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "invoice_event_append_only_trg" BEFORE UPDATE OR DELETE ON "invoice_event"
  FOR EACH ROW EXECUTE FUNCTION "invoice_event_append_only"();
