import { notFound } from "next/navigation";
import { Container, cn, storeButtonVariants } from "@ecom/ui";
import {
  PRESET_KEYS,
  configFromPreset,
  priceLines,
  renderScopedThemeCss,
  type PresetKey,
} from "@ecom/core";
import { parseQuantity, quantityFromTicks, QUANTITY_FACTOR } from "@ecom/shared";
import { formatMoney } from "@/lib/money-input";
import { CartContent } from "@/components/storefront/cart/cart-panel";
import { PurchasePanel } from "@/components/storefront/catalog/purchase-panel";
import type { CartDto, CartLineDto } from "@/lib/cart-dto";

/**
 * Galeria coșului (Faza 8), doar pentru dezvoltare și teste (extensia `.e2e.tsx`, 404 în producție fără `E2E_HARNESS=1`). Desenează
 * `CartContent` și zona de cumpărare cu date de probă, în cele 3 presets și în ambele teme:
 * `?preset=minimal|bold|editorial&tema=deschisa|inchisa&zona=pagina|sertar|gol|produs`. Capturile de verificare se fac de aici.
 */
type Params = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const line = (over: Partial<CartLineDto>): CartLineDto => ({
  variantId: "v",
  href: "#",
  title: "Produs",
  variantLabel: null,
  sku: "SKU",
  image: null,
  energy: null,
  quantityTicks: "10000",
  stepTicks: "10000",
  steps: 1,
  minSteps: 1,
  quantityText: "1 buc",
  stepNote: null,
  minNote: null,
  unitPriceText: null,
  totalText: null,
  stateLabel: "În stoc",
  stateTone: "success",
  stateDetail: null,
  issues: [],
  included: true,
  ...over,
});

/**
 * Sumele din galerie vin din MOTOR (nu sunt scrise de mână): totalul liniilor, TVA-ul extras din fiecare linie și suma lor, ca în
 * coșul real. Liniile de probă: 6,09 mp la 123,45 lei/mp, 2 saci de 25 kg la 120,00 lei/sac și o pompă de 9.490,00 lei.
 */
const ONE = quantityFromTicks(QUANTITY_FACTOR);
const ENGINE = priceLines(
  [
    {
      key: "1",
      productId: "p1",
      categoryIds: [],
      basis: "unit",
      priceMinor: 12345,
      salePriceMinor: null,
      quantity: parseQuantity("6,09", { maxDecimals: 4 }),
      step: parseQuantity("2,03", { maxDecimals: 4 }),
      taxRateBps: 2100,
      excludeFromGroupDiscount: false,
    },
    {
      key: "2",
      productId: "p2",
      categoryIds: [],
      basis: "step",
      priceMinor: 12000,
      salePriceMinor: null,
      quantity: parseQuantity("50", { maxDecimals: 4 }),
      step: parseQuantity("25", { maxDecimals: 4 }),
      taxRateBps: 2100,
      excludeFromGroupDiscount: false,
    },
    {
      key: "3",
      productId: "p3",
      categoryIds: [],
      basis: "unit",
      priceMinor: 949000,
      salePriceMinor: null,
      quantity: ONE,
      step: ONE,
      taxRateBps: 2100,
      excludeFromGroupDiscount: false,
    },
  ],
  {
    applySale: false,
    group: { pricingType: "none" },
    now: new Date(0),
    maxLineMinor: 1_000_000_000,
  },
);
const money = (minor: number) => formatMoney(minor, "RON", "ro-RO");
const lineTotal = (key: string) => money(ENGINE.lines.find((l) => l.key === key)?.totalMinor ?? 0);

const SAMPLE: CartDto = {
  count: 5,
  groupLineText: null,
  lines: [
    line({
      variantId: "1",
      title: "Mozaic de placare, albastru, cutie",
      sku: "MZ-ALB-203",
      quantityTicks: "60900",
      stepTicks: "20300",
      steps: 3,
      quantityText: "6,09 mp",
      stepNote: "Se vinde în multipli de 2,03 mp (cutie)",
      unitPriceText: "123,45 RON / mp",
      totalText: lineTotal("1"),
    }),
    line({
      variantId: "2",
      title: "Bisulfat de sodiu pentru reducerea pH-ului",
      sku: "BIS-25",
      quantityTicks: "500000",
      stepTicks: "250000",
      steps: 2,
      quantityText: "50 kg",
      stepNote: "Se vinde în multipli de 25 kg (sac)",
      unitPriceText: "120,00 RON / sac de 25 kg",
      totalText: lineTotal("2"),
      stateLabel: "Stoc limitat",
      stateTone: "warning",
      stateDetail: "Mai sunt 3",
    }),
    line({
      variantId: "3",
      title: "Pompă de căldură pentru piscină, 12 kW, monofazată, cu invertor",
      sku: "PC-12",
      energy: { value: "A+++", label: "Clasa energetică A+++" },
      quantityText: "1 buc",
      unitPriceText: "9.490,00 RON",
      totalText: lineTotal("3"),
      stateLabel: "La comandă",
      stateTone: "info",
      stateDetail: "în 21 de zile",
      issues: [
        {
          type: "price_changed",
          message: "Prețul s-a schimbat: de la 9.290,00 RON la 9.490,00 RON.",
          action: { kind: "acknowledge", label: "Am înțeles" },
        },
      ],
    }),
    line({
      variantId: "4",
      title: "Cartuș de filtrare, model vechi",
      sku: "CF-OLD",
      stateLabel: "Indisponibil",
      stateTone: "problem",
      included: false,
      totalText: null,
      issues: [
        {
          type: "unavailable",
          message: "Produsul nu mai este disponibil și nu intră în total. Scoate-l din coș.",
          action: { kind: "remove" },
        },
      ],
    }),
  ],
  totals: {
    productsText: money(ENGINE.totals.totalMinor),
    vatText: money(ENGINE.totals.vatMinor),
    totalText: money(ENGINE.totals.totalMinor),
  },
  leadTimeText: "Livrare toată odată, în aproximativ 21 de zile",
  freeShipping: { text: "Ai transport gratuit", percent: 100, reached: true },
  canCheckout: true,
  checkoutLabel: "Finalizează comanda",
  checkoutBlockedNote: "Rezolvă mai întâi problemele de mai sus ca să poți finaliza comanda",
  shippingNote: "Transportul se calculează la finalizarea comenzii",
};

const EMPTY: CartDto = {
  ...SAMPLE,
  lines: [],
  count: 0,
  totals: null,
  leadTimeText: null,
  freeShipping: null,
};

const VARIANTS = [
  {
    id: "m",
    sku: "MZ-ALB-203",
    label: "",
    optionValues: {},
    priceText: "123,45 RON",
    priceSuffix: "/ mp",
    compareAtText: null,
    stepTicks: "20300",
    minSteps: 1,
    unitSymbol: "mp",
    stepLabel: "cutie",
    availabilityLabel: "În stoc",
    availabilityDetail: null,
    tone: "success" as const,
    purchasable: true,
    warrantyText: "24 de luni",
    partNumber: null,
  },
];

export default async function CartGalleryPage({ searchParams }: { searchParams: Promise<Params> }) {
  if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound();
  const params = await searchParams;
  const requested = first(params["preset"]);
  const preset: PresetKey = PRESET_KEYS.find((key) => key === requested) ?? "minimal";
  const mode = first(params["tema"]) === "inchisa" ? "dark" : "light";
  const zone =
    ["pagina", "sertar", "gol", "produs"].find((z) => z === first(params["zona"])) ?? "pagina";
  const config = configFromPreset(preset);
  return (
    <div
      data-theme-preview
      data-surface="storefront"
      data-container="xl"
      className="min-h-dvh bg-surface-page text-ink"
    >
      <style>{renderScopedThemeCss(config, mode)}</style>
      <Container className="flex flex-col gap-8 py-8">
        <h1 className="heading-display text-4xl">
          {zone === "produs" ? "Mozaic de placare, albastru" : "Coșul tău"}
        </h1>
        {zone === "pagina" ? <CartContent cart={SAMPLE} busy={false} variant="page" /> : null}
        {zone === "gol" ? <CartContent cart={EMPTY} busy={false} variant="page" /> : null}
        {zone === "sertar" ? (
          <div className="max-w-md border border-line-subtle">
            <CartContent cart={SAMPLE} busy={false} variant="drawer" />
          </div>
        ) : null}
        {zone === "produs" ? (
          <div className="max-w-lg">
            <PurchasePanel
              productTitle="Mozaic de placare, albastru"
              options={[]}
              variants={VARIANTS}
              defaultVariantId="m"
              contact={{
                phone: "0700 000 000",
                telHref: "tel:0700000000",
                email: "contact@exemplu.ro",
              }}
            />
          </div>
        ) : null}
        <nav className="flex flex-wrap gap-2" aria-label="Zone">
          {["pagina", "sertar", "gol", "produs"].map((z) => (
            <a
              key={z}
              href={`?preset=${preset}&tema=${mode === "dark" ? "inchisa" : "deschisa"}&zona=${z}`}
              className={cn(storeButtonVariants({ variant: z === zone ? "primary" : "secondary" }))}
            >
              {z}
            </a>
          ))}
        </nav>
      </Container>
    </div>
  );
}
