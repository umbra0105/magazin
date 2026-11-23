import { randomUUID } from "node:crypto";
import type { Prisma } from "@ecom/db";
import type { TestTx } from "./rollback";

/**
 * Fixture-uri pentru testele produselor digitale: un client, un produs digital (cu extensie), opțional un produs fizic, o comandă cu
 * liniile lor și (opțional) module. Fără date de seed presupuse: totul se creează aici, în tranzacția anulată a testului. Toate
 * momentele sunt relative la ceasul real (nicio dată fixă din viitor).
 */
export const uid = (): string => randomUUID().slice(0, 8);

type Db = TestTx;

export interface DigitalFixtureOptions {
  paymentMethod?: "cod" | "bank_transfer" | "card";
  /** Linii digitale (implicit 1). */
  digitalLines?: number;
  /** Linii fizice (implicit 0). */
  physicalLines?: number;
  /** Fără cont de client pe comandă (cazul invalid). */
  guest?: boolean;
  maxDownloads?: number | null;
}

export interface DigitalFixture {
  userId: string;
  userEmail: string;
  orderId: string;
  orderNumber: string;
  channelId: string;
  digitalLineIds: string[];
  physicalLineIds: string[];
  digitalProductIds: string[];
}

export async function createUser(tx: Db, verified = true): Promise<{ id: string; email: string }> {
  const id = `u_${uid()}${uid()}`;
  const user = await tx.user.create({
    data: {
      id,
      name: "Client Digital",
      email: `d-${uid()}@exemplu.test`,
      emailVerified: verified,
    },
  });
  return { id: user.id, email: user.email };
}

export async function createDigitalProduct(
  tx: Db,
  maxDownloads: number | null = null,
): Promise<string> {
  const product = await tx.product.create({
    data: {
      slug: `dig-${uid()}${uid()}`,
      title: "Curs digital",
      type: "digital",
      status: "active",
    },
  });
  await tx.digitalProduct.create({ data: { productId: product.id, maxDownloads } });
  return product.id;
}

export async function createFile(
  tx: Db,
  productId: string,
  extra: Partial<{
    title: string;
    isPreview: boolean;
    status: string;
    position: number;
    type: "file" | "video";
    provider: string;
  }> = {},
) {
  const type = extra.type ?? "file";
  return tx.digitalAsset.create({
    data: {
      productId,
      title: extra.title ?? "Modul 1",
      type,
      provider: extra.provider ?? "local",
      storageKey: `private/digital/${uid()}${uid()}.${type === "video" ? "mp4" : "pdf"}`,
      originalName: type === "video" ? "lectie.mp4" : "ghid.pdf",
      mimeType: type === "video" ? "video/mp4" : "application/pdf",
      fileSize: 1024n,
      position: extra.position ?? 0,
      isPreview: extra.isPreview ?? false,
      status: extra.status ?? "ready",
    },
  });
}

export async function digitalFixture(
  tx: Db,
  options: DigitalFixtureOptions = {},
): Promise<DigitalFixture> {
  const method = options.paymentMethod ?? "card";
  const user = await createUser(tx);
  const channel = await tx.salesChannel.create({ data: { code: `t_${uid()}`, name: "Canal" } });
  const future = new Date(Date.now() + 3_600_000);
  const digitalCount = options.digitalLines ?? 1;
  const physicalCount = options.physicalLines ?? 0;
  const digitalProductIds: string[] = [];
  for (let i = 0; i < digitalCount; i += 1) {
    digitalProductIds.push(await createDigitalProduct(tx, options.maxDownloads ?? null));
  }
  const lineData = (
    n: number,
    title: string,
    isDigital: boolean,
    productId?: string,
  ): Prisma.OrderLineCreateWithoutOrderInput => ({
    sku: `L-${uid()}-${n}`,
    title,
    quantity: 10_000n,
    unitSymbol: "buc",
    unitDecimals: 0,
    unitPriceMinor: 10_000,
    lineTotalMinor: 10_000,
    netMinor: 8_264,
    taxMinor: 1_736,
    taxRateBps: 2100,
    stockState: "in_stock",
    shippingClass: "standard",
    isDigital,
    productSnapshot: productId ? { productId } : {},
  });
  const digitalData = digitalProductIds.map((productId, i) =>
    lineData(i, `Curs ${i + 1}`, true, productId),
  );
  const physicalData = Array.from({ length: physicalCount }, (_, i) =>
    lineData(100 + i, `Produs fizic ${i + 1}`, false),
  );
  // comanda se creează O DATĂ, cu liniile ei: o comandă fără linii e refuzată de baza de date la comitere
  const order = await tx.order.create({
    data: {
      number: `DG-${uid()}${uid()}`,
      channelId: channel.id,
      ...(options.guest ? {} : { customerId: user.id }),
      email: user.email,
      phone: "0722000000",
      subtotalMinor: 10_000 * (digitalCount + physicalCount),
      shippingMinor: 0,
      taxMinor: 1_736 * (digitalCount + physicalCount),
      totalMinor: 10_000 * (digitalCount + physicalCount),
      taxRateBps: 2100,
      shippingMethodCode: physicalCount > 0 ? "courier" : "digital",
      shippingSnapshot: { kind: physicalCount > 0 ? "courier" : "digital" },
      paymentMethod: method,
      ...(method === "cod" ? {} : { reservationExpiresAt: future }),
      ...(method === "card" ? { paymentRetryDeadlineAt: future } : {}),
      termsAcceptedAt: new Date(),
      termsConsentText: "Sunt de acord",
      termsConsentVersion: "t",
      digitalConsentAt: new Date(),
      digitalConsentText: "Solicit livrarea imediată",
      digitalConsentVersion: "provizoriu-1",
      idempotencyKey: randomUUID(),
      lines: { create: [...digitalData, ...physicalData] },
    },
    include: { lines: { select: { id: true, sku: true } } },
  });
  const idOf = (sku: string): string => order.lines.find((l) => l.sku === sku)?.id ?? "";
  const digitalLineIds = digitalData.map((d) => idOf(d.sku));
  const physicalLineIds = physicalData.map((d) => idOf(d.sku));
  return {
    userId: user.id,
    userEmail: user.email,
    orderId: order.id,
    orderNumber: order.number,
    channelId: channel.id,
    digitalLineIds,
    physicalLineIds,
    digitalProductIds,
  };
}
