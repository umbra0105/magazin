import {
  MeasureUnitService,
  StockAdjustmentService,
  StockMaintenance,
  StockOverviewService,
  StockService,
  StockTransferService,
  WarehouseService,
  createPrismaMeasureUnitStore,
  createPrismaStockOverviewStore,
  createPrismaWarehouseStore,
  resolveWarehouseChoice,
  type PermissionSubject,
  type StockOverviewServiceSettings,
  type WarehouseChoice,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getAudit } from "./admin-writes";
import { getFeatureFlags, getSettings } from "./services";

const globalForInventory = globalThis as unknown as {
  __ecomMeasureUnits?: MeasureUnitService;
  __ecomStockOverview?: StockOverviewService;
  __ecomStockAdjustments?: StockAdjustmentService;
  __ecomWarehouses?: WarehouseService;
  __ecomStockTransfers?: StockTransferService;
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

/**
 * Depozitele (listă, creare, redenumire, dezactivare), în spatele steagului `multiWarehouse`: cu steagul oprit serviciul
 * refuză orice operație (`FEATURE_DISABLED`). Steagul se citește la fiecare apel, deci pornirea/oprirea se vede imediat.
 */
export function getWarehouseService(): WarehouseService {
  globalForInventory.__ecomWarehouses ??= new WarehouseService({
    store: createPrismaWarehouseStore(getDb()),
    audit: getAudit(),
    isEnabled: () => getFeatureFlags().isEnabled("multiWarehouse"),
  });
  return globalForInventory.__ecomWarehouses;
}

/**
 * Transferul unei variante între două depozite, în spatele steagului `multiWarehouse` (steagul oprit → `FEATURE_DISABLED`,
 * înaintea drepturilor). O singură tranzacție, două mișcări cu aceeași referință, audit.
 */
export function getStockTransferService(): StockTransferService {
  globalForInventory.__ecomStockTransfers ??= new StockTransferService({
    db: getDb(),
    audit: getAudit(),
    isEnabled: () => getFeatureFlags().isEnabled("multiWarehouse"),
  });
  return globalForInventory.__ecomStockTransfers;
}

/**
 * Depozitul afișat în Stoc și Istoric (13d): singurul loc care citește steagul pentru alegerea depozitului. Cu steagul oprit nu
 * citește depozitele și `?depozit=` se ignoră; selectorul apare doar cu cel puțin două depozite active.
 */
export async function getWarehouseChoice(
  subject: PermissionSubject,
  requested: string | string[] | undefined,
): Promise<WarehouseChoice> {
  return resolveWarehouseChoice({
    enabled: await getFeatureFlags().isEnabled("multiWarehouse"),
    requested,
    loadActive: () => getWarehouseService().listActive(subject),
  });
}

export { readStockSettings };
