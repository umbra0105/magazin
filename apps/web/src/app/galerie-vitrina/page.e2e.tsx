import { CheckCircle2, Headset, ShieldCheck, Truck } from "lucide-react";
import { notFound } from "next/navigation";
import {
  AnnouncementBar,
  HeroBanner,
  ProductCard,
  SectionHeading,
  StoreButton,
  StoreImage,
  StoreSearch,
  StorePill,
  TrustBar,
  Container,
  cn,
  storeButtonVariants,
  type StorePillTone,
} from "@ecom/ui";
import {
  PRESET_KEYS,
  PRESETS,
  buildMenuTree,
  configFromPreset,
  renderScopedThemeCss,
  type MenuCategory,
  type PresetKey,
} from "@ecom/core";
import { StoreFooter } from "@/components/storefront/store-footer";
import { StoreHeader } from "@/components/storefront/store-header";
import { getMessages } from "@/messages";
import {
  TRANSPARENT_PIXEL,
  loadDemoProductPhotos,
  loadHeroPhoto,
  type DemoPhoto,
} from "./demo-media.e2e";

/**
 * GALERIE DE DESIGN A VITRINEI (Faza 6), doar pentru dezvoltare și teste. Nu e o pagină livrată: extensia `.e2e.tsx` e inclusă în
 * `pageExtensions` doar în dezvoltare sau cu `E2E_HARNESS=1`; a doua barieră: în producție fără variabilă, 404. Nu citește
 * setări și nu scrie nimic: textele sunt de demonstrație din mesaje. Imaginile: fotografiile produselor demo din baza de
 * dezvoltare (carduri și plăci de meniu) și prima fotografie din `local-data/foto-hero/` (hero), ambele necomise; când lipsesc
 * (de exemplu pe baza goală din CI), substituenți plați, fără degrade. Arată componentele în cele 3 presets, în
 * tema deschisă și închisă: `?preset=minimal|bold|editorial&tema=deschisa|inchisa`, plus `&meniu=deschis` (mega menu deschis)
 * și `&panou=deschis` (panoul de pe telefon deschis), `&header=glass` (header translucid peste hero), `&footer=compact` și
 * `&anunt=brand|neutral` (bara de anunț). Capturile pentru punctul de control se fac de aici.
 */
const m = getMessages().storefront.gallery;

type Params = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const TRUST_ICONS = [Truck, ShieldCheck, CheckCircle2, Headset];
const PILL_TONES: StorePillTone[] = ["neutral", "success", "warning", "problem", "info"];
const STATUS_TONES: Record<string, StorePillTone> = {
  "În stoc": "success",
  "Stoc limitat": "warning",
  "La comandă": "info",
  Indisponibil: "problem",
};

function demoMenu(photos: DemoPhoto[]) {
  const rows: MenuCategory[] = [];
  m.menu.forEach((top, index) => {
    const slug = `demo-${index}`;
    rows.push({
      id: slug,
      parentId: null,
      slug,
      name: top.name,
      path: slug,
      depth: 0,
      sortOrder: index,
      productCount: 1,
    });
    top.children.forEach((child, childIndex) => {
      // categoriile cu indice par au imagine (placă), cele cu indice impar rămân text: ambele variante se văd în galerie
      const photo = photos[(index + childIndex) % Math.max(photos.length, 1)];
      const image =
        childIndex % 2 === 0
          ? {
              src: photo?.src ?? TRANSPARENT_PIXEL,
              width: photo?.width ?? 800,
              height: photo?.height ?? 600,
              alt: "",
            }
          : null;
      rows.push({
        image,
        id: `${slug}-${childIndex}`,
        parentId: slug,
        slug: `${slug}-${childIndex}`,
        name: child,
        path: `${slug}/${slug}-${childIndex}`,
        depth: 1,
        sortOrder: childIndex,
        productCount: 1,
      });
    });
  });
  return buildMenuTree(rows, { maxLevels: 3 });
}

/** Substituent plat (fără degrade) cât timp nu există o fotografie: culoarea cardului, textul din pagină. */
function Placeholder({ caption, className }: { caption: string; className?: string }) {
  return (
    <div
      role="img"
      aria-label={caption}
      className={cn("flex size-full items-end p-4 text-sm text-ink-secondary", className)}
    >
      {caption}
    </div>
  );
}

function Block({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="py-10">
      <Container>
        <h2 id={id} className="mb-6 text-subhead font-semibold text-ink-secondary">
          {title}
        </h2>
      </Container>
      {children}
    </section>
  );
}

export default async function StorefrontGalleryPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound();
  const params = await searchParams;
  const requested = first(params["preset"]);
  const preset: PresetKey = PRESET_KEYS.find((key) => key === requested) ?? "minimal";
  const mode = first(params["tema"]) === "inchisa" ? "dark" : "light";
  const menuOpen = first(params["meniu"]) === "deschis";
  const navOpen = first(params["panou"]) === "deschis";
  const headerVariant = first(params["header"]) === "glass" ? "glass" : "default";
  const footerVariant = first(params["footer"]) === "compact" ? "compact" : "default";
  const announcement = ["brand", "neutral"].find((tone) => tone === first(params["anunt"])) as
    "brand" | "neutral" | undefined;
  const config = configFromPreset(preset);
  const [photos, heroPhoto] = await Promise.all([loadDemoProductPhotos(8), loadHeroPhoto()]);
  const menu = demoMenu(photos);
  const company = m.footerCompany;
  const query = (patch: Record<string, string>) =>
    `?${new URLSearchParams({ preset, tema: mode === "dark" ? "inchisa" : "deschisa", ...patch }).toString()}`;

  const hero = (
    <HeroBanner
      titleAs="h2"
      {...(heroPhoto
        ? { image: heroPhoto }
        : {
            media: (
              <div
                role="img"
                aria-label={m.hero.mediaCaption}
                className="flex size-full items-end p-6 text-sm text-on-image"
              >
                {m.hero.mediaCaption}
              </div>
            ),
          })}
      title={m.hero.title}
      accent={m.hero.accent}
      lede={m.hero.lede}
      actions={
        <>
          <a href="#g-cards" className={storeButtonVariants({ variant: "onImage", size: "lg" })}>
            {m.hero.primary}
          </a>
          <a
            href="#g-trust"
            className={storeButtonVariants({ variant: "outlineOnImage", size: "lg" })}
          >
            {m.hero.secondary}
          </a>
        </>
      }
    />
  );

  return (
    <div
      data-theme-preview
      data-surface="storefront"
      data-container="xl"
      data-header={headerVariant}
      className="min-h-dvh bg-surface-page text-ink"
    >
      <style>{renderScopedThemeCss(config, mode)}</style>
      <Container className="py-8">
        <h1 className="heading-display text-headline">{m.title}</h1>
        <p className="mt-3 max-w-2xl text-lede text-ink-secondary">{m.note}</p>
        <nav aria-label={m.presetLabel} className="mt-6 flex flex-wrap gap-2">
          {PRESET_KEYS.map((key) => (
            <a
              key={key}
              href={query({ preset: key })}
              aria-current={key === preset ? "page" : undefined}
              className={storeButtonVariants({
                variant: key === preset ? "primary" : "secondary",
              })}
            >
              {PRESETS[key].label}
            </a>
          ))}
          {(["deschisa", "inchisa"] as const).map((value) => (
            <a
              key={value}
              href={query({ tema: value })}
              aria-current={(value === "inchisa") === (mode === "dark") ? "page" : undefined}
              className={storeButtonVariants({
                variant: (value === "inchisa") === (mode === "dark") ? "primary" : "secondary",
              })}
            >
              {value === "deschisa" ? m.light : m.dark}
            </a>
          ))}
        </nav>
      </Container>

      <Block id="g-header" title={m.sections.header}>
        {announcement ? (
          <AnnouncementBar
            label={getMessages().storefront.announcementLabel}
            text={m.announcementDemo}
            href={m.announcementLinkDemo}
            tone={announcement}
          />
        ) : null}
        <StoreHeader
          variant={headerVariant}
          storeName={company.name}
          logoUrl={null}
          menu={menu}
          phone={company.phone}
          slots={{ search: "disabled", cart: "disabled", wishlist: "disabled" }}
          menuInitiallyOpen={menuOpen}
          navInitiallyOpen={navOpen}
          className="relative"
        />
        {headerVariant === "glass" ? <main>{hero}</main> : null}
        {menuOpen ? <div className="h-96" aria-hidden="true" /> : null}
      </Block>

      <Block id="g-hero" title={m.sections.hero}>
        {hero}
      </Block>

      <Block id="g-trust" title={m.sections.trust}>
        <Container>
          <TrustBar
            label={m.trust.label}
            items={m.trust.items.map((item, index) => {
              const Icon = TRUST_ICONS[index] ?? CheckCircle2;
              return { ...item, icon: <Icon aria-hidden="true" className="size-7" /> };
            })}
          />
        </Container>
      </Block>

      <Block id="g-cards" title={m.sections.cards}>
        <Container>
          <SectionHeading title={m.cards.heading} lede={m.cards.lede} className="mb-8" />
          <ul className="grid grid-cols-2 gap-3 sm:gap-6 lg:grid-cols-4">
            {m.cards.items.map((item, index) => {
              const photo = photos[index % Math.max(photos.length, 1)];
              return (
                <li key={item.name}>
                  <ProductCard
                    href="#g-cards"
                    name={item.name}
                    brand={item.brand}
                    price={item.price}
                    oldPrice={"oldPrice" in item ? item.oldPrice : undefined}
                    status={{ label: item.status, tone: STATUS_TONES[item.status] ?? "neutral" }}
                    media={
                      photo ? (
                        <StoreImage
                          src={photo.src}
                          alt={photo.alt}
                          width={photo.width}
                          height={photo.height}
                        />
                      ) : (
                        <Placeholder caption={item.name} />
                      )
                    }
                    className="h-full"
                  />
                </li>
              );
            })}
          </ul>
        </Container>
      </Block>

      <Block id="g-buttons" title={m.sections.buttons}>
        <Container className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <StoreButton>{m.buttons.primary}</StoreButton>
            <StoreButton variant="secondary">{m.buttons.secondary}</StoreButton>
            <StoreButton variant="ghost">{m.buttons.ghost}</StoreButton>
            <StoreButton aria-disabled="true">{m.buttons.disabled}</StoreButton>
            <StoreButton size="lg">{m.buttons.primary}</StoreButton>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {PILL_TONES.map((tone) => (
              <StorePill key={tone} tone={tone}>
                {m.buttons.pills[tone]}
              </StorePill>
            ))}
          </div>
        </Container>
      </Block>

      <Block id="g-search" title={m.sections.search}>
        <Container className="flex flex-col gap-4">
          <StoreSearch
            label={getMessages().storefront.header.searchLabel}
            placeholder={getMessages().storefront.header.searchPlaceholder}
            className="max-w-xl"
          />
          <StoreSearch
            label={getMessages().storefront.header.searchLabel}
            placeholder={getMessages().storefront.header.searchPlaceholder}
            disabled
            disabledHint={getMessages().storefront.header.searchSoon}
            className="max-w-xl"
          />
        </Container>
      </Block>

      <Block id="g-footer" title={m.sections.footer}>
        <StoreFooter
          storeName={company.name}
          tagline={company.tagline}
          menu={menu}
          company={{
            legalName: company.legalName,
            vatId: company.vatId,
            tradeRegisterNo: company.tradeRegister,
            address: company.address,
            phone: company.phone,
            email: company.email,
          }}
          legal={{
            anpcUrl: "https://exemplu.test/anpc",
            salUrl: "https://exemplu.test/sal",
            odrUrl: "https://exemplu.test/sol",
          }}
          year={2026}
          variant={footerVariant}
        />
      </Block>
    </div>
  );
}
