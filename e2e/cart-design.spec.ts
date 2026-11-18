import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Coșul, în cele 3 presets și ambele teme (Faza 8): invarianți de interfață pe galeria `/galerie-vitrina/cos` (date de probă):
 * fără derulare laterală, ținte tactile de cel puțin 44 px, un singur buton principal, cu starea goală, sertarul și zona de
 * cumpărare. Cu `CAPTURE_DIR=<cale>` scrie și capturile (390 și 1440 px) pentru autorevizuire; fără variabilă nu scrie nimic.
 */
const PRESETS = ["minimal", "bold", "editorial"] as const;
const THEMES = ["deschisa", "inchisa"] as const;
const ZONES = ["pagina", "sertar", "gol", "produs"] as const;
const WIDTHS = [390, 1440] as const;
const captureDir = process.env["CAPTURE_DIR"];
if (captureDir) mkdirSync(captureDir, { recursive: true });

for (const preset of PRESETS) {
  for (const tema of THEMES) {
    test.describe(`${preset} / ${tema}`, () => {
      for (const width of WIDTHS) {
        for (const zona of ZONES) {
          test(`${zona} la ${width} px`, async ({ page }) => {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
            await page.goto(`/galerie-vitrina/cos?preset=${preset}&tema=${tema}&zona=${zona}`);
            await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

            const overflow = await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow, "derulare laterală").toBeLessThanOrEqual(0);

            const small = await page
              .locator("[data-theme-preview] button, [data-theme-preview] input")
              .evaluateAll((nodes) =>
                nodes
                  .map((node) => node.getBoundingClientRect())
                  .filter((box) => box.width > 0 && box.height < 44)
                  .map((box) => `${Math.round(box.width)}×${Math.round(box.height)}`),
              );
            expect(small, "ținte tactile sub 44 px").toEqual([]);

            if (zona === "pagina" || zona === "sertar") {
              await expect(page.locator("[data-cart-panel] [data-checkout]")).toHaveText(
                "Finalizează comanda",
              );
              // un singur buton principal în coș (finalizarea); legăturile secundare au contur
              await expect(page.locator("[data-cart-panel] .bg-action")).toHaveCount(1);
            }
            if (zona === "gol") await expect(page.locator("[data-cart-empty]")).toBeVisible();
            if (zona === "produs") {
              await expect(page.locator("[data-add-button]")).toBeVisible();
              await expect(
                page.locator("[data-theme-preview] main .bg-action, [data-add-to-cart] .bg-action"),
              ).toHaveCount(1);
            }
            if (captureDir) {
              await page.screenshot({
                path: join(captureDir, `${zona}-${preset}-${tema}-${width}.png`),
                fullPage: true,
              });
            }
          });
        }
      }
    });
  }
}
