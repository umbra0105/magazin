/**
 * Utilitar DOAR pentru dezvoltare (nu face parte din pachetul distribuit; se mută odată cu celelalte scripturi dev-only la Faza 21):
 * pregătește datele FICTIVE cu care se verifică în browser produsele digitale (Faza 14b), fără checkout (checkout-ul pentru digital
 * vine în Faza 14c, iar azi refuză produsele digitale cu mesajul existent).
 *
 *   npm run dev:digital-demo -- --email=client@exemplu.ro   # creează produsele, modulele și două comenzi DEMO pentru acel cont
 *   npm run dev:digital-demo -- --remove                    # șterge tot ce a creat scriptul (comenzi, produse, fișiere)
 *
 * Pentru contul indicat (client existent, cu emailul verificat) creează:
 *  - produsul digital «DEMO · Curs digital», cu un fișier mic de descărcat și o lecție de previzualizare gratuită (fișier mic), limita
 *    de descărcări 3, acces pe viață;
 *  - un produs fizic «DEMO · Accesoriu»;
 *  - comanda `DEMO-DIG-…-A`: 100% digitală, plătită cu cardul DEMO (accesul se acordă prin evenimentul real `payment.confirmed`);
 *  - comanda `DEMO-DIG-…-B`: MIXTĂ (digital + fizic), cu ramburs, confirmată dar nelivrată (accesul se acordă abia când o marchezi
 *    livrată din admin, prin expediere sau «Marchează ridicată», evenimentul real `order.delivered`).
 * Comenzile trec prin serviciile existente (`ProductService`, `transitionOrder`, cârligul din `addOrderEvent`), iar conținutul se
 * încarcă prin driverul `local` (stocarea platformei). Tot ce creează poartă eticheta «DEMO»: comenzile au numărul `DEMO-DIG-…`, produsele
 * adresa `demo-digital-…`, fișierele sunt în `private/digital/`. `--remove` nu atinge altceva. Refuză să ruleze în producție; nu
 * afișează chei, parole sau adrese de conexiune. Rambursarea din panoul «Acces digital» cere `ECOM_DEMO_PAYMENTS=1` la server.
 */
import { loadEnv } from "@ecom/config";
import { buildMediaDelivery, createStorage } from "@ecom/integrations";
import { getLogger, vatFromGross } from "@ecom/shared";
import { AuditService } from "../src/audit/audit-service";
import { createPrismaAuditStore } from "../src/audit/prisma-store";
import { ProductService } from "../src/catalog/product-service";
import { createPrismaProductStore } from "../src/catalog/product-store";
import { addUploadedAsset, saveDigitalSettings } from "../src/digital/digital-content";
import { transitionOrder, addOrderEvent } from "../src/orders/order-service";
import type { PermissionSubject } from "../src/rbac/can";
import { getDb, loadRootEnv } from "./_runtime";

loadRootEnv();

if (process.env["NODE_ENV"] === "production" || process.env["APP_ENV"] === "production") {
  console.error("Refuz: scriptul de date digitale fictive nu rulează în producție.");
  process.exit(1);
}

const db = getDb();
const SLUG_PREFIX = "demo-digital-";
const NUMBER_PREFIX = "DEMO-DIG-";

/** Subiect sintetic cu rol Owner; apare în audit ca «seed de dezvoltare». */
const subject: PermissionSubject = {
  userId: "dev-seed",
  email: "seed-de-dezvoltare@local.invalid",
  roles: ["owner"],
  permissions: new Set(),
};

function platformDelivery() {
  const env = loadEnv();
  const provider = buildMediaDelivery({
    code: "local",
    platformStorage: createStorage(env),
    credentials: {},
    appUrl: env.APP_URL,
  });
  return {
    db,
    getProvider: async (code: string) => {
      if (code !== "local") {
        throw new Error(
          `Scriptul DEMO folosește doar driverul «local»; setările cer «${code}». Pune «Local» în Setări → Livrare conținut digital.`,
        );
      }
      return provider;
    },
  };
}

async function remove(): Promise<void> {
  const delivery = platformDelivery();
  const orders = await db.order.findMany({
    where: { number: { startsWith: NUMBER_PREFIX } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  // documentele de vânzare simulate (facturile DEMO) și rambursările nu cad în cascadă din comandă
  await db.invoice.deleteMany({ where: { orderId: { in: orderIds }, simulated: true } });
  await db.refund.deleteMany({ where: { orderId: { in: orderIds } } });
  await db.shipment.deleteMany({ where: { orderId: { in: orderIds } } });
  const removedOrders = await db.order.deleteMany({ where: { id: { in: orderIds } } });

  // conținutul din stocare, apoi produsele (drepturile de acces au căzut odată cu comenzile)
  const assets = await db.digitalAsset.findMany({
    where: { digital: { product: { slug: { startsWith: SLUG_PREFIX } } } },
    select: { provider: true, storageKey: true },
  });
  let removedFiles = 0;
  for (const asset of assets) {
    if (asset.provider !== "local" || !asset.storageKey) continue;
    try {
      await (await delivery.getProvider("local")).remove(asset.storageKey);
      removedFiles += 1;
    } catch {
      // un fișier lipsă nu oprește curățarea
    }
  }
  const products = await db.product.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  console.log(
    `Șters: ${removedOrders.count} comenzi, ${products.count} produse, ${removedFiles} fișiere din stocare.`,
  );
}

const textFile = (title: string): Buffer =>
  Buffer.from(
    `${title}\n\nFișier FICTIV (DEMO) pentru verificarea produselor digitale.\nGenerat de scriptul dev:digital-demo.\n`,
    "utf8",
  );

async function ensureProducts(): Promise<{
  digital: { productId: string; variantId: string; sku: string; title: string };
  physical: { variantId: string; sku: string; title: string };
}> {
  const products = new ProductService({
    store: createPrismaProductStore(db),
    audit: new AuditService(createPrismaAuditStore(db)),
    defaultManageStock: async () => false,
    logger: getLogger(),
  });
  const find = async (slug: string) =>
    db.productVariant.findFirst({
      where: { product: { slug } },
      select: { id: true, sku: true, productId: true, product: { select: { title: true } } },
    });

  let digital = await find(`${SLUG_PREFIX}curs`);
  if (!digital) {
    const created = await products.create(subject, {
      title: "DEMO · Curs digital",
      slug: `${SLUG_PREFIX}curs`,
      description: "Produs digital FICTIV, pentru verificarea accesului, playerului și contorului.",
      status: "active",
      type: "digital",
      variants: [{ sku: "DEMO-DIG-CURS", price: 19_900, ean: "5901234123457" }],
    });
    await saveDigitalSettings(db, created.product.id, {
      deliveryType: "download",
      maxDownloads: 3,
      whatYouGet: "Un ghid de descărcat și o lecție de previzualizare (DEMO).",
      requirements: "Niciuna: e un produs fictiv.",
      format: "Fișiere text",
    });
    const delivery = platformDelivery();
    await addUploadedAsset(delivery, created.product.id, {
      title: "Lecția de previzualizare (DEMO)",
      fileName: "previzualizare-demo.txt",
      mimeType: "text/plain",
      body: textFile("Lecția de previzualizare gratuită"),
      isPreview: true,
    });
    await addUploadedAsset(delivery, created.product.id, {
      title: "Ghid de descărcat (DEMO)",
      fileName: "ghid-demo.txt",
      mimeType: "text/plain",
      body: textFile("Ghidul cursului"),
      isPreview: false,
    });
    digital = await find(`${SLUG_PREFIX}curs`);
  }
  let physical = await find(`${SLUG_PREFIX}accesoriu`);
  if (!physical) {
    await products.create(subject, {
      title: "DEMO · Accesoriu",
      slug: `${SLUG_PREFIX}accesoriu`,
      description: "Produs fizic FICTIV, pentru comanda mixtă.",
      status: "active",
      stockStatus: "instock",
      variants: [{ sku: "DEMO-DIG-ACCESORIU", price: 9_900, ean: "5901234123464" }],
    });
    physical = await find(`${SLUG_PREFIX}accesoriu`);
  }
  if (!digital || !physical) throw new Error("Produsele DEMO nu s-au putut crea");
  return {
    digital: {
      productId: digital.productId,
      variantId: digital.id,
      sku: digital.sku,
      title: digital.product.title,
    },
    physical: { variantId: physical.id, sku: physical.sku, title: physical.product.title },
  };
}

interface DemoLine {
  variantId: string;
  productId: string | null;
  sku: string;
  title: string;
  priceMinor: number;
  isDigital: boolean;
}

async function createOrder(input: {
  number: string;
  userId: string;
  email: string;
  method: "card" | "cod";
  lines: DemoLine[];
}): Promise<string> {
  const channel = await db.salesChannel.findFirst({ orderBy: { createdAt: "asc" } });
  if (!channel) throw new Error("Nu există niciun canal de vânzare: rulează `npm run db:seed`.");
  const county = await db.sirutaUnit.findFirst({ where: { level: 1 }, orderBy: { code: "asc" } });
  const locality = await db.sirutaUnit.findFirst({
    where: { level: 3, countyCode: county?.countyCode ?? 0 },
    orderBy: { code: "asc" },
  });
  if (!county || !locality) throw new Error("Lipsește nomenclatorul SIRUTA din baza de date.");
  const lineData = input.lines.map((line) => {
    const tax = vatFromGross(line.priceMinor, 2100);
    return {
      variantId: line.variantId,
      sku: line.sku,
      title: line.title,
      quantity: 10_000n,
      unitSymbol: "buc",
      unitDecimals: 0,
      unitPriceMinor: line.priceMinor,
      lineTotalMinor: line.priceMinor,
      netMinor: line.priceMinor - tax,
      taxMinor: tax,
      taxRateBps: 2100,
      stockState: "in_stock",
      shippingClass: "standard",
      isDigital: line.isDigital,
      productSnapshot: line.productId ? { productId: line.productId, demo: true } : { demo: true },
    };
  });
  const total = lineData.reduce((sum, l) => sum + l.lineTotalMinor, 0);
  const tax = lineData.reduce((sum, l) => sum + l.taxMinor, 0);
  const mixed = input.lines.some((l) => !l.isDigital);
  const soon = new Date(Date.now() + 86_400_000);
  const now = new Date();
  const order = await db.order.create({
    select: { id: true },
    data: {
      number: input.number,
      channelId: channel.id,
      customerId: input.userId,
      email: input.email,
      phone: "0722000000",
      subtotalMinor: total,
      shippingMinor: 0,
      taxMinor: tax,
      totalMinor: total,
      taxRateBps: 2100,
      shippingMethodCode: mixed ? "courier" : "digital",
      shippingSnapshot: mixed
        ? { kind: "courier", carrier: "DEMO", service: "DEMO", code: "demo:courier", demo: true }
        : { kind: "digital", demo: true },
      paymentMethod: input.method,
      customerNote: "DEMO: comandă fictivă pentru verificarea produselor digitale",
      termsAcceptedAt: now,
      termsConsentText: "DEMO",
      termsConsentVersion: "demo",
      digitalConsentAt: now,
      digitalConsentText: "Solicit livrarea imediată a conținutului digital (DEMO).",
      digitalConsentVersion: "demo",
      ...(input.method === "card"
        ? { reservationExpiresAt: soon, paymentRetryDeadlineAt: soon }
        : {}),
      idempotencyKey: crypto.randomUUID(),
      lines: { create: lineData },
      addresses: {
        create: [
          ...(mixed ? (["shipping", "billing"] as const) : (["billing"] as const)).map((kind) => ({
            kind,
            fullName: "Client DEMO",
            phone: "0722000000",
            countySirutaCode: county.code,
            countyName: county.name,
            localitySirutaCode: locality.code,
            localityName: locality.name,
            street: "Strada Demo 1",
            postalCode: "100000",
            country: "RO",
          })),
        ],
      },
    },
  });
  if (input.method === "card") {
    await db.payment.create({
      data: {
        orderId: order.id,
        provider: "demo",
        method: "card",
        amountMinor: total,
        status: "pending",
        attemptNo: 1,
        mode: "demo",
        providerRef: `demo-${input.number.toLowerCase()}`,
        idempotencyKey: `card:${order.id}:1`,
      },
    });
  } else {
    await db.payment.create({
      data: { orderId: order.id, provider: "cod", method: "cod", amountMinor: total },
    });
  }
  return order.id;
}

async function create(email: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true, email: true, emailVerified: true, anonymizedAt: true },
  });
  if (!user || user.anonymizedAt) {
    console.error(
      `Nu există un cont de client cu emailul ${email}. Înregistrează-l întâi în vitrină.`,
    );
    process.exit(1);
  }
  if (!user.emailVerified) {
    console.error(
      "Contul trebuie să aibă emailul verificat (verifică-l din linkul primit în Mailpit).",
    );
    process.exit(1);
  }
  const { digital, physical } = await ensureProducts();
  const stamp = Date.now().toString(36).toUpperCase();
  const digitalLine: DemoLine = {
    variantId: digital.variantId,
    productId: digital.productId,
    sku: digital.sku,
    title: digital.title,
    priceMinor: 19_900,
    isDigital: true,
  };

  // A: 100% digitală, card DEMO, plătită prin evenimentul real de plată (cârligul acordă accesul)
  const a = `${NUMBER_PREFIX}${stamp}-A`;
  const orderA = await createOrder({
    number: a,
    userId: user.id,
    email: user.email,
    method: "card",
    lines: [digitalLine],
  });
  await addOrderEvent(db, orderA, {
    type: "order.placed",
    message: "Comanda a fost plasată (DEMO)",
  });
  await db.payment.updateMany({
    where: { orderId: orderA },
    data: {
      status: "paid",
      capturedAt: new Date(),
      capturedAmountMinor: 19_900,
      capturedCurrency: "RON",
    },
  });
  await transitionOrder(
    db,
    orderA,
    { status: "confirmed", paymentStatus: "paid" },
    { type: "payment.confirmed", message: "Plata a fost confirmată (DEMO)" },
    new Date(),
  );

  // B: mixtă, ramburs, confirmată și NELIVRATĂ: accesul vine abia la livrarea confirmată
  const b = `${NUMBER_PREFIX}${stamp}-B`;
  const orderB = await createOrder({
    number: b,
    userId: user.id,
    email: user.email,
    method: "cod",
    lines: [
      digitalLine,
      {
        variantId: physical.variantId,
        productId: null,
        sku: physical.sku,
        title: physical.title,
        priceMinor: 9_900,
        isDigital: false,
      },
    ],
  });
  await addOrderEvent(db, orderB, {
    type: "order.placed",
    message: "Comanda a fost plasată (DEMO)",
  });
  await transitionOrder(
    db,
    orderB,
    { status: "confirmed" },
    { type: "order.confirmed", message: "Comandă confirmată (DEMO, ramburs)" },
    new Date(),
  );

  const base = loadEnv().APP_URL.replace(/\/+$/, "");
  console.log(`Gata (DEMO). Cont: ${user.email}`);
  console.log(`  Comanda A (digital, card DEMO, plătită): ${a}`);
  console.log(`  Comanda B (mixtă, ramburs, nelivrată):   ${b}`);
  console.log(`  Biblioteca clientului: ${base}/cont/produsele-mele`);
  console.log(`  Pagina produsului:     ${base}/produs/${SLUG_PREFIX}curs`);
  console.log(`  Admin, acces digital:  ${base}/admin/comenzi/digital`);
  console.log("  Curățare: npm run dev:digital-demo -- --remove");
}

async function main(): Promise<void> {
  if (process.argv.includes("--remove")) {
    await remove();
    return;
  }
  const arg = process.argv.find((a) => a.startsWith("--email="));
  const email = arg?.slice("--email=".length).trim();
  if (!email) {
    console.error(
      "Folosire: npm run dev:digital-demo -- --email=client@exemplu.ro   (sau -- --remove)",
    );
    process.exit(1);
  }
  await create(email);
}

await main().finally(() => db.$disconnect());
