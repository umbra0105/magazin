import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { Container, SectionHeading } from "@ecom/ui";
import { RichTextView } from "@/components/rich-text/rich-text";
import { Breadcrumbs } from "@/components/storefront/catalog/breadcrumbs";
import {
  availabilityDetail,
  availabilityLabel,
  availabilityTone,
} from "@/components/storefront/catalog/availability";
import { ProductGallery } from "@/components/storefront/catalog/product-gallery";
import { ProductGrid } from "@/components/storefront/catalog/product-grid";
import { ProductTabs, type ProductTab } from "@/components/storefront/catalog/product-tabs";
import { PurchasePanel } from "@/components/storefront/catalog/purchase-panel";
import { SpecsTable } from "@/components/storefront/catalog/specs-table";
import { renderDescriptionHtml } from "@/lib/rich-text";
import {
  formatPrice,
  getCatalogReader,
  getProductCached,
  getStorefrontFormat,
} from "@/lib/storefront-catalog";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { telHref } from "@/lib/storefront-chrome-rules";
import { SHOP_PATH, categoryHref, productHref } from "@/lib/storefront-urls";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog;

// Pagina de produs e statică și regenerată (ISR): invalidată pe etichete la orice schimbare de catalog și, ca plasă de siguranță
// (stocul se schimbă și din joburi), regenerată cel mult la un minut.
// valoare literală (Next o citește static); aceeași cu CATALOG_REVALIDATE_SECONDS din lib/storefront-catalog
export const revalidate = 60;

type Params = { slug: string };

// Fără pagini generate la build (catalogul se schimbă și baza de date nu e mereu disponibilă la build): lista goală cere totuși
// randarea statică la prima vizită și păstrarea ei în cache (ISR), cu regenerare la expirare sau la invalidarea etichetelor.
export function generateStaticParams(): Params[] {
  return [];
}

function excerpt(text: string | null, max = 160): string | undefined {
  if (!text) return undefined;
  const plain = text
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain ? plain.slice(0, max) : undefined;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await getCatalogReader().resolveProduct(slug);
  if (resolved.kind !== "ok" || !resolved.canonical) return {};
  const [format, chrome] = await Promise.all([getStorefrontFormat(), getStorefrontChrome()]);
  const product = await getProductCached(resolved.canonical, format);
  if (!product) return {};
  const image = product.gallery[0]?.large;
  return {
    title: product.seoTitle || product.title,
    description:
      product.seoDescription || product.subtitle || excerpt(product.descriptionHtml) || undefined,
    alternates: { canonical: productHref(product.slug) },
    openGraph: {
      siteName: chrome.storeName,
      title: product.seoTitle || product.title,
      type: "website",
      ...(image && {
        images: [{ url: image.src, width: image.width, height: image.height, alt: image.alt }],
      }),
    },
  };
}

export default async function ProductPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const resolved = await getCatalogReader().resolveProduct(slug);
  if (resolved.kind === "missing" || !resolved.canonical) notFound();
  // O singură adresă canonică per produs: altă scriere sau un slug vechi duc (301) la cea curentă.
  if (resolved.kind === "redirect") permanentRedirect(productHref(resolved.canonical));

  const [format, chrome] = await Promise.all([getStorefrontFormat(), getStorefrontChrome()]);
  const product = await getProductCached(resolved.canonical, format);
  if (!product) notFound();

  const descriptionHtml = product.descriptionHtml
    ? await renderDescriptionHtml(product.descriptionHtml)
    : "";
  const defaultVariant = product.variants.find((v) => v.isDefault) ?? product.variants[0];

  const tabs: ProductTab[] = [
    ...(descriptionHtml
      ? [
          {
            id: "descriere",
            label: m.product.tabs.description,
            content: <RichTextView html={descriptionHtml} />,
          },
        ]
      : []),
    {
      id: "specificatii",
      label: m.product.tabs.specs,
      content: <SpecsTable rows={product.specs} locale={format.locale} />,
    },
    ...(hasGpsr(product.gpsr)
      ? [{ id: "siguranta", label: m.product.tabs.safety, content: <Gpsr gpsr={product.gpsr} /> }]
      : []),
  ];

  return (
    <Container className="flex flex-col gap-10 py-8 sm:py-12">
      <Breadcrumbs
        items={[
          { name: m.breadcrumbs.home, href: "/" },
          { name: m.breadcrumbs.shop, href: SHOP_PATH },
          ...product.trail.map((c) => ({ name: c.name, href: categoryHref(c.path) })),
        ]}
        current={product.title}
      />

      <div className="grid gap-8 lg:grid-cols-2 lg:gap-14">
        <ProductGallery items={product.gallery.map((g) => ({ thumb: g.thumb, large: g.large }))} />
        <div className="flex flex-col gap-6">
          <header className="flex flex-col gap-2">
            {product.brand ? (
              <p className="text-sm font-medium text-ink-secondary">{product.brand.name}</p>
            ) : null}
            <h1 className="heading-display text-headline text-balance">{product.title}</h1>
            {product.subtitle ? (
              <p className="text-lede text-ink-secondary">{product.subtitle}</p>
            ) : null}
          </header>
          {defaultVariant ? (
            <PurchasePanel
              options={product.options}
              defaultVariantId={defaultVariant.id}
              contact={{
                phone: chrome.company.phone,
                telHref: telHref(chrome.company.phone),
                email: chrome.company.email,
              }}
              variants={product.variants.map((v) => ({
                id: v.id,
                sku: v.sku,
                label: v.label,
                optionValues: v.optionValues,
                priceText: formatPrice(v.price.amount, format),
                compareAtText: v.price.compareAt ? formatPrice(v.price.compareAt, format) : null,
                availabilityLabel: availabilityLabel(v.availability.state),
                availabilityDetail: availabilityDetail(v.availability),
                tone: availabilityTone(v.availability.state),
                purchasable: v.availability.purchasable,
                warrantyText:
                  v.warrantyMonths !== null ? m.product.warranty(v.warrantyMonths) : null,
                partNumber: v.manufacturerPartNumber,
              }))}
            />
          ) : null}
        </div>
      </div>

      <ProductTabs tabs={tabs} />

      {product.related.length > 0 ? (
        <section className="flex flex-col gap-6">
          <SectionHeading title={m.product.related.title} lede={m.product.related.lede} />
          <ProductGrid
            products={product.related}
            format={format}
            layout={chrome.cardLayout}
            label={m.product.related.title}
          />
        </section>
      ) : null}
    </Container>
  );
}

type Gpsr = {
  manufacturerName: string | null;
  manufacturerContact: string | null;
  responsibleName: string | null;
  responsibleContact: string | null;
  safetyWarnings: string | null;
};

function hasGpsr(g: Gpsr): boolean {
  return Boolean(
    g.manufacturerName ||
    g.manufacturerContact ||
    g.responsibleName ||
    g.responsibleContact ||
    g.safetyWarnings,
  );
}

function Gpsr({ gpsr }: { gpsr: Gpsr }) {
  const g = m.product.gpsr;
  const party = (title: string, name: string | null, contact: string | null) =>
    name || contact ? (
      <div>
        <h3 className="font-semibold">{title}</h3>
        {name ? <p>{name}</p> : null}
        {contact ? <p className="whitespace-pre-line text-ink-secondary">{contact}</p> : null}
      </div>
    ) : null;
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {party(g.manufacturer, gpsr.manufacturerName, gpsr.manufacturerContact)}
      {party(g.responsible, gpsr.responsibleName, gpsr.responsibleContact)}
      {gpsr.safetyWarnings ? (
        <div>
          <h3 className="font-semibold">{g.warnings}</h3>
          <p className="whitespace-pre-line">{gpsr.safetyWarnings}</p>
        </div>
      ) : null}
    </div>
  );
}
