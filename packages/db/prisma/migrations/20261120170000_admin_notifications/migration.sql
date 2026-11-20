-- Faza 11: notificările interne ale adminului (clopoțelul). Migrare ADITIVĂ: două tabele noi.
-- O notificare e o înregistrare persistentă, FĂRĂ date personale în titlu (doar tipul și o legătură spre ecranul potrivit), vizibilă
-- celor care au permisiunea ei; citit/necitit se ține PER UTILIZATOR. `dedupKey` face ca aceeași situație să nu producă două
-- notificări (de exemplu o plată cu același motiv, un email blocat, un episod de sincronizare neactualizată).
CREATE TABLE "admin_notification" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_notification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_notification_dedupKey_key" ON "admin_notification"("dedupKey");
CREATE INDEX "admin_notification_createdAt_idx" ON "admin_notification"("createdAt");

ALTER TABLE "admin_notification" ADD CONSTRAINT "admin_notification_lengths_check"
    CHECK (char_length("title") BETWEEN 1 AND 200 AND char_length("href") BETWEEN 1 AND 300 AND "href" LIKE '/admin/%');

CREATE TABLE "admin_notification_read" (
    "notificationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_notification_read_pkey" PRIMARY KEY ("notificationId", "userId")
);

CREATE INDEX "admin_notification_read_userId_idx" ON "admin_notification_read"("userId");

ALTER TABLE "admin_notification_read" ADD CONSTRAINT "admin_notification_read_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "admin_notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_notification_read" ADD CONSTRAINT "admin_notification_read_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
