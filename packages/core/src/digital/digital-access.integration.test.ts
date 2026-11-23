import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import {
  IntegrationError,
  type DeliveryAccessRequest,
  type MediaDeliveryProvider,
} from "@ecom/shared";
import { transitionOrder } from "../orders/order-service";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  createFile,
  createUser,
  digitalFixture,
  uid,
  type DigitalFixture,
} from "../test-utils/digital-fixtures";
import {
  getEntitlementDetail,
  listLibrary,
  requestAccess,
  requestPreview,
  type AccessDeps,
} from "./digital-access";

/**
 * Faza 14b, accesul clientului: biblioteca, detaliul, emiterea linkurilor (proprietate, revocare, expirare cu ceas injectat, limită
 * de descărcări, contor), previzualizarea publică și alerta de IP-uri multiple. Un furnizor FALS înregistrează cererile (nu atinge
 * niciun serviciu).
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const NOW = new Date(Date.now() + 5_000);

interface FakeProvider extends MediaDeliveryProvider {
  calls: DeliveryAccessRequest[];
  failWith: IntegrationError | null;
}

function fakeProvider(): FakeProvider {
  const provider = {
    code: "local" as const,
    label: "Fals",
    calls: [] as DeliveryAccessRequest[],
    failWith: null as IntegrationError | null,
    async createAccess(request: DeliveryAccessRequest) {
      provider.calls.push(request);
      if (provider.failWith) throw provider.failWith;
      return {
        kind: request.asset.type === "video" ? ("embed" as const) : ("url" as const),
        url: `https://cdn.exemplu.test/${request.expiresInSeconds}/${request.mode}`,
        expiresAt: new Date(request.now.getTime() + request.expiresInSeconds * 1000),
        watermarked: request.viewerEmail !== null,
      };
    },
  };
  return provider as unknown as FakeProvider;
}

function deps(
  tx: TestTx,
  provider: FakeProvider,
  patch: Partial<{ now: Date; maxIps: number }> = {},
): AccessDeps {
  return {
    db: tx,
    readSettings: async () => ({
      linkSeconds: 120,
      maxIpsPerEntitlement: patch.maxIps ?? 3,
      ipWindowHours: 24,
    }),
    getProvider: async () => provider,
    now: () => patch.now ?? NOW,
  };
}

async function paid(tx: TestTx, options: Parameters<typeof digitalFixture>[1] = {}) {
  const f = await digitalFixture(tx, options);
  await transitionOrder(
    tx,
    f.orderId,
    { status: "confirmed", paymentStatus: "paid" },
    { type: "payment.confirmed", message: "plătită" },
    NOW,
  );
  const ent = await tx.digitalEntitlement.findFirstOrThrow({
    where: { orderId: f.orderId },
    orderBy: { createdAt: "asc" },
  });
  return { f, ent };
}

const meta = { ip: "203.0.113.10", userAgent: "Browser de test" };

describe("biblioteca și detaliul", () => {
  it("biblioteca arată drepturile clientului și liniile așteptate (plată sau livrare), nu și pe ale altora", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f } = await paid(tx);
      const other = await paid(tx);
      // ramburs mixt, încă nelivrat: «în așteptarea livrării»
      const cod = await digitalFixture(tx, { paymentMethod: "cod", physicalLines: 1 });
      await tx.order.update({ where: { id: cod.orderId }, data: { customerId: f.userId } });
      // card, încă neplătit: «în așteptarea plății»
      const card = await digitalFixture(tx, { paymentMethod: "card" });
      await tx.order.update({ where: { id: card.orderId }, data: { customerId: f.userId } });

      const library = await listLibrary(tx, f.userId);
      expect(library.items).toHaveLength(1);
      expect(library.items[0]).toMatchObject({
        orderNumber: f.orderNumber,
        status: "active",
        remainingDownloads: null,
      });
      expect(library.pending.map((p) => p.awaiting).sort()).toEqual(["delivery", "payment"]);
      expect(JSON.stringify(library)).not.toContain(other.f.orderNumber);
      expect((await listLibrary(tx, other.f.userId)).items).toHaveLength(1);
    });
  });

  it("linia dintr-o comandă anulată sau rambursată nu mai apare ca «în așteptare»", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { paymentMethod: "cod", physicalLines: 1 });
      await transitionOrder(
        tx,
        f.orderId,
        { status: "cancelled" },
        { type: "order.cancelled", message: "anulată" },
        NOW,
      );
      expect((await listLibrary(tx, f.userId)).pending).toHaveLength(0);
    });
  });

  it("detaliul: modulele în ordine, fără cheie de stocare; jeton străin, inexistent sau cu formă greșită: null", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx);
      const second = await createFile(tx, f.digitalProductIds[0] as string, {
        title: "Modul 2",
        position: 2,
      });
      const first = await createFile(tx, f.digitalProductIds[0] as string, {
        title: "Modul 1",
        position: 1,
      });
      const stranger = await createUser(tx);

      const detail = await getEntitlementDetail(tx, f.userId, ent.accessToken);
      expect(detail?.assets.map((a) => a.title)).toEqual(["Modul 1", "Modul 2"]);
      const json = JSON.stringify(detail);
      expect(json).not.toContain("storageKey");
      expect(json).not.toContain("private/digital");
      expect(json).not.toContain(first.storageKey ?? "x");
      expect(json).not.toContain(second.storageKey ?? "x");

      expect(await getEntitlementDetail(tx, stranger.id, ent.accessToken)).toBeNull();
      expect(await getEntitlementDetail(tx, f.userId, `${"a".repeat(43)}`)).toBeNull();
      expect(await getEntitlementDetail(tx, f.userId, "scurt")).toBeNull();
    });
  });
});

describe("emiterea linkurilor de acces", () => {
  it("un fișier: link cu expirarea din setare, contor +1, jurnal cu IP și user-agent, rămase calculate", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx, { maxDownloads: 3 });
      const file = await createFile(tx, f.digitalProductIds[0] as string);
      const provider = fakeProvider();

      const result = await requestAccess(
        deps(tx, provider),
        { userId: f.userId, token: ent.accessToken, assetId: file.id },
        meta,
      );
      expect(result).toMatchObject({
        kind: "url",
        action: "download",
        remainingDownloads: 2,
        watermarked: true,
      });
      expect(result.expiresAt?.getTime()).toBe(NOW.getTime() + 120_000);
      expect(provider.calls[0]).toMatchObject({ mode: "download", expiresInSeconds: 120 });
      expect(provider.calls[0]?.viewerEmail).toBe(f.userEmail);

      const fresh = await tx.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } });
      expect(fresh.downloadCount).toBe(1);
      const logs = await tx.digitalAccessLog.findMany({ where: { entitlementId: ent.id } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: "download",
        ip: meta.ip,
        userAgent: meta.userAgent,
        assetId: file.id,
      });
    });
  });

  it("un video: redare (jurnal «view»), fără consum din limita de descărcări", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx, { maxDownloads: 1 });
      const video = await createFile(tx, f.digitalProductIds[0] as string, { type: "video" });
      const provider = fakeProvider();
      for (let i = 0; i < 3; i += 1) {
        const result = await requestAccess(
          deps(tx, provider),
          { userId: f.userId, token: ent.accessToken, assetId: video.id },
          meta,
        );
        expect(result).toMatchObject({ kind: "embed", action: "view", remainingDownloads: null });
      }
      expect(provider.calls[0]?.mode).toBe("play");
      const fresh = await tx.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } });
      expect(fresh.downloadCount).toBe(0);
      expect(
        await tx.digitalAccessLog.count({ where: { entitlementId: ent.id, action: "view" } }),
      ).toBe(3);
    });
  });

  it("o legătură externă: se întoarce adresa, fără furnizor și fără consum", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx);
      const link = await tx.digitalAsset.create({
        data: {
          productId: f.digitalProductIds[0] as string,
          title: "Resursă",
          type: "link",
          externalUrl: "https://resurse.exemplu.test/ghid",
        },
      });
      const provider = fakeProvider();
      const result = await requestAccess(
        deps(tx, provider),
        { userId: f.userId, token: ent.accessToken, assetId: link.id },
        meta,
      );
      expect(result).toMatchObject({
        kind: "link",
        url: "https://resurse.exemplu.test/ghid",
        expiresAt: null,
        action: "view",
      });
      expect(provider.calls).toHaveLength(0);
    });
  });

  it("limita de descărcări: după ultima unitate cererea e refuzată, contorul rămâne la limită, iar jurnalul nu crește", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx, { maxDownloads: 2 });
      const file = await createFile(tx, f.digitalProductIds[0] as string);
      const provider = fakeProvider();
      const ask = () =>
        requestAccess(
          deps(tx, provider),
          { userId: f.userId, token: ent.accessToken, assetId: file.id },
          meta,
        );
      expect((await ask()).remainingDownloads).toBe(1);
      expect((await ask()).remainingDownloads).toBe(0);
      await expect(ask()).rejects.toMatchObject({ code: "DIGITAL_LIMIT_REACHED" });
      await expect(ask()).rejects.toMatchObject({ code: "DIGITAL_LIMIT_REACHED" });
      const fresh = await tx.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } });
      expect(fresh.downloadCount).toBe(2);
      expect(await tx.digitalAccessLog.count({ where: { entitlementId: ent.id } })).toBe(2);
    });
  });

  it("un drept al ALTUI client: același cod ca pentru un jeton inexistent; nici furnizorul, nici contorul, nici jurnalul nu se ating", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx, { maxDownloads: 5 });
      const file = await createFile(tx, f.digitalProductIds[0] as string);
      const stranger = await createUser(tx);
      const provider = fakeProvider();

      const foreign = await requestAccess(
        deps(tx, provider),
        { userId: stranger.id, token: ent.accessToken, assetId: file.id },
        meta,
      ).catch((e: unknown) => e);
      const missing = await requestAccess(
        deps(tx, provider),
        { userId: stranger.id, token: "x".repeat(43), assetId: file.id },
        meta,
      ).catch((e: unknown) => e);
      expect(foreign).toMatchObject({ code: "DIGITAL_NOT_FOUND" });
      expect(missing).toMatchObject({ code: "DIGITAL_NOT_FOUND" });
      expect((foreign as Error).message).toBe((missing as Error).message);
      expect(provider.calls).toHaveLength(0);
      const fresh = await tx.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } });
      expect(fresh.downloadCount).toBe(0);
      expect(await tx.digitalAccessLog.count({ where: { entitlementId: ent.id } })).toBe(0);
    });
  });

  it("un modul al altui produs nu se poate cere cu dreptul acestui produs", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx);
      const other = await digitalFixture(tx);
      const foreignAsset = await createFile(tx, other.digitalProductIds[0] as string);
      await expect(
        requestAccess(
          deps(tx, fakeProvider()),
          { userId: f.userId, token: ent.accessToken, assetId: foreignAsset.id },
          meta,
        ),
      ).rejects.toMatchObject({ code: "DIGITAL_NOT_FOUND" });
    });
  });

  it("un drept revocat nu mai dă linkuri (furnizorul nu e chemat, contorul nu se mișcă)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx);
      const file = await createFile(tx, f.digitalProductIds[0] as string);
      await tx.digitalEntitlement.update({
        where: { id: ent.id },
        data: { revokedAt: NOW, revokedReason: "Rambursat" },
      });
      const provider = fakeProvider();
      await expect(
        requestAccess(
          deps(tx, provider),
          { userId: f.userId, token: ent.accessToken, assetId: file.id },
          meta,
        ),
      ).rejects.toMatchObject({ code: "DIGITAL_REVOKED" });
      expect(provider.calls).toHaveLength(0);
      expect((await listLibrary(tx, f.userId)).items[0]?.status).toBe("revoked");
    });
  });

  it("expirarea (ceas injectat): înainte de moment merge, la moment și după e refuzat", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx);
      const file = await createFile(tx, f.digitalProductIds[0] as string);
      const expiresAt = new Date(NOW.getTime() + 60_000);
      await tx.digitalEntitlement.update({ where: { id: ent.id }, data: { expiresAt } });
      const ask = (now: Date) =>
        requestAccess(
          deps(tx, fakeProvider(), { now }),
          { userId: f.userId, token: ent.accessToken, assetId: file.id },
          meta,
        );
      await expect(ask(new Date(expiresAt.getTime() - 1))).resolves.toMatchObject({ kind: "url" });
      await expect(ask(expiresAt)).rejects.toMatchObject({ code: "DIGITAL_EXPIRED" });
      await expect(ask(new Date(expiresAt.getTime() + 1))).rejects.toMatchObject({
        code: "DIGITAL_EXPIRED",
      });
    });
  });

  it("linkul expiră după `linkSeconds` de la ceasul dat (nu există link fără expirare)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx);
      const file = await createFile(tx, f.digitalProductIds[0] as string);
      const clock = new Date(NOW.getTime() + 7_000_000);
      const result = await requestAccess(
        deps(tx, fakeProvider(), { now: clock }),
        { userId: f.userId, token: ent.accessToken, assetId: file.id },
        meta,
      );
      expect(result.expiresAt?.getTime()).toBe(clock.getTime() + 120_000);
    });
  });

  it("furnizor căzut: eroare blândă și limita NU se consumă", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx, { maxDownloads: 1 });
      const file = await createFile(tx, f.digitalProductIds[0] as string);
      const provider = fakeProvider();
      provider.failWith = new IntegrationError("MEDIA_DELIVERY_UNREACHABLE", "căzut");
      await expect(
        requestAccess(
          deps(tx, provider),
          { userId: f.userId, token: ent.accessToken, assetId: file.id },
          meta,
        ),
      ).rejects.toMatchObject({ code: "DIGITAL_PROVIDER_UNAVAILABLE" });
      const fresh = await tx.digitalEntitlement.findUniqueOrThrow({ where: { id: ent.id } });
      expect(fresh.downloadCount).toBe(0);
      expect(await tx.digitalAccessLog.count({ where: { entitlementId: ent.id } })).toBe(0);
    });
  });

  it("un modul încă «în procesare» nu se livrează", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx);
      const video = await createFile(tx, f.digitalProductIds[0] as string, {
        type: "video",
        status: "processing",
      });
      await expect(
        requestAccess(
          deps(tx, fakeProvider()),
          { userId: f.userId, token: ent.accessToken, assetId: video.id },
          meta,
        ),
      ).rejects.toMatchObject({ code: "DIGITAL_ASSET_UNAVAILABLE" });
    });
  });

  it("IP-ul și user-agent-ul lungi se taie la limita coloanei, fără eroare", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx);
      const file = await createFile(tx, f.digitalProductIds[0] as string);
      await requestAccess(
        deps(tx, fakeProvider()),
        { userId: f.userId, token: ent.accessToken, assetId: file.id },
        { ip: "9".repeat(200), userAgent: "U".repeat(2000) },
      );
      const log = await tx.digitalAccessLog.findFirstOrThrow({ where: { entitlementId: ent.id } });
      expect(log.ip?.length).toBe(64);
      expect(log.userAgent?.length).toBe(400);
    });
  });
});

describe("previzualizarea gratuită", () => {
  async function previewSetup(
    tx: TestTx,
    patch: { productStatus?: string; assetStatus?: string; isPreview?: boolean } = {},
  ) {
    const productId = (await digitalFixture(tx)).digitalProductIds[0] as string;
    if (patch.productStatus) {
      await tx.product.update({ where: { id: productId }, data: { status: patch.productStatus } });
    }
    const asset = await createFile(tx, productId, {
      type: "video",
      isPreview: patch.isPreview ?? true,
      ...(patch.assetStatus ? { status: patch.assetStatus } : {}),
    });
    return { productId, asset };
  }

  it("lecția de preview a unui produs activ se livrează fără cont, fără filigran, fără jurnal și fără contor", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { asset } = await previewSetup(tx);
      const provider = fakeProvider();
      const result = await requestPreview(deps(tx, provider), asset.id);
      expect(result.kind).toBe("embed");
      expect(provider.calls[0]?.viewerEmail).toBeNull();
      expect(await tx.digitalAccessLog.count()).toBe(
        await tx.digitalAccessLog.count({ where: { NOT: { assetId: asset.id } } }),
      );
    });
  });

  it.each([
    ["modul fără marcajul de preview", { isPreview: false }],
    ["produs în ciornă", { productStatus: "draft" }],
    ["produs arhivat", { productStatus: "archived" }],
    ["modul în procesare", { assetStatus: "processing" }],
  ])("%s nu se poate previzualiza", async (_label, patch) => {
    await inRolledBackTransaction(db, async (tx) => {
      const { asset } = await previewSetup(tx, patch);
      await expect(requestPreview(deps(tx, fakeProvider()), asset.id)).rejects.toMatchObject({
        code: "DIGITAL_NOT_FOUND",
      });
    });
  });

  it("produs șters (deletedAt) și id inexistent: DIGITAL_NOT_FOUND", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { productId, asset } = await previewSetup(tx);
      await tx.product.update({ where: { id: productId }, data: { deletedAt: NOW } });
      await expect(requestPreview(deps(tx, fakeProvider()), asset.id)).rejects.toMatchObject({
        code: "DIGITAL_NOT_FOUND",
      });
      await expect(requestPreview(deps(tx, fakeProvider()), "nu-exista")).rejects.toMatchObject({
        code: "DIGITAL_NOT_FOUND",
      });
    });
  });
});

describe("alerta de tipar anormal (adrese IP distincte)", () => {
  async function useFrom(
    tx: TestTx,
    f: DigitalFixture,
    token: string,
    assetId: string,
    ips: string[],
    maxIps: number,
  ) {
    for (const ip of ips) {
      await requestAccess(
        deps(tx, fakeProvider(), { maxIps }),
        { userId: f.userId, token, assetId },
        { ip, userAgent: "x" },
      );
    }
  }
  const count = (tx: TestTx, orderId: string) =>
    tx.adminNotification.count({
      where: { kind: "digital_ip_anomaly", href: `/admin/comenzi/${orderId}` },
    });

  it("la pragul exact nu alertează; peste prag da, o singură dată pe zi, fără date personale", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx);
      const file = await createFile(tx, f.digitalProductIds[0] as string);
      await useFrom(tx, f, ent.accessToken, file.id, ["1.1.1.1", "2.2.2.2", "3.3.3.3"], 3);
      expect(await count(tx, f.orderId)).toBe(0);
      await useFrom(tx, f, ent.accessToken, file.id, ["4.4.4.4", "5.5.5.5"], 3);
      expect(await count(tx, f.orderId)).toBe(1);
      const note = await tx.adminNotification.findFirstOrThrow({
        where: { kind: "digital_ip_anomaly", href: `/admin/comenzi/${f.orderId}` },
      });
      expect(note.permission).toBe("digital.view");
      expect(JSON.stringify(note)).not.toContain(f.userEmail);
      expect(JSON.stringify(note)).not.toContain("4.4.4.4");
    });
  });

  it("aceeași adresă folosită de multe ori nu e anomalie", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx);
      const file = await createFile(tx, f.digitalProductIds[0] as string);
      await useFrom(tx, f, ent.accessToken, file.id, Array(10).fill("8.8.8.8") as string[], 3);
      expect(await count(tx, f.orderId)).toBe(0);
    });
  });

  it("un drept al altui client nu amestecă adresele", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await paid(tx);
      const b = await paid(tx);
      const fileA = await createFile(tx, a.f.digitalProductIds[0] as string);
      const fileB = await createFile(tx, b.f.digitalProductIds[0] as string);
      await useFrom(tx, a.f, a.ent.accessToken, fileA.id, ["1.1.1.1", "2.2.2.2"], 2);
      await useFrom(tx, b.f, b.ent.accessToken, fileB.id, ["3.3.3.3", "4.4.4.4"], 2);
      expect(await count(tx, a.f.orderId)).toBe(0);
      expect(await count(tx, b.f.orderId)).toBe(0);
    });
  });
});

describe("niciun răspuns nu conține cheia de stocare", () => {
  it("rezultatul unei cereri nu poartă storageKey sau furnizorul", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { f, ent } = await paid(tx);
      const file = await createFile(tx, f.digitalProductIds[0] as string, { title: `M-${uid()}` });
      const result = await requestAccess(
        deps(tx, fakeProvider()),
        { userId: f.userId, token: ent.accessToken, assetId: file.id },
        meta,
      );
      const json = JSON.stringify(result);
      expect(json).not.toContain(file.storageKey ?? "x");
      expect(json).not.toContain("private/digital");
    });
  });
});
