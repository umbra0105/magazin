import { Prisma, type PrismaClient } from "@ecom/db";
import type { StorageDriver } from "@ecom/integrations";
import {
  DomainError,
  MoneyError,
  QuantityError,
  minimumOrderQuantity,
  percentToBasisPoints,
  quantityFromTicks,
  type Quantity,
} from "@ecom/shared";
import { MAX_MONEY } from "../catalog/product-schemas";
import { isSellable } from "../catalog/product-lifecycle-rules";
import { availabilityOfSource } from "../inventory/stock-overview";
import {
  createPrismaStockOverviewStore,
  type StockOverviewStore,
} from "../inventory/stock-overview-store";
import type { PriceBasis } from "../inventory/constants";
import type { VisibleStockState } from "../inventory/availability";
import { longestLeadTime } from "../inventory/availability";
import { pickBestVariantImage } from "../media/urls";
import { toPublicGroupView, type PublicGroupView } from "../customers/group-rules";
import {
  NO_GROUP_PRICING,
  loadCustomerPricing,
  loadPartnerInputs,
  withPartnerInput,
  type CustomerPricing,
  type PartnerInputs,
} from "../pricing/customer-pricing";
import {
  activeSalePrice,
  excludedFromGroupPricing,
  priceLines,
  resolveUnitPrice,
  type PricedLine,
  type PricingLineInput,
  type PricingOptions,
  type PricingTotals,
} from "../pricing/engine";
import {
  cartExpiry,
  checkCartQuantity,
  clampMergedQuantity,
  freeShippingProgress,
  generateCartToken,
  hashCartToken,
  isWellFormedCartToken,
  lineIssues,
  type CartIssue,
  type CartRejection,
  type FreeShippingProgress,
} from "./cart-rules";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Coșul (Faza 8): linii (varianta și cantitatea, nimic despre bani) pentru un utilizator sau un oaspete cu token. Prețul, starea
 * de stoc și totalul se RECALCULEAZĂ pe server la fiecare afișare, prin motorul de prețuri (`pricing/engine.ts`) și prin regulile
 * de disponibilitate din `inventory`; nimic nu se rezervă (D4) și nimic nu se modifică tăcut: o schimbare de preț sau de stoc
 * apare ca problemă a liniei. ⚠️ Datele de achiziție nu sunt selectate și nu sunt pomenite nicăieri aici (testul de arhitectură al costului).
 *
 * Un coș se atinge DOAR prin tokenul lui (amprenta e în bază, tokenul nu) sau de proprietarul logat; nicio operație nu primește
 * id de coș sau de linie. Prețul ține cont de grupul de clienți al proprietarului logat (Faza 15: `pricing/customer-pricing.ts`,
 * singurul loc care îl află); oaspetele și clientul fără grup primesc prețul public. Excluderea din prețul de grup se calculează
 * de pe produs și de pe categoriile lui directe (propagarea pe ascendenți nu există: o categorie exclude doar produsele ei).
 */

export type CartOwner = { kind: "user"; userId: string } | { kind: "guest"; token: string | null };

export interface CartRuntimeSettings {
  /** `catalog.showSalePricing`: cât e oprit, coșul percepe prețul întreg, ca vitrina. */
  showSalePricing: boolean;
  /** `tax.standardRate`, în procente. */
  taxStandardRate: number;
  lowStockSteps: number;
  defaultLeadTimeDays: number;
  guestCartDays: number;
  userCartDays: number;
  maxLines: number;
  maxStepsPerLine: number;
  /** `checkout.freeShippingThreshold` (bani) sau `null` = dezactivat. */
  freeShippingThreshold: number | null;
}

export interface CartServiceDeps {
  db: Db;
  storage: StorageDriver;
  readSettings: () => Promise<CartRuntimeSettings>;
  now?: () => Date;
  stockStore?: StockOverviewStore;
  generateToken?: () => string;
  /** Depozitul din care se citește stocul; implicit depozitul implicit (testele cu date proprii îl dau explicit). */
  warehouseId?: string;
}

const MESSAGES: Record<CartRejection["reason"], string> = {
  not_sellable: "Produsul nu mai poate fi comandat.",
  invalid_quantity: "Cantitatea nu este validă pentru acest produs.",
  unavailable: "Produsul este indisponibil.",
  digital_single: "Un produs digital se cumpără o singură dată: cantitatea poate fi cel mult 1.",
  exceeds_available: "Cantitatea cerută depășește stocul disponibil.",
  exceeds_limit: "Cantitatea depășește limita pe linie.",
  too_many_lines: "Coșul a atins numărul maxim de produse.",
  line_too_expensive: "Valoarea liniei depășește maximul permis.",
  not_in_cart: "Produsul nu este în coș.",
};

/** Refuzul unei operații pe coș, cu cod stabil `CART_<MOTIV>` (ex. `CART_EXCEEDS_AVAILABLE`). */
export class CartError extends DomainError {
  readonly rejection: CartRejection;

  constructor(rejection: CartRejection) {
    const details: Record<string, unknown> = { reason: rejection.reason };
    if ("maxSteps" in rejection) details["maxSteps"] = Number(rejection.maxSteps);
    if ("maxLines" in rejection) details["maxLines"] = rejection.maxLines;
    if ("detail" in rejection) details["detail"] = rejection.detail;
    super(`CART_${rejection.reason.toUpperCase()}`, MESSAGES[rejection.reason], details);
    this.rejection = rejection;
  }
}

export interface CartLineView {
  variantId: string;
  productId: string;
  productSlug: string;
  productTitle: string;
  variantLabel: string | null;
  sku: string;
  image: { src: string; width: number; height: number; alt: string } | null;
  energyClass: string | null;
  /** Produs digital (Faza 14c): fără stoc și transport, maxim o bucată, eticheta de disponibilitate «Disponibil». */
  isDigital?: boolean;
  /** Cantitatea în zecimi de miime, ca șir (bigint nu trece prin JSON). */
  quantityTicks: string;
  stepTicks: string;
  minSteps: number | null;
  unit: { symbol: string; decimals: number };
  stepLabel: string | null;
  basis: PriceBasis;
  state: VisibleStockState;
  leadTimeDays: number | null;
  /** «Mai sunt N», doar la «Stoc limitat». */
  remainingSteps: number | null;
  issues: readonly CartIssue[];
  /** Intră în total (indisponibilă, cu cantitate invalidă sau prea scumpă: nu). */
  included: boolean;
  pricing: PricedLine | null;
}

export interface CartView {
  lines: readonly CartLineView[];
  totals: PricingTotals;
  /** Termenul cel mai lung dintre liniile «La comandă» (livrare toată odată, D6) și linia care îl cauzează. */
  leadTime: { days: number; variantId: string } | null;
  freeShipping: FreeShippingProgress | null;
  /** Coșul poate trece la finalizare (Faza 9): are linii și nicio problemă care cere o decizie. */
  canCheckout: boolean;
  /**
   * Grupul cu preț special al clientului (Fidel, VIP, Partener), pentru etichete în coș; `null` la oaspete, la clientul fără grup și
   * la «Client standard». Conține doar numele, tipul și reducerea; adaosul unui partener nu se trimite niciodată.
   */
  group: PublicGroupView | null;
}

export interface CartMutation {
  view: CartView;
  /** Tokenul NOU al coșului de oaspete, doar când s-a creat un coș (se pune în cookie); altfel `null`. */
  newToken: string | null;
}

export interface MergeResult {
  merged: number;
  clamped: number;
  dropped: number;
}

const NO_MERGE: MergeResult = { merged: 0, clamped: 0, dropped: 0 };
const ZERO_TOTALS: PricingTotals = {
  subtotalMinor: 0,
  couponMinor: 0,
  groupAdvantageMinor: 0,
  totalMinor: 0,
  netMinor: 0,
  vatMinor: 0,
};

/** Coșul gol (fără linii, totaluri zero), pentru interfață când nu există încă niciun coș. */
export const EMPTY_CART_VIEW: CartView = {
  lines: [],
  totals: ZERO_TOTALS,
  leadTime: null,
  freeShipping: null,
  canCheckout: false,
  group: null,
};

const MEDIA_SELECT = {
  status: true,
  alt: true,
  storageKey: true,
  width: true,
  height: true,
  blurhash: true,
  variants: true,
} as const;

/** Câmpurile PUBLICE ale variantei; fără cost de achiziție. */
const LINE_SELECT = {
  id: true,
  price: true,
  salePrice: true,
  saleStartsAt: true,
  saleEndsAt: true,
  priceBasis: true,
  media: {
    orderBy: [{ position: "asc" }, { id: "asc" }],
    take: 1,
    select: { media: { select: MEDIA_SELECT } },
  },
  product: {
    select: {
      id: true,
      slug: true,
      title: true,
      type: true,
      status: true,
      deletedAt: true,
      priceBasis: true,
      saleStepLabel: true,
      energyClass: true,
      excludeFromGroupDiscount: true,
      categories: {
        select: { categoryId: true, category: { select: { excludeFromGroupDiscount: true } } },
      },
      media: {
        where: { variantId: null },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        take: 1,
        select: { media: { select: MEDIA_SELECT } },
      },
    },
  },
} satisfies Prisma.ProductVariantSelect;

type LineRow = Prisma.ProductVariantGetPayload<{ select: typeof LINE_SELECT }>;

/**
 * Prisma cu adaptorul `pg` execută `select`-ul imbricat ca interogări separate: un produs șters între ele ar veni `null` deși
 * tipul spune altceva. Citirea trece prin `orNull`, ca verificarea să fie reală.
 */
const orNull = <T>(value: T): T | null => value;

/** Șterge coșurile expirate (cu liniile lor); folosit de serviciu și de jobul de curățare, care nu are nevoie de restul dependențelor. */
export async function purgeExpiredCarts(db: Db, now: Date): Promise<number> {
  const result = await db.cart.deleteMany({ where: { expiresAt: { lt: now } } });
  return result.count;
}

export class CartService {
  private readonly db: Db;
  private readonly storage: StorageDriver;
  private readonly readSettings: () => Promise<CartRuntimeSettings>;
  private readonly now: () => Date;
  private readonly stock: StockOverviewStore;
  private readonly generateToken: () => string;
  private readonly warehouseId: string | null;

  constructor(deps: CartServiceDeps) {
    this.db = deps.db;
    this.storage = deps.storage;
    this.readSettings = deps.readSettings;
    this.now = deps.now ?? (() => new Date());
    this.stock = deps.stockStore ?? createPrismaStockOverviewStore(deps.db);
    this.generateToken = deps.generateToken ?? generateCartToken;
    this.warehouseId = deps.warehouseId ?? null;
  }

  // ---------------------------------------------------------------- citire

  async view(owner: CartOwner): Promise<CartView> {
    const settings = await this.readSettings();
    const cart = await this.findLiveCart(owner);
    const pricing = await this.pricingOf(owner);
    if (!cart) return this.buildView([], settings, pricing);
    const items = await this.db.cartItem.findMany({
      where: { cartId: cart.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { variantId: true, quantity: true, ackedUnitPriceMinor: true },
    });
    return this.buildView(items, settings, pricing);
  }

  /**
   * Faza 9: blochează rândul coșului (`FOR UPDATE`) pe durata tranzacției de plasare a comenzii, ca două plasări sau o modificare
   * a coșului să nu se calce. `false` dacă proprietarul nu are un coș viu.
   */
  async lockForCheckout(owner: CartOwner): Promise<boolean> {
    const cart = await this.findLiveCart(owner);
    if (!cart) return false;
    await this.lock(this.db, [cart.id]);
    return true;
  }

  /** Faza 9: golește coșul la plasarea comenzii (șterge coșul și liniile lui). Cookie-ul rămas nu mai găsește niciun coș. */
  async clearAfterOrder(owner: CartOwner): Promise<void> {
    const cart = await this.findLiveCart(owner);
    if (cart) await this.db.cart.delete({ where: { id: cart.id } });
  }

  /** Numărul de LINII din coș (insigna din header); cantitățile pot fi zecimale, deci nu se adună. */
  async lineCount(owner: CartOwner): Promise<number> {
    const cart = await this.findLiveCart(owner);
    return cart ? this.db.cartItem.count({ where: { cartId: cart.id } }) : 0;
  }

  /** Produsele sugerate lângă coș: relațiile «crosssell» ale produselor din coș, vandabile, fără cele deja în coș. */
  async crossSellProductIds(owner: CartOwner, limit: number): Promise<string[]> {
    const cart = await this.findLiveCart(owner);
    if (!cart) return [];
    const inCart = await this.db.productVariant.findMany({
      where: { cartItems: { some: { cartId: cart.id } } },
      select: { productId: true },
    });
    const productIds = [...new Set(inCart.map((row) => row.productId))];
    if (productIds.length === 0) return [];
    const relations = await this.db.productRelation.findMany({
      where: {
        productId: { in: productIds },
        type: "crosssell",
        relatedProductId: { notIn: productIds },
        relatedProduct: { status: "active", deletedAt: null },
      },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: { relatedProductId: true },
    });
    return [...new Set(relations.map((row) => row.relatedProductId))].slice(0, limit);
  }

  // ---------------------------------------------------------------- scriere

  /** Adaugă o variantă; `"minimum"` = cantitatea minimă comandabilă (minimul în pași × pasul), pentru adăugarea directă. */
  async add(
    owner: CartOwner,
    input: { variantId: string; quantity: Quantity | "minimum" },
  ): Promise<CartMutation> {
    return this.write(owner, input, "add");
  }

  async setQuantity(
    owner: CartOwner,
    input: { variantId: string; quantity: Quantity },
  ): Promise<CartMutation> {
    return this.write(owner, input, "set");
  }

  async remove(owner: CartOwner, variantId: string): Promise<CartMutation> {
    const cart = await this.findLiveCart(owner);
    if (cart) {
      await this.db.cartItem.deleteMany({ where: { cartId: cart.id, variantId } });
      await this.touch(cart.id, owner);
    }
    return { view: await this.view(owner), newToken: null };
  }

  /** Clientul a luat la cunoștință prețul curent al liniei: mesajul «prețul s-a schimbat» dispare. */
  async acknowledgePrice(owner: CartOwner, variantId: string): Promise<CartMutation> {
    const cart = await this.findLiveCart(owner);
    if (cart) {
      const settings = await this.readSettings();
      const resolved = await this.resolveVariant(variantId, settings, await this.pricingOf(owner));
      if (resolved) {
        await this.db.cartItem.updateMany({
          where: { cartId: cart.id, variantId },
          data: { ackedUnitPriceMinor: resolved.unitPriceMinor },
        });
      }
    }
    return { view: await this.view(owner), newToken: null };
  }

  /**
   * Îmbinarea coșului de oaspete în coșul utilizatorului, la autentificare: cantitățile pe aceeași variantă se adună (cu
   * plafonul pe linie), restul liniilor se mută (cu plafonul de linii), coșul de oaspete dispare. Idempotentă: tokenul unui coș
   * îmbinat nu mai găsește nimic.
   */
  async mergeGuestIntoUser(token: string, userId: string): Promise<MergeResult> {
    if (!isWellFormedCartToken(token)) return NO_MERGE;
    const settings = await this.readSettings();
    const guest = await this.findLiveCart({ kind: "guest", token });
    if (!guest) return NO_MERGE;
    const target = await this.ensureCart({ kind: "user", userId }, settings);

    const warehouse = await this.warehouse();
    const stepOf = async (variantId: string): Promise<Quantity | null> => {
      const source = warehouse ? await this.stock.getSource(variantId, warehouse.id) : null;
      return source ? quantityFromTicks(source.saleStep) : null;
    };

    return this.transact(async (tx) => {
      await this.lock(tx, [guest.id, target.id]);
      // sub blocare: o a doua îmbinare simultană găsește coșul deja dispărut și nu face nimic
      if (!(await tx.cart.findUnique({ where: { id: guest.id }, select: { id: true } }))) {
        return { ...NO_MERGE };
      }
      const guestItems = await tx.cartItem.findMany({
        where: { cartId: guest.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, variantId: true, quantity: true },
      });
      const userItems = new Map(
        (
          await tx.cartItem.findMany({
            where: { cartId: target.id },
            select: { id: true, variantId: true, quantity: true },
          })
        ).map((item) => [item.variantId, item]),
      );
      let lines = userItems.size;
      const result = { merged: 0, clamped: 0, dropped: 0 };
      for (const item of guestItems) {
        const existing = userItems.get(item.variantId);
        if (existing) {
          const step = await stepOf(item.variantId);
          if (!step) {
            result.dropped += 1;
            continue;
          }
          const sum = clampMergedQuantity(
            quantityFromTicks(existing.quantity),
            quantityFromTicks(item.quantity),
            step,
            settings.maxStepsPerLine,
          );
          await tx.cartItem.update({
            where: { id: existing.id },
            data: { quantity: sum.quantity },
          });
          result.merged += 1;
          if (sum.clamped) result.clamped += 1;
        } else if (lines >= settings.maxLines) {
          result.dropped += 1;
        } else {
          await tx.cartItem.update({ where: { id: item.id }, data: { cartId: target.id } });
          lines += 1;
          result.merged += 1;
        }
      }
      await tx.cart.delete({ where: { id: guest.id } });
      await tx.cart.update({
        where: { id: target.id },
        data: { expiresAt: cartExpiry(this.now(), settings.userCartDays) },
      });
      return result;
    });
  }

  /** Jobul de curățare: șterge coșurile expirate (cu liniile lor). Întoarce câte coșuri s-au șters. */
  async purgeExpired(): Promise<number> {
    return purgeExpiredCarts(this.db, this.now());
  }

  private warehouse() {
    return this.warehouseId === null
      ? this.stock.defaultWarehouse()
      : this.stock.warehouse(this.warehouseId);
  }

  // ---------------------------------------------------------------- interne: scriere

  private async write(
    owner: CartOwner,
    rawInput: { variantId: string; quantity: Quantity | "minimum" },
    mode: "add" | "set",
  ): Promise<CartMutation> {
    const settings = await this.readSettings();
    const variant = await this.resolveVariant(
      rawInput.variantId,
      settings,
      await this.pricingOf(owner),
    );
    if (!variant?.sellable) throw new CartError({ reason: "not_sellable" });
    const input = {
      variantId: rawInput.variantId,
      quantity:
        rawInput.quantity === "minimum"
          ? minimumOrderQuantity(variant.step, variant.minSteps)
          : rawInput.quantity,
    };
    const limits = { maxLines: settings.maxLines, maxStepsPerLine: settings.maxStepsPerLine };

    const verify = (quantity: Quantity): void => {
      const check = checkCartQuantity({
        quantity,
        step: variant.step,
        minSteps: variant.minSteps,
        availability: variant.availability,
        limits,
        digital: variant.digital,
      });
      if (!check.ok) throw new CartError(check.rejection);
      this.assertPriceable(variant.lineInput, quantity, settings);
    };

    if (mode === "set") {
      const cart = await this.findLiveCart(owner);
      const present =
        cart &&
        (await this.db.cartItem.findUnique({
          where: { cartId_variantId: { cartId: cart.id, variantId: input.variantId } },
          select: { id: true },
        }));
      if (!cart || !present) throw new CartError({ reason: "not_in_cart" });
      verify(input.quantity);
      await this.transact(async (tx) => {
        await this.lock(tx, [cart.id]);
        await tx.cartItem.update({
          where: { cartId_variantId: { cartId: cart.id, variantId: input.variantId } },
          data: { quantity: input.quantity, ackedUnitPriceMinor: variant.unitPriceMinor },
        });
        await this.touchIn(tx, cart.id, owner, settings);
      });
      return { view: await this.view(owner), newToken: null };
    }

    verify(input.quantity); // cererea singură, înainte să creeze ceva
    const cart = await this.ensureCart(owner, settings);
    await this.transact(async (tx) => {
      await this.lock(tx, [cart.id]);
      const existing = await tx.cartItem.findUnique({
        where: { cartId_variantId: { cartId: cart.id, variantId: input.variantId } },
        select: { quantity: true },
      });
      if (
        !existing &&
        (await tx.cartItem.count({ where: { cartId: cart.id } })) >= settings.maxLines
      ) {
        throw new CartError({ reason: "too_many_lines", maxLines: settings.maxLines });
      }
      let combined: Quantity = input.quantity;
      if (existing) {
        try {
          combined = quantityFromTicks(existing.quantity + BigInt(input.quantity));
        } catch (error) {
          if (!(error instanceof QuantityError)) throw error;
          throw new CartError({
            reason: "exceeds_limit",
            maxSteps: BigInt(settings.maxStepsPerLine),
          });
        }
        verify(combined);
      }
      await tx.cartItem.upsert({
        where: { cartId_variantId: { cartId: cart.id, variantId: input.variantId } },
        create: {
          cartId: cart.id,
          variantId: input.variantId,
          quantity: input.quantity,
          ackedUnitPriceMinor: variant.unitPriceMinor,
        },
        update: { quantity: combined, ackedUnitPriceMinor: variant.unitPriceMinor },
      });
      await this.touchIn(tx, cart.id, owner, settings);
    });
    const effective: CartOwner =
      cart.newToken === null ? owner : { kind: "guest", token: cart.newToken };
    return { view: await this.view(effective), newToken: cart.newToken };
  }

  /** Valoarea liniei nu depășește maximul: altfel se REFUZĂ (nu se taie). */
  private assertPriceable(
    input: PricingLineInput,
    quantity: Quantity,
    settings: CartRuntimeSettings,
  ): void {
    try {
      priceLines([{ ...input, quantity }], this.pricingOptions(settings));
    } catch (error) {
      if (error instanceof MoneyError) throw new CartError({ reason: "line_too_expensive" });
      throw error;
    }
  }

  private async touch(cartId: string, owner: CartOwner): Promise<void> {
    await this.touchIn(this.db, cartId, owner, await this.readSettings());
  }

  private async touchIn(
    db: Db,
    cartId: string,
    owner: CartOwner,
    settings: CartRuntimeSettings,
  ): Promise<void> {
    const days = owner.kind === "user" ? settings.userCartDays : settings.guestCartDays;
    await db.cart.update({
      where: { id: cartId },
      data: { expiresAt: cartExpiry(this.now(), days) },
    });
  }

  /** Rulează `fn` într-o tranzacție (sau direct, dacă `db` e deja una). */
  private async transact<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = this.db as PrismaClient;
    if (typeof client.$transaction === "function") return client.$transaction((tx) => fn(tx));
    return fn(this.db);
  }

  /** Blochează rândurile coșurilor (în ordinea id-urilor, fără blocaje încrucișate): operațiile pe același coș se serializează. */
  private async lock(tx: Db, ids: readonly string[]): Promise<void> {
    const sorted = [...new Set(ids)].sort();
    // Parametru de tip tablou, nu `Prisma.join` într-un șablon etichetat: în build-ul de producție al aplicației web un
    // fragment SQL interpolat într-un `$queryRaw` etichetat nu e recunoscut (devine parametru), iar blocarea nu lua niciun rând.
    await tx.$queryRaw`SELECT id FROM cart WHERE id = ANY(${sorted}::text[]) ORDER BY id FOR UPDATE`;
  }

  // ---------------------------------------------------------------- interne: proprietar

  private async findLiveCart(owner: CartOwner): Promise<{ id: string } | null> {
    const at = this.now();
    if (owner.kind === "user") {
      return this.db.cart.findFirst({
        where: { userId: owner.userId, expiresAt: { gt: at } },
        select: { id: true },
      });
    }
    if (!isWellFormedCartToken(owner.token)) return null;
    return this.db.cart.findFirst({
      where: { tokenHash: hashCartToken(owner.token), expiresAt: { gt: at } },
      select: { id: true },
    });
  }

  /** Coșul proprietarului; îl creează dacă lipsește. La oaspete întoarce și tokenul NOU (niciodată unul primit de la client). */
  private async ensureCart(
    owner: CartOwner,
    settings: CartRuntimeSettings,
  ): Promise<{ id: string; newToken: string | null }> {
    const live = await this.findLiveCart(owner);
    if (live) return { id: live.id, newToken: null };
    const at = this.now();
    if (owner.kind === "user") {
      // un coș expirat și încă necurățat se înlocuiește, cu liniile lui vechi
      await this.db.cart.deleteMany({ where: { userId: owner.userId, expiresAt: { lte: at } } });
      try {
        const created = await this.db.cart.create({
          data: { userId: owner.userId, expiresAt: cartExpiry(at, settings.userCartDays) },
          select: { id: true },
        });
        return { id: created.id, newToken: null };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const winner = await this.findLiveCart(owner);
          if (winner) return { id: winner.id, newToken: null };
        }
        throw error;
      }
    }
    const token = this.generateToken();
    const created = await this.db.cart.create({
      data: { tokenHash: hashCartToken(token), expiresAt: cartExpiry(at, settings.guestCartDays) },
      select: { id: true },
    });
    return { id: created.id, newToken: token };
  }

  // ---------------------------------------------------------------- interne: variante și view

  /** Grupul de clienți al proprietarului: doar un cont logat poate avea grup; oaspetele are prețul public. */
  private async pricingOf(owner: CartOwner): Promise<CustomerPricing> {
    return owner.kind === "user" ? loadCustomerPricing(this.db, owner.userId) : NO_GROUP_PRICING;
  }

  private pricingOptions(
    settings: CartRuntimeSettings,
    pricing: CustomerPricing = NO_GROUP_PRICING,
  ): PricingOptions {
    return {
      applySale: settings.showSalePricing,
      group: pricing.group,
      coupon: null,
      now: this.now(),
      maxLineMinor: MAX_MONEY,
    };
  }

  private async loadRows(variantIds: readonly string[]): Promise<Map<string, LineRow>> {
    if (variantIds.length === 0) return new Map();
    const rows = await this.db.productVariant.findMany({
      where: { id: { in: [...variantIds] } },
      select: LINE_SELECT,
    });
    return new Map(rows.map((row) => [row.id, row]));
  }

  private lineInputOf(
    row: LineRow,
    quantity: Quantity,
    step: Quantity,
    settings: CartRuntimeSettings,
    partner: PartnerInputs,
  ): PricingLineInput {
    const product = row.product;
    return withPartnerInput(
      {
        key: row.id,
        productId: product.id,
        categoryIds: product.categories.map((entry) => entry.categoryId),
        basis: (row.priceBasis ?? product.priceBasis) as PriceBasis,
        priceMinor: row.price,
        salePriceMinor: activeSalePrice(row, this.now()),
        quantity,
        step,
        taxRateBps: percentToBasisPoints(settings.taxStandardRate),
        excludeFromGroupDiscount: excludedFromGroupPricing(
          product.excludeFromGroupDiscount,
          product.categories.map((entry) => entry.category.excludeFromGroupDiscount),
        ),
      },
      partner,
    );
  }

  /** Datele de care are nevoie o operație pe o variantă: vandabilitate, disponibilitate, pas, minim și prețul unitar curent. */
  private async resolveVariant(
    variantId: string,
    settings: CartRuntimeSettings,
    pricing: CustomerPricing,
  ) {
    const rows = await this.loadRows([variantId]);
    const row = rows.get(variantId);
    const product = row ? orNull(row.product) : null;
    if (!row || !product) return null;
    const warehouse = await this.warehouse();
    const source = warehouse ? await this.stock.getSource(variantId, warehouse.id) : null;
    if (!source) return null;
    const step = quantityFromTicks(source.saleStep);
    const availability = availabilityOfSource(source, {
      defaultLowStockSteps: settings.lowStockSteps,
      defaultLeadTimeDays: settings.defaultLeadTimeDays,
    });
    const partner = await loadPartnerInputs(this.db, pricing, [variantId]);
    const lineInput = this.lineInputOf(row, step, step, settings, partner);
    const { unitPriceMinor } = resolveUnitPrice(lineInput, this.pricingOptions(settings, pricing));
    return {
      row,
      source,
      step,
      minSteps: source.minSteps,
      availability,
      sellable: isSellable(product),
      digital: product.type === "digital",
      lineInput,
      unitPriceMinor,
    };
  }

  private imageOf(row: LineRow): CartLineView["image"] {
    const media = row.media[0]?.media ?? row.product.media[0]?.media ?? null;
    if (!media || media.status !== "ready") return null;
    const picked = pickBestVariantImage(media, this.storage, "thumb");
    return picked
      ? {
          src: picked.url,
          width: picked.width,
          height: picked.height,
          alt: media.alt || row.product.title,
        }
      : null;
  }

  private async buildView(
    items: readonly { variantId: string; quantity: bigint; ackedUnitPriceMinor: number | null }[],
    settings: CartRuntimeSettings,
    pricing: CustomerPricing,
  ): Promise<CartView> {
    const rows = await this.loadRows(items.map((item) => item.variantId));
    const warehouse = await this.warehouse();
    const options = this.pricingOptions(settings, pricing);
    const partner = await loadPartnerInputs(
      this.db,
      pricing,
      items.map((item) => item.variantId),
    );

    interface Draft {
      view: Omit<CartLineView, "pricing">;
      input: PricingLineInput | null;
    }
    const drafts: Draft[] = [];

    for (const item of items) {
      const row = rows.get(item.variantId);
      const product = row ? orNull(row.product) : null;
      if (!row || !product) continue;
      const source = warehouse ? await this.stock.getSource(item.variantId, warehouse.id) : null;
      if (!source) continue;
      const step = quantityFromTicks(source.saleStep);
      const quantity = quantityFromTicks(item.quantity);
      const availability = availabilityOfSource(source, {
        defaultLowStockSteps: settings.lowStockSteps,
        defaultLeadTimeDays: settings.defaultLeadTimeDays,
      });
      const input = this.lineInputOf(row, quantity, step, settings, partner);
      const current = resolveUnitPrice(input, options);
      const issues = lineIssues({
        quantity,
        step,
        minSteps: source.minSteps,
        sellable: isSellable(product),
        availability,
        digital: product.type === "digital",
        ackedUnitPriceMinor: item.ackedUnitPriceMinor,
        currentUnitPriceMinor: current.unitPriceMinor,
      });
      const blocked = issues.some(
        (issue) => issue.type === "unavailable" || issue.type === "invalid_quantity",
      );
      drafts.push({
        input: blocked ? null : input,
        view: {
          variantId: row.id,
          productId: product.id,
          productSlug: product.slug,
          productTitle: product.title,
          variantLabel: source.variantLabel,
          sku: source.sku,
          image: this.imageOf(row),
          energyClass: product.energyClass,
          isDigital: product.type === "digital",
          quantityTicks: quantity.toString(),
          stepTicks: step.toString(),
          minSteps: source.minSteps,
          unit: { symbol: source.unit.symbol, decimals: source.unit.decimals },
          stepLabel: product.saleStepLabel,
          basis: input.basis,
          state: availability.state,
          leadTimeDays: availability.leadTimeDays,
          remainingSteps: availability.showCount === null ? null : Number(availability.showCount),
          issues,
          included: !blocked,
        },
      });
    }

    const priced = this.priceIncluded(
      drafts.flatMap((draft) => (draft.input ? [draft.input] : [])),
      options,
    );
    const lines: CartLineView[] = drafts.map((draft) => {
      const pricing = priced.lines.get(draft.view.variantId) ?? null;
      const tooExpensive = draft.input !== null && pricing === null;
      return {
        ...draft.view,
        issues: tooExpensive
          ? [...draft.view.issues, { type: "line_too_expensive" as const }]
          : draft.view.issues,
        included: draft.view.included && pricing !== null,
        pricing,
      };
    });

    const lead = longestLeadTime(
      lines.flatMap((line) =>
        line.included && line.state === "on_order" && line.leadTimeDays !== null
          ? [{ key: line.variantId, leadTimeDays: line.leadTimeDays }]
          : [],
      ),
    );
    const hasPriced = lines.some((line) => line.pricing !== null);
    return {
      lines,
      totals: priced.totals,
      leadTime: lead ? { days: lead.days, variantId: lead.key } : null,
      freeShipping: hasPriced
        ? freeShippingProgress(settings.freeShippingThreshold, priced.totals.totalMinor)
        : null,
      // orice problemă a unei linii (inclusiv un preț nou nesesizat) cere o decizie înainte de finalizare
      canCheckout:
        lines.length > 0 && lines.every((line) => line.included && line.issues.length === 0),
      group:
        pricing.record && pricing.record.pricingType !== "none"
          ? toPublicGroupView(pricing.record)
          : null,
    };
  }

  /** Prețuiește liniile incluse; o linie peste plafon iese din total (cu problemă), restul rămân. */
  private priceIncluded(
    inputs: readonly PricingLineInput[],
    options: PricingOptions,
  ): { lines: Map<string, PricedLine>; totals: PricingTotals } {
    if (inputs.length === 0) return { lines: new Map(), totals: ZERO_TOTALS };
    const attempt = (list: readonly PricingLineInput[]) => {
      const result = priceLines(list, options);
      return {
        lines: new Map(result.lines.map((line) => [line.key, line])),
        totals: result.totals,
      };
    };
    try {
      return attempt(inputs);
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
    }
    // cel puțin o linie depășește plafonul: iese din total, restul se prețuiesc
    const usable = inputs.filter((input) => {
      try {
        priceLines([input], options);
        return true;
      } catch (inner) {
        if (inner instanceof MoneyError) return false;
        throw inner;
      }
    });
    return usable.length === 0 ? { lines: new Map(), totals: ZERO_TOTALS } : attempt(usable);
  }
}
