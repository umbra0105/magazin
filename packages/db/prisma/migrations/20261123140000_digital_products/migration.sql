-- Faza 14b: PRODUSE DIGITALE. Migrare ADITIVĂ: patru tabele noi, patru coloane noi pe `customer_order` și `order_line`; nimic nu se
-- șterge sau se rescrie. Cheile de stocare (`storageKey`) și secretele rămân pe server.

-- Comanda: bifa de renunțare la dreptul de retragere (separată de Termeni), doar la comenzile cu linii digitale.
ALTER TABLE "customer_order" ADD COLUMN "digitalConsentAt" TIMESTAMP(3);
ALTER TABLE "customer_order" ADD COLUMN "digitalConsentText" TEXT;
ALTER TABLE "customer_order" ADD COLUMN "digitalConsentVersion" TEXT;
-- Linia de comandă: produs digital (fără transport, fără stoc).
ALTER TABLE "order_line" ADD COLUMN "isDigital" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "digital_product" (
    "productId" TEXT NOT NULL,
    "deliveryType" TEXT NOT NULL DEFAULT 'download',
    "accessType" TEXT NOT NULL DEFAULT 'lifetime',
    "accessDays" INTEGER,
    "maxDownloads" INTEGER,
    "requiresLogin" BOOLEAN NOT NULL DEFAULT true,
    "whatYouGet" TEXT,
    "requirements" TEXT,
    "format" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "digital_product_pkey" PRIMARY KEY ("productId")
);

CREATE TABLE "digital_asset" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT,
    "storageKey" TEXT,
    "externalUrl" TEXT,
    "originalName" TEXT,
    "mimeType" TEXT,
    "fileSize" BIGINT,
    "durationSeconds" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isPreview" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "digital_asset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "digital_entitlement" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "grantReason" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "maxDownloads" INTEGER,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "revokedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "digital_entitlement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "digital_access_log" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "assetId" TEXT,
    "action" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "digital_access_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "digital_asset_productId_position_idx" ON "digital_asset"("productId", "position");
CREATE UNIQUE INDEX "digital_entitlement_orderLineId_key" ON "digital_entitlement"("orderLineId");
CREATE UNIQUE INDEX "digital_entitlement_accessToken_key" ON "digital_entitlement"("accessToken");
CREATE INDEX "digital_entitlement_customerId_grantedAt_idx" ON "digital_entitlement"("customerId", "grantedAt");
CREATE INDEX "digital_entitlement_orderId_idx" ON "digital_entitlement"("orderId");
CREATE INDEX "digital_entitlement_productId_idx" ON "digital_entitlement"("productId");
CREATE INDEX "digital_access_log_entitlementId_createdAt_idx" ON "digital_access_log"("entitlementId", "createdAt");
CREATE INDEX "digital_access_log_createdAt_idx" ON "digital_access_log"("createdAt");

ALTER TABLE "digital_product" ADD CONSTRAINT "digital_product_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "digital_asset" ADD CONSTRAINT "digital_asset_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "digital_product"("productId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "digital_entitlement" ADD CONSTRAINT "digital_entitlement_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "customer_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "digital_entitlement" ADD CONSTRAINT "digital_entitlement_orderLineId_fkey"
    FOREIGN KEY ("orderLineId") REFERENCES "order_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "digital_entitlement" ADD CONSTRAINT "digital_entitlement_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "digital_entitlement" ADD CONSTRAINT "digital_entitlement_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "digital_access_log" ADD CONSTRAINT "digital_access_log_entitlementId_fkey"
    FOREIGN KEY ("entitlementId") REFERENCES "digital_entitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "digital_access_log" ADD CONSTRAINT "digital_access_log_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "digital_asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ======================================================================================================== CONSTRÂNGERI
-- Valori permise. Comparații explicite pe fiecare coloană (un CHECK cu rezultat NULL TRECE).

-- Bifa legală: toate trei nule (fără linii digitale) sau toate trei setate (momentul, textul și versiunea).
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_digital_consent_check" CHECK (
    ("digitalConsentAt" IS NULL AND "digitalConsentText" IS NULL AND "digitalConsentVersion" IS NULL)
    OR ("digitalConsentAt" IS NOT NULL AND "digitalConsentText" IS NOT NULL AND "digitalConsentVersion" IS NOT NULL
        AND length(btrim("digitalConsentText")) > 0 AND length(btrim("digitalConsentVersion")) > 0)
);

ALTER TABLE "digital_product" ADD CONSTRAINT "digital_product_delivery_check"
    CHECK ("deliveryType" IN ('download', 'stream', 'external_link'));
-- lifetime ⇒ fără zile; limited_days ⇒ zile între 1 și 3650
ALTER TABLE "digital_product" ADD CONSTRAINT "digital_product_access_check" CHECK (
    ("accessType" = 'lifetime' AND "accessDays" IS NULL)
    OR ("accessType" = 'limited_days' AND "accessDays" IS NOT NULL AND "accessDays" BETWEEN 1 AND 3650)
);
ALTER TABLE "digital_product" ADD CONSTRAINT "digital_product_max_downloads_check"
    CHECK ("maxDownloads" IS NULL OR "maxDownloads" BETWEEN 1 AND 100000);
-- decis: vizionarea cere mereu cont
ALTER TABLE "digital_product" ADD CONSTRAINT "digital_product_requires_login_check" CHECK ("requiresLogin" = true);

ALTER TABLE "digital_asset" ADD CONSTRAINT "digital_asset_type_check" CHECK ("type" IN ('video', 'file', 'link'));
ALTER TABLE "digital_asset" ADD CONSTRAINT "digital_asset_status_check" CHECK ("status" IN ('processing', 'ready', 'failed'));
ALTER TABLE "digital_asset" ADD CONSTRAINT "digital_asset_title_check" CHECK (length(btrim("title")) > 0);
-- legătură ⇔ fără furnizor și fără cheie, cu adresă; video/fișier ⇔ furnizor și cheie, fără adresă. bunny doar pentru video, s3 doar
-- pentru fișiere (local poate ambele).
ALTER TABLE "digital_asset" ADD CONSTRAINT "digital_asset_content_check" CHECK (
    ("type" = 'link' AND "provider" IS NULL AND "storageKey" IS NULL AND "externalUrl" IS NOT NULL)
    OR ("type" = 'video' AND "provider" IS NOT NULL AND "provider" IN ('local', 'bunny')
        AND "storageKey" IS NOT NULL AND "externalUrl" IS NULL)
    OR ("type" = 'file' AND "provider" IS NOT NULL AND "provider" IN ('local', 's3')
        AND "storageKey" IS NOT NULL AND "externalUrl" IS NULL)
);
ALTER TABLE "digital_asset" ADD CONSTRAINT "digital_asset_key_check"
    CHECK ("storageKey" IS NULL OR length(btrim("storageKey")) > 0);
ALTER TABLE "digital_asset" ADD CONSTRAINT "digital_asset_url_check"
    CHECK ("externalUrl" IS NULL OR "externalUrl" LIKE 'https://%');
ALTER TABLE "digital_asset" ADD CONSTRAINT "digital_asset_numbers_check" CHECK (
    "position" >= 0
    AND ("fileSize" IS NULL OR "fileSize" >= 0)
    AND ("durationSeconds" IS NULL OR "durationSeconds" >= 0)
);

ALTER TABLE "digital_entitlement" ADD CONSTRAINT "digital_entitlement_reason_check"
    CHECK ("grantReason" IN ('payment', 'delivery', 'admin'));
ALTER TABLE "digital_entitlement" ADD CONSTRAINT "digital_entitlement_token_check" CHECK (length("accessToken") >= 32);
-- limita de descărcări e GARANTATĂ în bază: contorul nu depășește niciodată limita (UPDATE-ul condiționat din aplicație o respectă,
-- iar CHECK-ul oprește orice altă cale)
ALTER TABLE "digital_entitlement" ADD CONSTRAINT "digital_entitlement_downloads_check" CHECK (
    "downloadCount" >= 0
    AND ("maxDownloads" IS NULL OR ("maxDownloads" >= 1 AND "downloadCount" <= "maxDownloads"))
);
-- revocat ⇔ moment și motiv; «cine» doar la revocare
ALTER TABLE "digital_entitlement" ADD CONSTRAINT "digital_entitlement_revoked_check" CHECK (
    ("revokedAt" IS NULL AND "revokedReason" IS NULL AND "revokedBy" IS NULL)
    OR ("revokedAt" IS NOT NULL AND "revokedReason" IS NOT NULL AND length(btrim("revokedReason")) > 0)
);
ALTER TABLE "digital_entitlement" ADD CONSTRAINT "digital_entitlement_expiry_check"
    CHECK ("expiresAt" IS NULL OR "expiresAt" > "grantedAt");

ALTER TABLE "digital_access_log" ADD CONSTRAINT "digital_access_log_action_check" CHECK ("action" IN ('view', 'download'));
ALTER TABLE "digital_access_log" ADD CONSTRAINT "digital_access_log_size_check" CHECK (
    ("ip" IS NULL OR length("ip") <= 64) AND ("userAgent" IS NULL OR length("userAgent") <= 400)
);

-- Un produs cu extensie digitală e de tip `digital`, iar un produs digital nu poate rămâne cu linii de comandă fizice: tipul se
-- verifică în aplicație (`DigitalContentService`); aici doar legătura 1:1 e păzită de cheia primară.
