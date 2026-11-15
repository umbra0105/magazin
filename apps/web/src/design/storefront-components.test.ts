import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  HeroBanner,
  ProductCard,
  StoreButton,
  StoreImage,
  StoreSearch,
  TrustBar,
  storeButtonVariants,
} from "@ecom/ui";

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

const img = { src: "/media/x.webp", alt: "Piscină", width: 1600, height: 900 };

describe("StoreImage (imaginea LCP are prioritate, restul se încarcă târziu)", () => {
  it("cu `priority`: încărcare imediată și prioritate mare; dimensiunile explicite sunt mereu prezente", () => {
    const html = render(h(StoreImage, { ...img, priority: true }));
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchPriority="high"');
    expect(html).toContain('width="1600"');
    expect(html).toContain('height="900"');
    expect(html).toContain('alt="Piscină"');
  });

  it("fără `priority`: încărcare leneșă și decodare asincronă", () => {
    const html = render(h(StoreImage, img));
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).not.toContain("fetchPriority");
  });
});

describe("HeroBanner", () => {
  it("imaginea dată prin `image` e mereu LCP: eager + prioritate mare, nu poate fi leneșă", () => {
    const html = render(h(HeroBanner, { image: img, title: "Titlu" }));
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchPriority="high"');
    expect(html).not.toContain('loading="lazy"');
  });

  it("titlul e h1 implicit, h2 la cerere; expresia de accent e într-un singur span", () => {
    expect(render(h(HeroBanner, { image: img, title: "A", accent: "B" }))).toMatch(
      /<h1[^>]*>A <span[^>]*>B<\/span><\/h1>/,
    );
    const html = render(h(HeroBanner, { image: img, title: "A", titleAs: "h2" }));
    expect(html).toContain("<h2");
    expect(html).not.toContain("<h1");
  });

  it("nu are decât un titlu (un singur heading în componentă)", () => {
    const html = render(h(HeroBanner, { image: img, title: "A", lede: "x" }));
    expect(html.match(/<h[1-6]/g)).toHaveLength(1);
  });
});

describe("ProductCard", () => {
  const props = {
    href: "/produs/pompa",
    name: "Pompă",
    media: h(StoreImage, img),
    price: "100 lei",
  };

  it("are un singur link (titlul), deci tabulatorul oprește o dată pe produs", () => {
    const html = render(
      h(ProductCard, { ...props, brand: "M", status: { label: "În stoc", tone: "success" } }),
    );
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="/produs/pompa"');
  });

  it("nu calculează bani: afișează exact textul primit; prețul vechi e tăiat", () => {
    const html = render(h(ProductCard, { ...props, oldPrice: "120 lei" }));
    expect(html).toContain("100 lei");
    expect(html).toContain("<s ");
    expect(html).toContain("120 lei");
  });

  it("nivelul titlului se alege la folosire", () => {
    expect(render(h(ProductCard, { ...props, headingLevel: 2 }))).toContain("<h2");
    expect(render(h(ProductCard, props))).toContain("<h3");
  });
});

describe("StoreSearch", () => {
  it("formular GET cu role=search, funcționează fără JavaScript", () => {
    const html = render(h(StoreSearch, { label: "Caută", placeholder: "…" }));
    expect(html).toContain('role="search"');
    expect(html).toContain('method="get"');
    expect(html).toContain('action="/cautare"');
  });

  it("dezactivat: câmpul e disabled și explicația e pe formular", () => {
    const html = render(
      h(StoreSearch, { label: "Caută", placeholder: "…", disabled: true, disabledHint: "Curând" }),
    );
    expect(html).toContain("disabled");
    expect(html).toContain('title="Curând"');
  });
});

describe("TrustBar și butoane", () => {
  it("banda e o listă numită", () => {
    const html = render(
      h(TrustBar, {
        label: "Încredere",
        items: [
          { icon: null, title: "A" },
          { icon: null, title: "B" },
        ],
      }),
    );
    expect(html).toContain('aria-label="Încredere"');
    expect(html.match(/<li/g)).toHaveLength(2);
  });

  it("butonul are tip button implicit și poate fi aria-disabled", () => {
    const html = render(h(StoreButton, { "aria-disabled": true }, "OK"));
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-disabled="true"');
  });

  it("forma butonului vine din token (rounded-button), nu dintr-o rază fixă", () => {
    expect(storeButtonVariants()).toContain("rounded-button");
    expect(storeButtonVariants({ size: "icon" })).toContain("rounded-full");
  });
});
