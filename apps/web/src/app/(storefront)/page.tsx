import type { Metadata } from "next";
import Link from "next/link";
import { Headset, ShieldCheck, Truck, Wallet } from "lucide-react";
import {
  Container,
  HeroBanner,
  SectionHeading,
  StoreImage,
  TrustBar,
  storeButtonVariants,
} from "@ecom/ui";
import { ProductGrid } from "@/components/storefront/catalog/product-grid";
import { getStorefrontFormat, listProductsCached } from "@/lib/storefront-catalog";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { SHOP_PATH } from "@/lib/storefront-urls";
import { getMessages } from "@/messages";

const m = getMessages().storefront.home;

const TRUST_ICONS = [Truck, ShieldCheck, Wallet, Headset];

/** Câte produse noi arată pagina de start (două rânduri pe un ecran lat). */
const NEWEST_COUNT = 8;

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
  const newest = await listProductsCached({}, "new", 0, NEWEST_COUNT, format);
  const categories = chrome.menu.slice(0, 6);

  return (
    <>
      <HeroBanner
        title={m.heading(chrome.storeName)}
        lede={chrome.tagline || undefined}
        actions={
          <Link
            href={SHOP_PATH}
            className={storeButtonVariants({ variant: "onImage", size: "lg" })}
          >
            {m.allProducts}
          </Link>
        }
      />

      <Container className="flex flex-col gap-section py-section">
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
            <ul className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3">
              {categories.map((category) => (
                <li key={category.id} className="contents">
                  <Link
                    href={category.href}
                    className="group flex flex-col overflow-hidden rounded-card bg-card transition-colors duration-(--motion) hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    {category.image ? (
                      <span className="relative isolate block aspect-4/3 overflow-hidden bg-media p-4 [&_img]:size-full [&_img]:object-contain [&_img]:mix-blend-multiply">
                        <StoreImage
                          src={category.image.src}
                          alt=""
                          width={category.image.width}
                          height={category.image.height}
                          sizes="(min-width: 48rem) 33vw, 50vw"
                        />
                      </span>
                    ) : null}
                    <span className="p-5 text-lg font-semibold">{category.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {newest.items.length > 0 ? (
          <section className="flex flex-col gap-8">
            <SectionHeading
              title={m.newest.title}
              lede={m.newest.lede}
              action={
                <Link href={SHOP_PATH} className={storeButtonVariants({ variant: "secondary" })}>
                  {m.newest.all}
                </Link>
              }
            />
            <ProductGrid
              products={newest.items}
              format={format}
              layout={chrome.cardLayout}
              label={m.newest.title}
            />
          </section>
        ) : null}
      </Container>
    </>
  );
}
