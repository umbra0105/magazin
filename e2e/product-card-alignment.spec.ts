import { expect, test } from "@playwright/test";

/**
 * Cardul de produs (Faza 7): prețul și starea de stoc stau pe aceeași linie la toate cardurile dintr-un rând, indiferent de
 * lungimea stării («La comandă · livrare în aproximativ 21 de zile» ocupă mai multe rânduri). Zona stării are înălțime rezervată,
 * deci prețul nu se ridică. Harness-ul are patru carduri (stare scurtă, lungă, scurtă, medie), în grilă ca lista reală.
 */
const WIDTHS = [390, 1440] as const;
const SCHEMES = ["light", "dark"] as const;

for (const width of WIDTHS) {
  for (const scheme of SCHEMES) {
    test(`prețul și starea stau pe aceeași linie în rând, la ${width}px, tema ${scheme === "light" ? "deschisă" : "închisă"}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      await page.goto("/harness-vitrina/carduri");
      const cards = page.locator("article");
      await expect(cards).toHaveCount(4);
      const boxes = await cards.evaluateAll((nodes) =>
        nodes.map((node) => {
          const price = node.querySelector("span.font-semibold")?.getBoundingClientRect();
          const status = node.querySelector("[data-status]")?.getBoundingClientRect();
          const card = node.getBoundingClientRect();
          return {
            row: Math.round(card.top),
            price: price ? Math.round(price.top * 10) / 10 : null,
            status: status ? Math.round(status.top * 10) / 10 : null,
          };
        }),
      );
      const rows = new Map<number, typeof boxes>();
      for (const box of boxes) rows.set(box.row, [...(rows.get(box.row) ?? []), box]);
      // la 390 px sunt două rânduri a câte două carduri, la 1440 px un singur rând de patru
      expect(rows.size).toBe(width === 390 ? 2 : 1);
      for (const row of rows.values()) {
        expect(row.length).toBeGreaterThan(1);
        const prices = new Set(row.map((b) => b.price));
        const statuses = new Set(row.map((b) => b.status));
        expect(
          prices.size,
          `prețurile dintr-un rând au aceeași poziție: ${JSON.stringify(row)}`,
        ).toBe(1);
        expect(
          statuses.size,
          `stările dintr-un rând au aceeași poziție: ${JSON.stringify(row)}`,
        ).toBe(1);
      }
      await context.close();
    });
  }
}
