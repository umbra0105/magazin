import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AnnouncementBar,
  HeroBanner,
  ProductCard,
  StoreButton,
  StoreImage,
  StoreSearch,
  StoreSkeleton,
  StorefrontLoading,
  StorefrontState,
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

describe("AnnouncementBar (bara de anunț)", () => {
  it("fără destinație: doar text, fără link; cu cale locală: un singur link, fără target", () => {
    const plain = render(h(AnnouncementBar, { text: "Livrare gratuită" }));
    expect(plain).toContain("Livrare gratuită");
    expect(plain).not.toContain("<a ");
    const local = render(h(AnnouncementBar, { text: "Oferte", href: "/oferte" }));
    expect(local.match(/<a /g)).toHaveLength(1);
    expect(local).toContain('href="/oferte"');
    expect(local).not.toContain("target=");
  });

  it("adresa https externă se deschide în filă nouă, cu rel de siguranță", () => {
    const html = render(h(AnnouncementBar, { text: "Vezi", href: "https://exemplu.ro/x" }));
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("textul se afișează ca text (nu se interpretează ca HTML) și bara e o regiune numită", () => {
    const html = render(h(AnnouncementBar, { text: "<b>x</b>", label: "Anunț" }));
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).toContain('aria-label="Anunț"');
  });

  it("tonul alege culorile din tokeni, fără valori fixe", () => {
    expect(render(h(AnnouncementBar, { text: "a", tone: "brand" }))).toContain("bg-action");
    expect(render(h(AnnouncementBar, { text: "a", tone: "neutral" }))).toContain("bg-card");
    expect(render(h(AnnouncementBar, { text: "a" }))).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe("ProductCard: zona de imagine uniformă", () => {
  const props = { href: "/produs/p", name: "P", media: h(StoreImage, img), price: "1 leu" };

  it("masa foto din token, aceeași umplutură și încadrare întreagă (object-contain), în ambele layouturi", () => {
    for (const layout of ["vertical", "horizontal"] as const) {
      const html = render(h(ProductCard, { ...props, layout }));
      expect(html, layout).toContain("bg-media");
      expect(html, layout).toContain("p-4");
      expect(html, layout).toContain("object-contain");
      expect(html, layout).not.toContain("object-cover");
      // fundalul alb al fotografiei se contopește cu masa foto (nu rămâne un dreptunghi alb)
      expect(html, layout).toContain("mix-blend-multiply");
      // fundalul zonei nu mai e culoarea paginii: acolo fotografiile albe ieșeau ca pătrate pe card
      expect(html, layout).not.toContain("bg-surface-page");
    }
  });
});

describe("ProductCard: layout orizontal (listă)", () => {
  const props = { href: "/produs/p", name: "P", media: h(StoreImage, img), price: "1 leu" };

  it("vertical e implicit; orizontal pune imaginea lângă text și rămâne cu un singur link", () => {
    const vertical = render(h(ProductCard, props));
    expect(vertical).toContain("flex-col");
    const horizontal = render(h(ProductCard, { ...props, layout: "horizontal" }));
    expect(horizontal).toContain('data-layout="horizontal"');
    expect(horizontal.match(/<a /g)).toHaveLength(1);
  });
});

describe("HeroBanner: marcaj pentru header-ul transparent", () => {
  it("secțiunea poartă data-hero, ca header-ul «sticlă» să o poată trage sub el", () => {
    expect(render(h(HeroBanner, { image: img, title: "A" }))).toContain("data-hero");
  });
});

describe("StorefrontState (404, 500, mentenanță)", () => {
  it("are exact un h1 cu titlul, descrierea și acțiunile", () => {
    const html = render(
      h(StorefrontState, {
        title: "Pagina nu a fost găsită",
        description: "Adresa nu există.",
        actions: h("a", { href: "/" }, "Acasă"),
      }),
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Pagina nu a fost găsită");
    expect(html).toContain("Adresa nu există.");
    expect(html).toContain('href="/"');
  });

  it("starea de eroare e anunțată cititoarelor de ecran (role=alert), cea obișnuită nu", () => {
    expect(render(h(StorefrontState, { title: "x", role: "alert" }))).toContain('role="alert"');
    expect(render(h(StorefrontState, { title: "x" }))).not.toContain("role=");
  });

  it("culorile vin din tokeni (fără valori fixe)", () => {
    expect(render(h(StorefrontState, { title: "x" }))).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});

describe("StorefrontLoading (schelete)", () => {
  it("o regiune `status` cu textul de încărcare pentru cititoarele de ecran și blocuri ascunse lor", () => {
    const html = render(h(StorefrontLoading, { label: "Se încarcă…" }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Se încarcă…");
    expect(html).toContain("sr-only");
    // blocurile de schelet nu sunt citite
    expect((html.match(/aria-hidden="true"/g) ?? []).length).toBeGreaterThan(3);
  });

  it("animația de puls se oprește la prefers-reduced-motion (motion-safe) și nu are text vizibil în blocuri", () => {
    const block = render(h(StoreSkeleton, { className: "h-4 w-40" }));
    expect(block).toContain("motion-safe:animate-pulse");
    expect(block).toContain("bg-card");
    expect(block).toContain("h-4 w-40");
  });

  it("nu conține niciun heading (titlul paginii îl pune pagina)", () => {
    expect(render(h(StorefrontLoading, { label: "x" }))).not.toMatch(/<h[1-6]/);
  });
});
