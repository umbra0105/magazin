import { Heart, Phone, ShoppingBag, User } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Container, StoreSearch, cn, storeButtonVariants } from "@ecom/ui";
import { HeaderSearch } from "./header-search";
import type { HeaderVariant, MenuNode } from "@ecom/core";
import { getMessages } from "@/messages";
import { telHref, type SlotState } from "@/lib/storefront-chrome-rules";
import { MegaMenu, type MegaMenuItem } from "./mega-menu";
import { MobileNav } from "./mobile-nav";
import { HeaderCartButton } from "./cart/cart-drawer";

const m = getMessages().storefront.header;

export const ALL_PRODUCTS_HREF = "/magazin";

export interface StoreHeaderProps {
  storeName: string;
  logoUrl: string | null;
  menu: MenuNode[];
  phone: string;
  slots: { search: SlotState; cart: SlotState; wishlist: SlotState };
  /** `default`: bară opacă; `glass`: translucid cu estompare, hero-ul paginii urcă sub el (regula din `storefront-tokens.css`). */
  variant?: HeaderVariant;
  /** Adresa contului (`/cont`: cere autentificare și trimite la login). */
  accountHref?: string;
  className?: string;
  /** Doar pentru galeria de design și teste: meniul (desktop) sau panoul (telefon) pornește deschis. */
  menuInitiallyOpen?: boolean;
  navInitiallyOpen?: boolean;
}

function toItems(menu: MenuNode[]): MegaMenuItem[] {
  return menu.map((node) => ({
    id: node.id,
    name: node.name,
    href: node.href,
    seeAllLabel: m.seeAllIn(node.name),
    children: node.children.map((child) => ({
      id: child.id,
      name: child.name,
      href: child.href,
      image: child.image
        ? { src: child.image.src, width: child.image.width, height: child.image.height }
        : null,
      children: child.children.map((grand) => ({
        id: grand.id,
        name: grand.name,
        href: grand.href,
      })),
    })),
  }));
}

/** Pictogramă de acțiune din header: legătură reală când e activă, buton dezactivat (cu explicație) până la faza ei. */
function HeaderAction({
  state,
  label,
  hint,
  href,
  children,
}: {
  state: SlotState;
  label: string;
  hint: string;
  href: string;
  children: ReactNode;
}) {
  if (state === "hidden") return null;
  const className = storeButtonVariants({ variant: "ghost", size: "icon" });
  if (state === "active") {
    return (
      <Link href={href} aria-label={label} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <span title={hint} className="inline-flex">
      <button
        type="button"
        aria-disabled="true"
        aria-label={`${label}. ${hint}`}
        className={className}
      >
        {children}
      </button>
    </span>
  );
}

/**
 * Header-ul vitrinei (docs/21 §2.3): logo, mega menu, căutare centrată, telefon, cont, favorite și coș. Nu conține niciun `h1`
 * (titlul îl pune fiecare pagină). Căutarea și coșul apar dezactivate până la fazele lor (`STOREFRONT_READINESS`), favoritele
 * doar cu steagul pornit: structură fără funcționalitate fictivă. Pe telefon, meniul e un panou din stânga, iar căutarea trece
 * pe un rând propriu sub bară.
 */
export function StoreHeader({
  storeName,
  logoUrl,
  menu,
  phone,
  slots,
  variant = "default",
  accountHref = "/cont",
  className,
  menuInitiallyOpen = false,
  navInitiallyOpen = false,
}: StoreHeaderProps) {
  const items = toItems(menu);
  const tel = telHref(phone);
  const searchDisabled = slots.search !== "active";
  return (
    <header
      // «sticlă»: umplutura, estomparea și marginea vin din tokenii `--sf-glass-*` (storefront-tokens.css), prin atributul `data-glass`
      {...(variant === "glass" ? { "data-glass": "" } : {})}
      className={cn(
        "sticky top-0 z-40 border-b border-line-subtle text-ink",
        variant !== "glass" && "bg-surface-page",
        className,
      )}
    >
      <Container className="flex h-(--sf-header-h) items-center gap-2 sm:gap-4 lg:gap-6">
        <MobileNav
          openLabel={m.openMenu}
          closeLabel={m.closeMenu}
          title={m.menuTitle}
          allLabel={m.allProducts}
          allHref={ALL_PRODUCTS_HREF}
          items={items}
          className="lg:hidden"
          initiallyOpen={navInitiallyOpen}
        />
        <Link
          href="/"
          className="inline-flex shrink-0 items-center rounded-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page"
        >
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- logo din Branding (https sau cale locală), cu dimensiune fixă
            <img src={logoUrl} alt={storeName} className="h-9 w-auto max-w-48" />
          ) : (
            <span className="heading-display text-xl">{storeName}</span>
          )}
        </Link>
        <nav aria-label={m.mainNav} className="hidden h-full lg:flex">
          <MegaMenu
            label={m.products}
            allLabel={m.allProducts}
            allHref={ALL_PRODUCTS_HREF}
            items={items}
            initiallyOpen={menuInitiallyOpen}
          />
        </nav>
        {searchDisabled ? (
          <StoreSearch
            label={m.searchLabel}
            placeholder={m.searchPlaceholder}
            disabled
            disabledHint={m.searchSoon}
            className="mx-auto hidden w-full max-w-xl flex-1 md:block"
          />
        ) : (
          <HeaderSearch className="mx-auto hidden w-full max-w-xl flex-1 md:block" />
        )}
        <div className="ml-auto flex items-center gap-1 md:ml-0">
          {tel ? (
            <a
              href={tel}
              className={cn(
                storeButtonVariants({ variant: "ghost" }),
                "hidden px-3 xl:inline-flex",
              )}
            >
              <Phone aria-hidden="true" className="size-5" />
              <span>{phone}</span>
              <span className="sr-only">{m.call(phone)}</span>
            </a>
          ) : null}
          <HeaderAction state="active" label={m.account} hint="" href={accountHref}>
            <User aria-hidden="true" className="size-6" />
          </HeaderAction>
          <HeaderAction
            state={slots.wishlist}
            label={m.wishlist}
            hint={m.wishlistSoon}
            href="/cont/favorite"
          >
            <Heart aria-hidden="true" className="size-6" />
          </HeaderAction>
          {slots.cart === "active" ? (
            <HeaderCartButton />
          ) : (
            <HeaderAction state={slots.cart} label={m.cart} hint={m.cartSoon} href="/cos">
              <ShoppingBag aria-hidden="true" className="size-6" />
            </HeaderAction>
          )}
        </div>
      </Container>
      <Container className="pb-3 md:hidden">
        {searchDisabled ? (
          <StoreSearch
            label={m.searchLabel}
            placeholder={m.searchPlaceholder}
            disabled
            disabledHint={m.searchSoon}
          />
        ) : (
          <HeaderSearch />
        )}
      </Container>
    </header>
  );
}
