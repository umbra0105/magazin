import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Counter,
  Dialog,
  Drawer,
  DrawerSection,
  EmptyState,
  Input,
  Label,
  Progress,
  SegmentedBar,
  Select,
  Skeleton,
  Table,
  TableCaption,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
  addToast,
  autoDismisses,
  removeToast,
  segmentShares,
  TOAST_LIMIT,
  useToast,
  type Segment,
  type ToastItem,
} from "@ecom/ui";

/**
 * Componentele din `@ecom/ui` (docs/17 §3), randate static: clasele de tokeni semantici, atributele de accesibilitate și logica
 * pură (starea notificărilor, părțile barei de stoc). Comportamentul în browser (focus, Esc, 560 px, notificări cu ceas, bara
 * laterală) e în `e2e/design-system.spec.ts`; valorile tokenilor, în `packages/core/src/branding/admin-tokens.test.ts`.
 */
const html = (element: ReactElement): string => renderToStaticMarkup(element);

describe("Button", () => {
  it("principalul e neutru (action), nu culoarea magazinului", () => {
    const out = html(h(Button, null, "Salvează"));
    expect(out).toContain("bg-action");
    expect(out).toContain("text-action-fg");
    expect(out).not.toMatch(/bg-primary|text-primary/);
    expect(out).toContain('type="button"');
  });

  it("secundar, terț și pericol au fiecare tokenii lor", () => {
    expect(html(h(Button, { variant: "outline" }, "x"))).toContain("border-line-control");
    expect(html(h(Button, { variant: "ghost" }, "x"))).toContain("hover:bg-surface-hover");
    const danger = html(h(Button, { variant: "destructive" }, "x"));
    expect(danger).toContain("text-tone-problem-fg");
    expect(danger).toContain("border-line-control");
  });

  it("înălțimea și mărimea textului vin din variabile (44/16 pe telefon, 36/14 de la md în sus)", () => {
    expect(html(h(Button, null, "x"))).toContain("h-(--control-h)");
    expect(html(h(Button, { size: "sm" }, "x"))).toContain("h-(--control-h-compact)");
    expect(html(h(Button, null, "x"))).toContain("text-(length:--button-text)");
    expect(html(h(Button, { size: "sm" }, "x"))).toContain("text-body");
  });

  it("inelul de focus e din brand și rămâne mereu vizibil la tastatură", () => {
    const out = html(h(Button, null, "x"));
    expect(out).toContain("focus-visible:ring-2");
    expect(out).toContain("focus-visible:ring-brand");
  });

  it("dezactivat: atributul ajunge pe buton", () => {
    expect(html(h(Button, { disabled: true }, "x"))).toContain("disabled");
  });
});

describe("câmpuri de formular", () => {
  it("Input: bordura de 3:1, text-model, rază, înălțime din variabilă, eroare din aria-invalid", () => {
    const out = html(h(Input, { placeholder: "Ex." }));
    expect(out).toContain("border-line-input");
    expect(out).toContain("placeholder:text-ink-placeholder");
    expect(out).toContain("h-(--control-h)");
    expect(out).toContain("text-(length:--control-text)");
    expect(out).toContain("aria-[invalid=true]:border-tone-problem-fg");
    expect(out).toContain("rounded-md");
  });

  it("Select și Textarea au același aspect ca Input", () => {
    for (const out of [html(h(Select)), html(h(Textarea))]) {
      expect(out).toContain("border-line-input");
      expect(out).toContain("text-(length:--control-text)");
    }
  });

  it("Label: 12 px, text secundar", () => {
    const out = html(h(Label, { htmlFor: "x" }, "Nume"));
    expect(out).toContain("text-label");
    expect(out).toContain("text-ink-secondary");
  });
});

describe("Badge și Counter", () => {
  it("fiecare dintre cele 5 tonuri folosește perechea lui fundal + text", () => {
    const cases = [
      ["neutral", "tone-neutral"],
      ["info", "tone-info"],
      ["success", "tone-success"],
      ["warning", "tone-warning"],
      ["danger", "tone-problem"],
    ] as const;
    for (const [variant, tone] of cases) {
      const out = html(h(Badge, { variant }, "Stare"));
      expect(out, variant).toContain(`bg-${tone}-bg`);
      expect(out, variant).toContain(`text-${tone}-fg`);
      expect(out).toContain("rounded-full");
      // mărimea de 12 px nu se pierde la îmbinarea cu clasa de culoare (cn cunoaște scara tipografică)
      expect(out).toContain("text-label");
      expect(out).not.toContain("border");
    }
  });

  it("textul stării se scrie mereu; punctul e decorativ (aria-hidden) și opțional", () => {
    const withDot = html(h(Badge, { dot: true }, "Neachitat"));
    expect(withDot).toContain("Neachitat");
    expect(withDot).toContain('aria-hidden="true"');
    expect(html(h(Badge, null, "Neachitat"))).not.toContain("aria-hidden");
  });

  it("Counter: brand cu text on-brand, cifre tabulare", () => {
    const out = html(h(Counter, null, "12"));
    expect(out).toContain("bg-brand");
    expect(out).toContain("text-on-brand");
    expect(out).toContain("text-label");
    expect(out).toContain("tabular-nums");
  });
});

describe("Card și Progress", () => {
  it("Card e plat: bordură fină, fără umbră", () => {
    const out = html(h(Card, null, "x"));
    expect(out).toContain("border-line-subtle");
    expect(out).not.toContain("shadow");
  });

  it("CardTitle: h1 e titlu de pagină, restul titlu de secțiune", () => {
    expect(html(h(CardTitle, { as: "h1" }, "T"))).toMatch(/<h1[^>]*text-title/);
    expect(html(h(CardTitle, null, "T"))).toMatch(/<h2[^>]*text-section/);
  });

  it("Progress: valoare limitată la 0–100 și nume accesibil", () => {
    const out = html(h(Progress, { value: 140, label: "Import" }));
    expect(out).toContain('aria-valuenow="100"');
    expect(out).toContain('aria-label="Import"');
    expect(html(h(Progress, { label: "x" }))).not.toContain("aria-valuenow");
  });
});

describe("Table", () => {
  const table = (rows: ReactElement[], compact = false) =>
    html(
      h(
        Table,
        { compact },
        h(TableCaption, null, "Produse"),
        h(THead, null, h("tr", null, h(Th, null, "Produs"), h(Th, { numeric: true }, "Preț"))),
        h(TBody, null, ...rows),
      ),
    );

  it("antetele au scope=col, antet pe suprafața subtilă, titlu doar pentru cititoare de ecran", () => {
    const out = table([]);
    expect(out).toContain('scope="col"');
    expect(out).toContain("bg-surface-subtle");
    expect(out).toMatch(/<caption[^>]*sr-only/);
  });

  it("cifrele se aliniază la dreapta cu cifre tabulare", () => {
    const out = table([
      h(Tr, { key: "a" }, h(Td, null, "Pompă"), h(Td, { numeric: true }, "1.499,00")),
    ]);
    expect(out).toMatch(/<th[^>]*text-right/);
    expect(out).toMatch(/<td[^>]*text-right tabular-nums/);
  });

  it("rând de 48 px, compact 40 px, fără linii verticale", () => {
    const out = table([h(Tr, { key: "a" }, h(Td, null, "x"))], true);
    expect(out).toContain("h-(--row-h)");
    expect(out).toContain("group-data-[density=compact]/table:h-(--row-h-compact)");
    expect(out).toContain('data-density="compact"');
    expect(out).toContain("border-b border-line-subtle");
    expect(out).not.toMatch(/border-[lr]\b/);
  });

  it("rândul selectat: aria-selected și fundal hover", () => {
    const out = table([h(Tr, { key: "a", selected: true }, h(Td, null, "x"))]);
    expect(out).toContain('aria-selected="true"');
    expect(out).toContain("bg-surface-hover");
    expect(table([h(Tr, { key: "a" }, h(Td, null, "x"))])).not.toContain("aria-selected");
  });

  it("se derulează orizontal în propria regiune", () => {
    expect(table([])).toMatch(/^<div class="[^"]*overflow-x-auto/);
  });
});

describe("Dialog și Drawer", () => {
  const noop = () => undefined;

  it("Dialog închis nu randează conținut; deschis are titlu legat de dialog", () => {
    const closed = html(
      h(Dialog, {
        open: false,
        onClose: noop,
        title: "Titlu",
        closeLabel: "Închide",
        children: "Corp",
      }),
    );
    expect(closed).not.toContain("Corp");
    const open = html(
      h(Dialog, {
        open: true,
        onClose: noop,
        title: "Titlu",
        closeLabel: "Închide",
        children: "Corp",
      }),
    );
    expect(open).toContain("Corp");
    expect(open).toMatch(/aria-labelledby="[^"]+"/);
    expect(open).toContain('aria-label="Închide"');
    expect(open).toContain("shadow-dialog");
    expect(open).toContain("backdrop:bg-scrim");
    expect(open).toContain("rounded-lg");
  });

  it("Dialog: lățimea maximă a apelantului o înlocuiește pe cea implicită", () => {
    const out = html(
      h(Dialog, {
        open: true,
        onClose: noop,
        title: "T",
        closeLabel: "x",
        className: "max-w-md",
        children: null,
      }),
    );
    expect(out).toContain("max-w-md");
    expect(out).not.toContain("max-w-2xl");
  });

  it("Drawer: săgeată înapoi cu nume, titlu, stare, acțiuni, secțiuni și acțiuni fixate jos", () => {
    const out = html(
      h(Drawer, {
        open: true,
        onClose: noop,
        title: "Comanda 1042",
        closeLabel: "Înapoi",
        status: h(Badge, null, "Achitat"),
        actions: h(Button, null, "Tipărește"),
        footer: h(Button, null, "Salvează"),
        children: h(DrawerSection, { title: "Rezumat", children: "Conținut" }),
      }),
    );
    expect(out).toContain('aria-label="Înapoi"');
    expect(out).toContain("Comanda 1042");
    expect(out).toContain("Achitat");
    expect(out).toContain("Tipărește");
    expect(out).toContain("<footer");
    expect(out).toContain("Rezumat");
    expect(out).toContain("shadow-drawer");
    expect(out).toContain("backdrop:bg-scrim");
    expect(out).toContain("md:w-(--drawer-w)");
    expect(out).toContain("w-full");
    expect(out).toContain("divide-line-subtle");
  });

  it("Drawer închis nu randează conținut", () => {
    const out = html(
      h(Drawer, { open: false, onClose: noop, title: "T", closeLabel: "x", children: "Corp" }),
    );
    expect(out).not.toContain("Corp");
  });
});

describe("stări: schelet și stare goală", () => {
  it("Skeleton e decorativ (aria-hidden), în fundal hover, cu puls doar fără mișcare redusă", () => {
    const out = html(h(Skeleton, { className: "h-4 w-40" }));
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain("bg-surface-hover");
    expect(out).toContain("motion-safe:animate-pulse");
  });

  it("EmptyState: titlu, o frază și o singură acțiune; fără acțiune sau frază nu apar goluri", () => {
    const full = html(
      h(EmptyState, {
        title: "Nu ai produse",
        description: "Adaugă primul.",
        action: h(Button, null, "Adaugă"),
      }),
    );
    expect(full).toMatch(/<h2[^>]*>Nu ai produse<\/h2>/);
    expect(full).toContain("Adaugă primul.");
    expect(full).toContain("Adaugă</button>");
    const bare = html(h(EmptyState, { title: "Gol", as: "h3" }));
    expect(bare).toMatch(/<h3[^>]*>Gol<\/h3>/);
    expect(bare).not.toContain("<p");
    expect(bare).not.toContain("<button");
  });
});

describe("SegmentedBar", () => {
  const segments: Segment[] = [
    { key: "ok", label: "În stoc", value: 1180, tone: "ok" },
    { key: "low", label: "Stoc mic", value: 87, tone: "low" },
    { key: "out", label: "Epuizat", value: 0, tone: "out" },
  ];

  it("părțile ignoră valorile nule, negative sau nefinite și însumează 1", () => {
    const shares = segmentShares([
      ...segments,
      { key: "neg", label: "n", value: -3, tone: "neutral" },
      { key: "nan", label: "n", value: Number.NaN, tone: "neutral" },
      { key: "inf", label: "n", value: Number.POSITIVE_INFINITY, tone: "neutral" },
    ]);
    expect(shares.map((s) => s.segment.key)).toEqual(["ok", "low"]);
    expect(shares.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 10);
    expect(shares[0]?.share).toBeCloseTo(1180 / 1267, 10);
  });

  it("fără niciun element, nu împarte la zero", () => {
    expect(segmentShares([{ key: "a", label: "a", value: 0, tone: "ok" }])).toEqual([]);
    expect(segmentShares([])).toEqual([]);
  });

  it("bara e o imagine cu rezumat în aria-label; legenda are punct, etichetă și număr (starea nu e doar culoare)", () => {
    const out = html(h(SegmentedBar, { segments, label: "Stocul produselor" }));
    expect(out).toContain('role="img"');
    expect(out).toMatch(/aria-label="Stocul produselor: În stoc 1\.180, Stoc mic 87, Epuizat 0"/);
    expect(out).toContain("În stoc");
    expect(out).toContain("1.180");
    expect(out).toContain("bg-chart-1");
    expect(out).toContain("bg-chart-2");
    expect(out).toContain("bg-chart-3");
    // segmentul cu valoare 0 nu apare în bară, dar rămâne în legendă
    expect(out).not.toContain('data-segment="out"');
    expect(out).toContain("h-1.5");
    expect(out).toContain("rounded-full");
  });
});

describe("starea notificărilor (pură)", () => {
  const toast = (id: string, tone: ToastItem["tone"]): ToastItem => ({ id, tone, title: id });

  it("doar eroarea rămâne până e închisă", () => {
    expect(autoDismisses("success")).toBe(true);
    expect(autoDismisses("info")).toBe(true);
    expect(autoDismisses("warning")).toBe(true);
    expect(autoDismisses("danger")).toBe(false);
  });

  it("adaugă la sfârșit și șterge după id", () => {
    const list = addToast([toast("a", "info")], toast("b", "success"));
    expect(list.map((t) => t.id)).toEqual(["a", "b"]);
    expect(removeToast(list, "a").map((t) => t.id)).toEqual(["b"]);
    expect(removeToast(list, "x")).toHaveLength(2);
  });

  it(`la depășirea limitei (${TOAST_LIMIT}) pleacă cea mai veche care oricum dispare singură; erorile se păstrează`, () => {
    let list: ToastItem[] = [toast("err", "danger")];
    for (const id of ["a", "b", "c"]) list = addToast(list, toast(id, "info"));
    expect(list).toHaveLength(TOAST_LIMIT);
    list = addToast(list, toast("d", "success"));
    expect(list.map((t) => t.id)).toEqual(["err", "b", "c", "d"]);
  });

  it("dacă toate sunt erori, nu se pierde nicio eroare", () => {
    let list: ToastItem[] = [];
    for (let n = 0; n < TOAST_LIMIT + 2; n += 1) list = addToast(list, toast(`e${n}`, "danger"));
    expect(list).toHaveLength(TOAST_LIMIT + 2);
  });

  it("useToast în afara unui ToastProvider aruncă o eroare clară", () => {
    const Probe = () => {
      useToast();
      return null;
    };
    expect(() => html(h(Probe))).toThrow(/ToastProvider/);
  });
});
