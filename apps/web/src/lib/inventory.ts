import { MeasureUnitService, createPrismaMeasureUnitStore } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getAudit } from "./admin-writes";

const globalForInventory = globalThis as unknown as {
  __ecomMeasureUnits?: MeasureUnitService;
};

/** Unitățile de măsură (listă, creare, editare). Un singur serviciu per proces. */
export function getMeasureUnitService(): MeasureUnitService {
  globalForInventory.__ecomMeasureUnits ??= new MeasureUnitService({
    store: createPrismaMeasureUnitStore(getDb()),
    audit: getAudit(),
  });
  return globalForInventory.__ecomMeasureUnits;
}
