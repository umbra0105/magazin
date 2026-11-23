import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import type {
  DeliveryAccessRequest,
  DeliveryStoreInput,
  MediaDeliveryDriverCode,
  MediaDeliveryProvider,
} from "@ecom/shared";
import { transitionOrder } from "../orders/order-service";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { createFile, createUser, digitalFixture, uid } from "../test-utils/digital-fixtures";
import { requestAccess, type AccessDeps } from "./digital-access";
import {
  extendEntitlement,
  listAccessLog,
  listEntitlements,
  listEntitlementsForOrder,
  resetDownloads,
  restoreEntitlement,
  revokeEntitlement,
} from "./digital-admin";
import {
  addLinkAsset,
  addUploadedAsset,
  deleteAsset,
  getDigitalContent,
  refreshAssetStatus,
  reorderAssets,
  saveDigitalSettings,
  updateAsset,
} from "./digital-content";

/**
 * Faza 14b, ce poate face adminul: conținutul produsului (module, ordine, preview, încărcare cu limite) și drepturile de acces
 * (resetare, prelungire, revocare, restabilire, liste, jurnal). Furnizorul de livrare e FALS (nu atinge niciun serviciu).
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const NOW = new Date(Date.now() + 5_000);
const actor = { label: "admin@exemplu.test" };

interface Fake extends MediaDeliveryProvider {
  stored: DeliveryStoreInput[];
  removed: string[];
  statusNext: "ready" | "processing" | "failed";
  failRemove: boolean;
}

function fake(code: MediaDeliveryDriverCode = "local"): Fake {
  const provider = {
    code,
    label: "Fals",
    stored: [] as DeliveryStoreInput[],
    removed: [] as string[],
    statusNext: "ready" as "ready" | "processing" | "failed",
    failRemove: false,
    async store(input: DeliveryStoreInput) {
      provider.stored.push(input);
      return {
        storageKey: `private/digital/${uid()}${uid()}.bin`,
        status: code === "bunny" ? ("processing" as const) : ("ready" as const),
        fileSize: input.body.length,
        durationSeconds: null,
      };
    },
    async status() {
      return provider.statusNext;
    },
    async remove(key: string) {
      if (provider.failRemove) throw new Error("nu merge");
      provider.removed.push(key);
    },
    async createAccess(request: DeliveryAccessRequest) {
      return {
        kind: "url" as const,
        url: "https://cdn.exemplu.test/x",
        expiresAt: new Date(request.now.getTime() + request.expiresInSeconds * 1000),
        watermarked: false,
      };
    },
  };
  return provider as unknown as Fake;
}

const content = (tx: TestTx, provider: MediaDeliveryProvider) => ({
  db: tx,
  getProvider: async () => provider,
});

const upload = (name: string, bytes = 8, mime = "application/pdf") => ({
  title: "",
  fileName: name,
  mimeType: mime,
  body: Buffer.alloc(bytes, 1),
  isPreview: false,
});

async function setSetting(tx: TestTx, key: string, value: unknown) {
  await tx.setting.upsert({
    where: { key },
    update: { value: value as never },
    create: { key, group: "digital", value: value as never },
  });
}

describe("conținutul produsului", () => {
  it("setările produsului digital: creare, modificare, câmpurile schimbate; limita goală = nelimitat", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const product = await tx.product.create({
        data: { slug: `d-${uid()}${uid()}`, title: "Curs", type: "digital" },
      });
      const first = await saveDigitalSettings(tx, product.id, {
        deliveryType: "stream",
        maxDownloads: 5,
        whatYouGet: "10 lecții",
      });
      expect(first.created).toBe(true);
      const second = await saveDigitalSettings(tx, product.id, {
        deliveryType: "stream",
        maxDownloads: null,
        whatYouGet: "10 lecții",
      });
      expect(second).toEqual({ created: false, changed: ["maxDownloads"] });
      const view = await getDigitalContent(tx, product.id);
      expect(view.digital).toMatchObject({
        deliveryType: "stream",
        accessType: "lifetime",
        maxDownloads: null,
        whatYouGet: "10 lecții",
      });
    });
  });

  it.each([0, -1, 100_001, 2.5])("limita de descărcări %s e refuzată", async (maxDownloads) => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx);
      await expect(
        saveDigitalSettings(tx, f.digitalProductIds[0] as string, {
          deliveryType: "download",
          maxDownloads,
        }),
      ).rejects.toMatchObject({ code: "DIGITAL_INPUT_INVALID" });
    });
  });

  it("un produs fizic nu are conținut digital", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const physical = await tx.product.create({
        data: { slug: `f-${uid()}${uid()}`, title: "Fizic" },
      });
      await expect(
        saveDigitalSettings(tx, physical.id, { deliveryType: "download", maxDownloads: null }),
      ).rejects.toMatchObject({ code: "DIGITAL_NOT_DIGITAL_PRODUCT" });
      await expect(
        addLinkAsset(tx, physical.id, { title: "x", url: "https://a.test", isPreview: false }),
      ).rejects.toMatchObject({ code: "DIGITAL_NOT_DIGITAL_PRODUCT" });
    });
  });

  it("încărcarea: tipul după fișier, furnizorul din setări, poziții în ordine, fără cheie de stocare în răspuns", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx);
      const productId = f.digitalProductIds[0] as string;
      const provider = fake();
      const pdf = await addUploadedAsset(
        content(tx, provider),
        productId,
        upload("ghid-piscină.pdf"),
      );
      const video = await addUploadedAsset(
        content(tx, provider),
        productId,
        upload("lecția-1.mp4", 8, "video/mp4"),
      );
      expect(pdf).toMatchObject({
        type: "file",
        provider: "local",
        title: "ghid-piscină",
        status: "ready",
      });
      expect(video).toMatchObject({ type: "video", provider: "local" });
      expect(video.position).toBe(pdf.position + 1);
      expect(provider.stored.map((s) => s.type)).toEqual(["file", "video"]);
      const json = JSON.stringify(await getDigitalContent(tx, productId));
      expect(json).not.toContain("storageKey");
      expect(json).not.toContain("private/digital");
    });
  });

  it("video la Bunny: furnizorul din setări, rândul rămâne «în procesare» până răspunde starea; apoi «gata»", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx);
      const productId = f.digitalProductIds[0] as string;
      await setSetting(tx, "digital.videoProvider", "bunny");
      const bunny = fake("bunny");
      const asset = await addUploadedAsset(
        content(tx, bunny),
        productId,
        upload("v.mp4", 8, "video/mp4"),
      );
      expect(asset).toMatchObject({ provider: "bunny", status: "processing" });
      bunny.statusNext = "processing";
      expect(await refreshAssetStatus(content(tx, bunny), productId, asset.id)).toBe("processing");
      bunny.statusNext = "ready";
      expect(await refreshAssetStatus(content(tx, bunny), productId, asset.id)).toBe("ready");
      const row = await tx.digitalAsset.findUniqueOrThrow({ where: { id: asset.id } });
      expect(row.status).toBe("ready");
    });
  });

  it("furnizor indisponibil (neconfirmat): încărcarea e refuzată, nimic nu se scrie", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx);
      const productId = f.digitalProductIds[0] as string;
      await setSetting(tx, "digital.fileProvider", "s3");
      await expect(
        addUploadedAsset(
          {
            db: tx,
            getProvider: async () => {
              throw Object.assign(new Error("x"), { code: "DIGITAL_PROVIDER_UNAVAILABLE" });
            },
          },
          productId,
          upload("a.pdf"),
        ),
      ).rejects.toMatchObject({ code: "DIGITAL_PROVIDER_UNAVAILABLE" });
      expect(await tx.digitalAsset.count({ where: { productId } })).toBe(0);
    });
  });

  it.each([
    "pagina.html",
    "poza.svg",
    "script.js",
    "setup.exe",
    "run.bat",
    "x.PHP",
    "fara-extensie.sh",
  ])("fișierul activ %s e refuzat", async (name) => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx);
      const provider = fake();
      await expect(
        addUploadedAsset(content(tx, provider), f.digitalProductIds[0] as string, upload(name)),
      ).rejects.toMatchObject({ code: "DIGITAL_UPLOAD_REFUSED" });
      expect(provider.stored).toHaveLength(0);
    });
  });

  it("fișier gol sau peste limita din setări: refuzat înainte de stocare", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx);
      const productId = f.digitalProductIds[0] as string;
      await setSetting(tx, "digital.maxUploadMb", 1);
      const provider = fake();
      await expect(
        addUploadedAsset(content(tx, provider), productId, upload("gol.pdf", 0)),
      ).rejects.toMatchObject({ code: "DIGITAL_UPLOAD_REFUSED" });
      await expect(
        addUploadedAsset(content(tx, provider), productId, upload("mare.pdf", 1024 * 1024 + 1)),
      ).rejects.toMatchObject({ code: "DIGITAL_UPLOAD_REFUSED" });
      await addUploadedAsset(content(tx, provider), productId, upload("exact.pdf", 1024 * 1024));
      expect(provider.stored).toHaveLength(1);
    });
  });

  it("legătură externă: doar https; titlu obligatoriu", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx);
      const productId = f.digitalProductIds[0] as string;
      await expect(
        addLinkAsset(tx, productId, { title: "x", url: "http://a.test", isPreview: false }),
      ).rejects.toMatchObject({ code: "DIGITAL_INPUT_INVALID" });
      await expect(
        addLinkAsset(tx, productId, { title: "x", url: "javascript:alert(1)", isPreview: false }),
      ).rejects.toMatchObject({ code: "DIGITAL_INPUT_INVALID" });
      await expect(
        addLinkAsset(tx, productId, { title: "  ", url: "https://a.test", isPreview: false }),
      ).rejects.toMatchObject({ code: "DIGITAL_INPUT_INVALID" });
      const ok = await addLinkAsset(tx, productId, {
        title: "Resurse",
        url: "https://resurse.exemplu.test/x",
        isPreview: true,
      });
      expect(ok).toMatchObject({ type: "link", isPreview: true });
    });
  });

  it("titlul și preview-ul se schimbă doar în produsul modulului; ordinea cere lista completă", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx);
      const other = await digitalFixture(tx);
      const productId = f.digitalProductIds[0] as string;
      const a = await createFile(tx, productId, { title: "A", position: 0 });
      const b = await createFile(tx, productId, { title: "B", position: 1 });
      const foreign = await createFile(tx, other.digitalProductIds[0] as string);

      await updateAsset(tx, productId, a.id, { title: "Introducere", isPreview: true });
      const after = await tx.digitalAsset.findUniqueOrThrow({ where: { id: a.id } });
      expect(after).toMatchObject({ title: "Introducere", isPreview: true });
      await expect(updateAsset(tx, productId, foreign.id, { title: "X" })).rejects.toMatchObject({
        code: "DIGITAL_NOT_FOUND",
      });

      await reorderAssets(tx, productId, [b.id, a.id]);
      const order = (await getDigitalContent(tx, productId)).assets.map((x) => x.title);
      expect(order).toEqual(["B", "Introducere"]);
      await expect(reorderAssets(tx, productId, [b.id])).rejects.toMatchObject({
        code: "DIGITAL_INPUT_INVALID",
      });
      await expect(reorderAssets(tx, productId, [b.id, a.id, foreign.id])).rejects.toMatchObject({
        code: "DIGITAL_INPUT_INVALID",
      });
      await expect(reorderAssets(tx, productId, [b.id, b.id])).rejects.toMatchObject({
        code: "DIGITAL_INPUT_INVALID",
      });
    });
  });

  it("ștergerea: rândul dispare și conținutul se șterge din furnizor; o eroare la furnizor nu readuce rândul", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx);
      const productId = f.digitalProductIds[0] as string;
      const a = await createFile(tx, productId);
      const b = await createFile(tx, productId);
      const provider = fake();
      expect(await deleteAsset(content(tx, provider), productId, a.id)).toEqual({
        removedContent: true,
      });
      expect(provider.removed).toEqual([a.storageKey]);
      provider.failRemove = true;
      expect(await deleteAsset(content(tx, provider), productId, b.id)).toEqual({
        removedContent: false,
      });
      expect(await tx.digitalAsset.count({ where: { productId } })).toBe(0);
      await expect(deleteAsset(content(tx, provider), productId, a.id)).rejects.toMatchObject({
        code: "DIGITAL_NOT_FOUND",
      });
    });
  });
});

async function grantedOrder(tx: TestTx, options: Parameters<typeof digitalFixture>[1] = {}) {
  const f = await digitalFixture(tx, options);
  await transitionOrder(
    tx,
    f.orderId,
    { status: "confirmed", paymentStatus: "paid" },
    { type: "payment.confirmed", message: "plătită" },
    NOW,
  );
  const ent = await tx.digitalEntitlement.findFirstOrThrow({ where: { orderId: f.orderId } });
  const file = await createFile(tx, f.digitalProductIds[0] as string);
  return { f, ent, file };
}

const accessDeps = (tx: TestTx): AccessDeps => ({
  db: tx,
  readSettings: async () => ({ linkSeconds: 120, maxIpsPerEntitlement: 1000, ipWindowHours: 24 }),
  getProvider: async () => fake(),
  now: () => NOW,
});

const orderEvents = (tx: TestTx, orderId: string, type: string) =>
  tx.orderEvent.findMany({ where: { orderId, type }, orderBy: { createdAt: "asc" } });

describe("acțiunile pe drepturile de acces", () => {
  it("resetarea contorului: înapoi la 0, eveniment cu actorul și motivul; clientul poate descărca din nou", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent, file } = await grantedOrder(tx, { maxDownloads: 1 });
      const ask = () =>
        requestAccess(
          accessDeps(tx),
          { userId: f.userId, token: ent.accessToken, assetId: file.id },
          { ip: null, userAgent: null },
        );
      await ask();
      await expect(ask()).rejects.toMatchObject({ code: "DIGITAL_LIMIT_REACHED" });
      await resetDownloads(tx, ent.id, "Clientul a pierdut fișierul", actor);
      expect(
        (await tx.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } })).downloadCount,
      ).toBe(0);
      await ask();
      const [event] = await orderEvents(tx, f.orderId, "digital.counter_reset");
      expect(event?.actorLabel).toBe(actor.label);
      expect(event?.message).toContain("Clientul a pierdut fișierul");
    });
  });

  it("prelungirea: crește limita sau o scoate; fără limită sau cu valoare greșită e refuzată", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { ent } = await grantedOrder(tx, { maxDownloads: 2 });
      await extendEntitlement(tx, ent.id, { addDownloads: 3 }, "Cerere client", actor);
      expect(
        (await tx.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } })).maxDownloads,
      ).toBe(5);
      await expect(
        extendEntitlement(tx, ent.id, { addDownloads: 0 }, "Cerere client", actor),
      ).rejects.toMatchObject({ code: "DIGITAL_INPUT_INVALID" });
      await expect(
        extendEntitlement(tx, ent.id, { addDownloads: 10_001 }, "Cerere client", actor),
      ).rejects.toMatchObject({ code: "DIGITAL_INPUT_INVALID" });
      await extendEntitlement(tx, ent.id, { unlimited: true }, "Cerere client", actor);
      expect(
        (await tx.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } })).maxDownloads,
      ).toBeNull();
      await expect(
        extendEntitlement(tx, ent.id, { addDownloads: 1 }, "Cerere client", actor),
      ).rejects.toMatchObject({ code: "DIGITAL_INPUT_INVALID" });
    });
  });

  it("motivul e obligatoriu (3–300 de caractere) la orice acțiune", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { ent } = await grantedOrder(tx, { maxDownloads: 2 });
      for (const reason of ["", "  ", "ab", "x".repeat(301)]) {
        await expect(resetDownloads(tx, ent.id, reason, actor)).rejects.toMatchObject({
          code: "DIGITAL_INPUT_INVALID",
        });
        await expect(revokeEntitlement(tx, ent.id, reason, actor, NOW)).rejects.toMatchObject({
          code: "DIGITAL_INPUT_INVALID",
        });
      }
    });
  });

  it("revocarea oprește linkurile și e idempotentă (un singur eveniment); restabilirea le repornește", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent, file } = await grantedOrder(tx);
      const ask = () =>
        requestAccess(
          accessDeps(tx),
          { userId: f.userId, token: ent.accessToken, assetId: file.id },
          { ip: null, userAgent: null },
        );
      await ask();
      await revokeEntitlement(tx, ent.id, "Rambursat în afara magazinului", actor, NOW);
      await revokeEntitlement(tx, ent.id, "Rambursat în afara magazinului", actor, NOW);
      await expect(ask()).rejects.toMatchObject({ code: "DIGITAL_REVOKED" });
      const row = await tx.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } });
      expect(row).toMatchObject({
        revokedReason: "Rambursat în afara magazinului",
        revokedBy: actor.label,
      });
      expect(await orderEvents(tx, f.orderId, "digital.revoked")).toHaveLength(1);

      await restoreEntitlement(tx, ent.id, "Rambursarea a eșuat", actor);
      await restoreEntitlement(tx, ent.id, "Rambursarea a eșuat", actor);
      await ask();
      expect(await orderEvents(tx, f.orderId, "digital.restored")).toHaveLength(1);
      expect(
        (await tx.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } })).revokedAt,
      ).toBeNull();
    });
  });

  it("un drept inexistent: DIGITAL_NOT_FOUND", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await expect(resetDownloads(tx, "nu-exista", "motiv valid", actor)).rejects.toMatchObject({
        code: "DIGITAL_NOT_FOUND",
      });
    });
  });
});

describe("liste și jurnal", () => {
  it("lista pe comandă și lista generală (căutare după comandă sau email, stare, produs, pagină)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await grantedOrder(tx);
      const b = await grantedOrder(tx);
      await revokeEntitlement(tx, b.ent.id, "Test revocare", actor, NOW);

      const forOrder = await listEntitlementsForOrder(tx, a.f.orderId);
      expect(forOrder).toHaveLength(1);
      expect(forOrder[0]).toMatchObject({
        orderNumber: a.f.orderNumber,
        customerEmail: a.f.userEmail,
        revokedAt: null,
        grantReason: "payment",
      });

      const byNumber = await listEntitlements(tx, { query: a.f.orderNumber });
      expect(byNumber.rows.map((r) => r.id)).toEqual([a.ent.id]);
      const byEmail = await listEntitlements(tx, { query: b.f.userEmail.toUpperCase() });
      expect(byEmail.rows.map((r) => r.id)).toEqual([b.ent.id]);
      expect(
        (await listEntitlements(tx, { query: a.f.orderNumber, status: "revoked" })).total,
      ).toBe(0);
      expect(
        (await listEntitlements(tx, { query: b.f.orderNumber, status: "revoked" })).total,
      ).toBe(1);
      expect(
        (await listEntitlements(tx, { productId: a.f.digitalProductIds[0] as string })).rows.map(
          (r) => r.id,
        ),
      ).toEqual([a.ent.id]);
      const paged = await listEntitlements(tx, { pageSize: 1, page: 2 });
      expect(paged.rows).toHaveLength(1);
      expect(paged.total).toBeGreaterThanOrEqual(2);
    });
  });

  it("jurnalul de accesări: cele mai noi primele, cu modulul și IP-ul (doar pentru admin)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent, file } = await grantedOrder(tx);
      for (const [i, ip] of ["1.1.1.1", "2.2.2.2"].entries()) {
        await requestAccess(
          { ...accessDeps(tx), now: () => new Date(NOW.getTime() + i * 1000) },
          { userId: f.userId, token: ent.accessToken, assetId: file.id },
          { ip, userAgent: "UA" },
        );
      }
      const log = await listAccessLog(tx, ent.id);
      expect(log.map((e) => e.ip)).toEqual(["2.2.2.2", "1.1.1.1"]);
      expect(log[0]).toMatchObject({ action: "download", assetTitle: "Modul 1", userAgent: "UA" });
      expect(JSON.stringify(log)).not.toContain("private/digital");
      expect((await listEntitlementsForOrder(tx, f.orderId))[0]?.lastAccessAt).not.toBeNull();
    });
  });

  it("niciun drept al altui client nu apare în lista unui singur client (lista pe client = căutare după emailul lui)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await grantedOrder(tx);
      await grantedOrder(tx);
      const stranger = await createUser(tx);
      const mine = await listEntitlements(tx, { query: a.f.userEmail });
      expect(mine.rows.every((r) => r.customerEmail === a.f.userEmail)).toBe(true);
      expect((await listEntitlements(tx, { query: stranger.email })).total).toBe(0);
    });
  });
});
