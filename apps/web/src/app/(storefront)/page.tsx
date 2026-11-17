import type { Metadata } from "next";
import Link from "next/link";
import { Headset, ShieldCheck, Truck, Wallet } from "lucide-react";
import { loadEnv } from "@ecom/config";
import {
  Container,
  HeroSplit,
  SectionHeading,
  StoreImage,
  TrustBar,
  storeButtonVariants,
} from "@ecom/ui";
import { JsonLdScript } from "@/components/storefront/json-ld";
import { getSettings } from "@/lib/services";
import { organizationLd, websiteLd } from "@/lib/structured-data";
import { ProductGrid } from "@/components/storefront/catalog/product-grid";
import { tileSpan } from "@/lib/storefront-layout";
import {
  formatPrice,
  getStorefrontFormat,
  listBrandsCached,
  listProductsCached,
} from "@/lib/storefront-catalog";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { SHOP_PATH, brandHref, productHref } from "@/lib/storefront-urls";
import { getMessages } from "@/messages";

const m = getMessages().storefront.home;

const TRUST_ICONS = [Truck, ShieldCheck, Wallet, Headset];

/** Câte produse recomandate arată pagina de start (două rânduri pe un ecran lat). */
const FEATURED_COUNT = 8;
/** Câte mărci arată banda de mărci. */
const BRANDS_COUNT = 12;

// Pagina de start e statică și regenerată (ISR): cadrul și catalogul vin din cache cu etichete, invalidate la schimbări.
// valoare literală (Next o citește static); aceeași cu CATALOG_REVALIDATE_SECONDS din lib/storefront-catalog
export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  const { storeName, tagline } = await getStorefrontChrome();
  return {
    title: { absolute: tagline ? `${storeName} - ${tagline}` : storeName },
    description: tagline || undefined,
    alternates: { canonical: "/" },
  };
}

export default async function HomePage() {
  const [chrome, format] = await Promise.all([getStorefrontChrome(), getStorefrontFormat()]);
  const [featured, brands] = await Promise.all([
    listProductsCached({}, "recommended", 0, FEATURED_COUNT, format),
    listBrandsCached(BRANDS_COUNT),
  ]);
  const categories = chrome.menu.slice(0, 6);
  const company = await getSettings().getGroup("company");
  const appUrl = loadEnv().APP_URL;
  const origin = new URL(appUrl).origin;
  const logo = chrome.logoUrl?.startsWith("/")
    ? `${origin}${chrome.logoUrl}`
    : (chrome.logoUrl ?? null);
  // produsul din hero: dintre recomandatele cu imagine, cel cu prețul cel mai mare (un echipament, nu un consumabil)
  const star = featured.items
    .filter((item) => item.image)
    .sort((a, b) => (b.price?.amount ?? 0) - (a.price?.amount ?? 0))[0];

  return (
    <>
      <JsonLdScript
        data={[
          organizationLd({
            base: appUrl,
            name: chrome.storeName,
            legalName: company.legalName,
            logo,
            address: company.address,
            phone: company.phone,
            email: company.email,
          }),
          websiteLd(appUrl, chrome.storeName),
        ]}
      />
      <HeroSplit
        title={m.heading(chrome.storeName)}
        lede={chrome.tagline || undefined}
        actions={
          <Link
            href={SHOP_PATH}
            className={storeButtonVariants({ variant: "primary", size: "lg" })}
          >
            {m.allProducts}
          </Link>
        }
        aside={
          star?.image ? (
            <Link
              href={productHref(star.slug)}
              className="group flex flex-col gap-4 rounded-card outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <span className="relative isolate block overflow-hidden rounded-card bg-media p-6 sm:p-10 [&_img]:mix-blend-multiply">
                <StoreImage
                  src={star.image.src}
                  alt={star.image.alt}
                  width={star.image.width}
                  height={star.image.height}
                  sizes="(min-width: 64rem) 40vw, 100vw"
                  priority
                  className="mx-auto aspect-square w-full max-w-lg object-contain"
                />
              </span>
              <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="max-w-md text-lg font-semibold leading-snug">{star.title}</span>
                {star.price ? (
                  <span className="text-lg text-ink-secondary">
                    {formatPrice(star.price.amount, format)}
                  </span>
                ) : null}
              </span>
            </Link>
          ) : null
        }
      />

      <Container className="flex flex-col gap-section pb-section">
        <TrustBar
          label={m.trust.label}
          items={m.trust.items.map((item, index) => {
            const Icon = TRUST_ICONS[index] ?? ShieldCheck;
            return { ...item, icon: <Icon aria-hidden="true" className="size-7" /> };
          })}
        />

        {categories.length > 0 ? (
          <section className="flex flex-col gap-8">
            <SectionHeading title={m.categories.title} lede={m.categories.lede} />
            <ul className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-6">
              {categories.map((category, index) => (
                <li key={category.id} className={tileSpan(index, categories.length)}>
                  <Link
                    href={category.href}
                    className="h-full group flex flex-col overflow-hidden rounded-card bg-card transition-colors duration-(--motion) hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    {category.image ? (
                      <span className="relative isolate block aspect-4/3 overflow-hidden bg-media p-3 [&_img]:size-full [&_img]:object-contain [&_img]:mix-blend-multiply">
                        <StoreImage
                          src={category.image.src}
                          alt=""
                          width={category.image.width}
                          height={category.image.height}
                          sizes="(min-width: 64rem) 30vw, 50vw"
                        />
                      </span>
                    ) : null}
                    <span className="p-5 text-lg font-semibold leading-snug">{category.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {featured.items.length > 0 ? (
          <section className="flex flex-col gap-8">
            <SectionHeading
              title={m.featured.title}
              lede={m.featured.lede}
              action={
                <Link href={SHOP_PATH} className={storeButtonVariants({ variant: "secondary" })}>
                  {m.featured.all}
                </Link>
              }
            />
            <ProductGrid
              products={featured.items}
              format={format}
              layout={chrome.cardLayout}
              label={m.featured.title}
            />
          </section>
        ) : null}

        {brands.length > 0 ? (
          <section aria-label={m.brands.label} className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">{m.brands.title}</h2>
            <ul className="flex flex-wrap gap-x-8 gap-y-3 text-ink-secondary">
              {brands.map((brand) => (
                <li key={brand.slug} className="text-lg font-medium">
                  <Link
                    href={brandHref(brand.slug)}
                    className="rounded-sm hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    {brand.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </Container>
    </>
  );
}
