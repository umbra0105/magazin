import {
  MeasureUnitService,
  StockAdjustmentService,
  StockMaintenance,
  StockOverviewService,
  StockService,
  createPrismaMeasureUnitStore,
  createPrismaStockOverviewStore,
  type StockOverviewServiceSettings,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getAudit } from "./admin-writes";
import { getSettings } from "./services";

const globalForInventory = globalThis as unknown as {
  __ecomMeasureUnits?: MeasureUnitService;
  __ecomStockOverview?: StockOverviewService;
  __ecomStockAdjustments?: StockAdjustmentService;
};

/** Unitățile de măsură (listă, creare, editare). Un singur serviciu per proces. */
export function getMeasureUnitService(): MeasureUnitService {
  globalForInventory.__ecomMeasureUnits ??= new MeasureUnitService({
    store: createPrismaMeasureUnitStore(getDb()),
    audit: getAudit(),
  });
  return globalForInventory.__ecomMeasureUnits;
}

/** Setările ecranului de stoc, citite din nou la fiecare cerere (se pot schimba din admin). */
async function readStockSettings(): Promise<StockOverviewServiceSettings> {
  const settings = getSettings();
  const [inventory, regional] = await Promise.all([
    settings.getGroup("inventory"),
    settings.getGroup("regional"),
  ]);
  return {
    lowStockSteps: inventory.lowStockSteps,
    defaultLeadTimeDays: inventory.defaultLeadTimeDays,
    snapshotStaleHours: inventory.snapshotStaleHours,
    timeZone: regional.timezone,
  };
}

/** Citirea pentru ecranul de stoc (lista, o variantă, istoricul). Cere `inventory.read`. */
export function getStockOverviewService(): StockOverviewService {
  globalForInventory.__ecomStockOverview ??= new StockOverviewService({
    store: createPrismaStockOverviewStore(getDb()),
    maintenance: new StockMaintenance({ db: getDb(), audit: getAudit() }),
    readSettings: readStockSettings,
  });
  return globalForInventory.__ecomStockOverview;
}

/** Ajustările manuale de stoc (permisiune `inventory.write`, validare și audit). */
export function getStockAdjustmentService(): StockAdjustmentService {
  globalForInventory.__ecomStockAdjustments ??= new StockAdjustmentService({
    stock: new StockService({ db: getDb() }),
    audit: getAudit(),
  });
  return globalForInventory.__ecomStockAdjustments;
}

export { readStockSettings };
