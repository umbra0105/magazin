import { ValidationError } from "@ecom/shared";
import { checkSaleConfig, effectiveSaleStep } from "../inventory/sale-config";
import type { ProductStore, SaleUnitRecord } from "./product-store";

/**
 * Validarea configurării de vânzare (unitate, pas, conversie SmartBill) a produselor și variantelor, pe valorile
 * EFECTIVE: unitatea și pasul unei variante vin de la ea, altfel de la produs, altfel «buc» și o unitate. Regulile
 * (pasul încape în zecimalele unității; orice comandă se convertește exact către SmartBill; stocul existent nu are
 * mai multe zecimale decât unitatea) sunt în `inventory/sale-config.ts`; aici se aplică pe date și se transformă în
 * `ValidationError` cu calea câmpului, ca formularul să arate mesajul sub câmpul greșit.
 */

export interface SaleProductView {
  measureUnitId: string | null;
  saleStep: number | null;
}

export interface SaleVariantView {
  id: string | null;
  sku: string;
  measureUnitId: string | null;
  saleStep: number | null;
  smartbillMode: string | null;
  smartbillRatio: number | null;
}

function invalid(path: string, message: string): ValidationError {
  return new ValidationError(`Date invalide: ${path}: ${message}`, { issues: [{ path, message }] });
}

const MAX_LISTED = 3;

export class SaleSetupValidator {
  private readonly units = new Map<string, SaleUnitRecord | null>();
  private defaultUnit: SaleUnitRecord | null | undefined;

  constructor(private readonly store: ProductStore) {}

  private async unit(id: string): Promise<SaleUnitRecord | null> {
    if (!this.units.has(id)) this.units.set(id, await this.store.getMeasureUnit(id));
    return this.units.get(id) ?? null;
  }

  private async fallbackUnit(): Promise<SaleUnitRecord | null> {
    if (this.defaultUnit === undefined) this.defaultUnit = await this.store.getDefaultMeasureUnit();
    return this.defaultUnit;
  }

  /** Unitatea efectivă a unei variante: a ei, apoi a produsului, apoi «buc» (0 zecimale dacă lipsește seed-ul). */
  private async effectiveUnit(
    variantUnitId: string | null,
    productUnitId: string | null,
  ): Promise<{ name: string; decimals: number }> {
    const id = variantUnitId ?? productUnitId;
    const unit = id === null ? await this.fallbackUnit() : await this.unit(id);
    return { name: unit?.name ?? "bucată", decimals: unit?.decimals ?? 0 };
  }

  /** Unitatea aleasă există și e activă (una dezactivată rămâne doar pe ce o avea deja). */
  async assertUnitAssignable(
    unitId: string | null | undefined,
    currentUnitId: string | null,
  ): Promise<void> {
    if (unitId === null || unitId === undefined) return;
    const unit = await this.unit(unitId);
    if (!unit) throw invalid("measureUnitId", "Unitatea de măsură aleasă nu mai există.");
    if (!unit.isActive && unitId !== currentUnitId) {
      throw invalid("measureUnitId", `Unitatea «${unit.name}» e dezactivată; alege alta.`);
    }
  }

  /**
   * Verifică fiecare variantă cu valorile efective. `forProduct`: cauza e o schimbare pe produs, deci eroarea merge
   * la câmpul produsului (`saleStep` sau `measureUnitId`) și numește variantele afectate (după SKU). Altfel
   * (`forProduct` nul) e o singură variantă, iar fiecare problemă merge la câmpul ei.
   */
  async validate(
    product: SaleProductView,
    variants: readonly SaleVariantView[],
    forProduct: { path: "saleStep" | "measureUnitId" } | null,
  ): Promise<void> {
    const problems: Array<{ path: string; message: string }> = [];
    for (const variant of variants) {
      const unit = await this.effectiveUnit(variant.measureUnitId, product.measureUnitId);
      const issues = checkSaleConfig({
        unitDecimals: unit.decimals,
        step: effectiveSaleStep(variant.saleStep, product.saleStep),
        smartbillMode: variant.smartbillMode,
        smartbillRatio: variant.smartbillRatio,
      });
      for (const issue of issues) {
        problems.push(
          forProduct
            ? { path: forProduct.path, message: `Varianta ${variant.sku}: ${issue.message}` }
            : { path: issue.path, message: issue.message },
        );
      }
    }
    if (problems.length === 0) return;

    const byPath = new Map<string, string[]>();
    for (const { path, message } of problems)
      byPath.set(path, [...(byPath.get(path) ?? []), message]);
    const issues = [...byPath.entries()].map(([path, messages]) => {
      const shown = messages.slice(0, MAX_LISTED).join(" ");
      const more = messages.length > MAX_LISTED ? ` (și încă ${messages.length - MAX_LISTED})` : "";
      return { path, message: `${shown}${more}` };
    });
    throw new ValidationError(
      `Date invalide: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      { issues },
    );
  }

  /** Stocul existent nu are mai multe zecimale decât permite unitatea efectivă a variantelor (la schimbarea unității). */
  async validateStockPrecision(
    product: SaleProductView,
    variants: ReadonlyArray<{ id: string | null; sku: string; measureUnitId: string | null }>,
  ): Promise<void> {
    const groups = new Map<
      number,
      { name: string; variants: Array<{ id: string; sku: string }> }
    >();
    for (const variant of variants) {
      if (variant.id === null) continue;
      const unit = await this.effectiveUnit(variant.measureUnitId, product.measureUnitId);
      if (unit.decimals >= 4) continue;
      const group = groups.get(unit.decimals) ?? { name: unit.name, variants: [] };
      group.variants.push({ id: variant.id, sku: variant.sku });
      groups.set(unit.decimals, group);
    }
    for (const [decimals, group] of groups) {
      const misfits = await this.store.findStockPrecisionMisfits(
        group.variants.map((v) => v.id),
        10n ** BigInt(4 - decimals),
      );
      const first = group.variants.find((v) => misfits.includes(v.id));
      if (first) {
        throw invalid(
          "measureUnitId",
          `Stocul variantei ${first.sku} are mai multe zecimale decât permite unitatea «${group.name}» (${decimals}). Ajustează întâi stocul.`,
        );
      }
    }
  }
}
