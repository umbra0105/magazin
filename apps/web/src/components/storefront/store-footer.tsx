import Link from "next/link";
import type { MenuNode } from "@ecom/core";
import { Container } from "@ecom/ui";
import { getMessages } from "@/messages";
import { FOOTER_INFO_LINKS, FOOTER_LEGAL_LINKS, telHref } from "@/lib/storefront-chrome-rules";
import { ALL_PRODUCTS_HREF } from "./store-header";

const m = getMessages().storefront.footer;

export interface StoreFooterProps {
  storeName: string;
  tagline: string;
  menu: MenuNode[];
  company: {
    legalName: string;
    vatId: string;
    tradeRegisterNo: string;
    address: string;
    phone: string;
    email: string;
  };
  /** Adresele ANPC, SAL și SOL din setări; un câmp gol nu produce legătură. */
  legal: { anpcUrl: string; salUrl: string; odrUrl: string };
  year: number;
}

const LINK =
  "rounded-sm text-ink-secondary transition-colors duration-(--motion) hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="font-semibold">{title}</h2>
      <ul className="mt-4 flex flex-col gap-2.5">{children}</ul>
    </div>
  );
}

/**
 * Footer-ul vitrinei (docs/21 §2.3): coloane de linkuri (categorii, informații, contact), datele firmei, linkurile legale și
 * ANPC / SAL / SOL din setări (cele goale nu apar). Toate sunt `<a href>`; categoriile din footer sunt și plasa de siguranță a
 * navigării fără JavaScript. Titlurile coloanelor sunt `h2` (pagina are un singur `h1`, pus de pagină).
 */
export function StoreFooter({ storeName, tagline, menu, company, legal, year }: StoreFooterProps) {
  const tel = telHref(company.phone);
  const external = [
    { key: "anpc", label: m.anpc, href: legal.anpcUrl },
    { key: "sal", label: m.sal, href: legal.salUrl },
    { key: "odr", label: m.odr, href: legal.odrUrl },
  ].filter((link) => /^https?:\/\//.test(link.href));
  return (
    <footer aria-label={m.label} className="mt-section bg-card text-ink">
      <Container className="grid gap-x-10 gap-y-10 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-1">
          <p className="heading-display text-xl">{storeName}</p>
          {tagline ? <p className="mt-2 max-w-xs text-ink-secondary">{tagline}</p> : null}
        </div>
        <Column title={m.shop}>
          {menu.slice(0, 7).map((node) => (
            <li key={node.id}>
              <Link href={node.href} className={LINK}>
                {node.name}
              </Link>
            </li>
          ))}
          <li>
            <Link href={ALL_PRODUCTS_HREF} className={`${LINK} font-medium text-link`}>
              {m.allProducts}
            </Link>
          </li>
        </Column>
        <Column title={m.info}>
          {FOOTER_INFO_LINKS.map((link) => (
            <li key={link.key}>
              <Link href={link.href} className={LINK}>
                {m.links[link.key]}
              </Link>
            </li>
          ))}
        </Column>
        <Column title={m.contact}>
          {tel ? (
            <li>
              <a href={tel} className={LINK}>
                {company.phone}
              </a>
            </li>
          ) : null}
          {company.email ? (
            <li>
              <a href={`mailto:${company.email}`} className={LINK}>
                {company.email}
              </a>
            </li>
          ) : null}
          {company.address ? <li className="text-ink-secondary">{company.address}</li> : null}
        </Column>
      </Container>
      <div className="border-t border-line-subtle">
        <Container className="flex flex-col gap-6 py-8 text-sm lg:flex-row lg:items-start lg:justify-between">
          <div className="flex flex-col gap-1 text-ink-secondary lg:w-1/3 lg:shrink-0">
            <p>{m.copyright(year, company.legalName || storeName)}</p>
            {company.vatId ? <p>{m.vatId(company.vatId)}</p> : null}
            {company.tradeRegisterNo ? <p>{m.tradeRegister(company.tradeRegisterNo)}</p> : null}
          </div>
          <nav aria-label={m.legal}>
            <ul className="flex flex-wrap gap-x-6 gap-y-2 lg:justify-end">
              {FOOTER_LEGAL_LINKS.map((link) => (
                <li key={link.key}>
                  <Link href={link.href} className={LINK}>
                    {m.links[link.key]}
                  </Link>
                </li>
              ))}
              {external.map((link) => (
                <li key={link.key}>
                  <a href={link.href} target="_blank" rel="noopener noreferrer" className={LINK}>
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </Container>
      </div>
    </footer>
  );
}
