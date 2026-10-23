import { assertCan, type PermissionSubject } from "../rbac/can";
import type { VisibleStockState } from "./availability";
import type { StockMaintenance, WarehouseFreshness } from "./stock-maintenance";
import { StockError } from "./stock-errors";
import {
  buildStockOverviewRow,
  groupStockRows,
  type StockOverviewRow,
  type StockProductGroup,
  type StockRowKind,
} from "./stock-overview";
import type {
  StockMovementRow,
  StockOverviewStore,
  StockWarehouseRef,
} from "./stock-overview-store";

/**
 * Citirea pentru ecranul de stoc, cu drepturile: `inventory.read` pentru lista, o variantă și istoricul. Scrierea (ajustările)
 * cere `inventory.write` și trece prin `StockAdjustmentService`. Rândurile și grupurile sunt date structurate; textele din
 * ecran (etichete, plural, formatarea) sunt în aplicație.
 *
 * Filtrele de tip și de stare se aplică în memorie pe variantele găsite de căutare, până la `maxRows` (implicit 5000); peste
 * plafon rezultatul e marcat `truncated` și interfața cere o căutare mai precisă. (Optimizarea e pentru Faza 20.)
 */

export const STOCK_LIST_PAGE_SIZE = 25;
export const STOCK_MOVEMENTS_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_ROWS = 5000;
const MAX_SEARCH_LENGTH = 100;

export interface StockOverviewServiceSettings {
  lowStockSteps: number;
  defaultLeadTimeDays: number;
  snapshotStaleHours: number;
  /** Fusul orar al magazinului (`regional.timezone`), pentru afișarea orelor */
  timeZone: string;
}

export interface StockOverviewServiceDeps {
  store: StockOverviewStore;
  maintenance: Pick<StockMaintenance, "getSnapshotFreshness">;
  readSettings: () => Promise<StockOverviewServiceSettings>;
  maxRows?: number;
}

export interface StockOverviewQuery {
  search?: string;
  kind?: StockRowKind;
  state?: VisibleStockState;
  lowStockOnly?: boolean;
  page?: number;
  pageSize?: number;
  warehouseId?: string;
}

export interface StockOverviewPage {
  warehouse: StockWarehouseRef;
  freshness: WarehouseFreshness | null;
  /** Rândurile paginii, grupate pe produs, cu totalul calculat pe TOATE variantele produsului */
  groups: StockProductGroup[];
  rows: StockOverviewRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Căutarea a găsit mai multe variante decât plafonul; s-au luat primele */
  truncated: boolean;
  settings: StockOverviewServiceSettings;
}

export interface StockVariantDetail {
  row: StockOverviewRow;
  warehouse: StockWarehouseRef;
  freshness: WarehouseFreshness | null;
  settings: StockOverviewServiceSettings;
}

export interface StockMovementsPage {
  warehouse: StockWarehouseRef;
  rows: StockMovementRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const KINDS: readonly StockRowKind[] = ["managed", "unmanaged", "digital"];
const STATES: readonly VisibleStockState[] = ["in_stock", "limited", "on_order", "unavailable"];

/** Împărțire cu rotunjire în sus, pe întregi (fără `Math.ceil`: în stoc nu se folosește rotunjirea în virgulă mobilă). */
function ceilDiv(total: number, size: number): number {
  const sum = total + size - 1;
  return (sum - (sum % size)) / size;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Interogarea din adresa paginii (`?q=&tip=&stare=&mic=1&pagina=`): valorile valide se păstrează, cele invalide se ignoră
 * (o adresă veche sau greșită nu trebuie să dea eroare).
 */
export function parseStockOverviewQuery(
  raw: Record<string, string | string[] | undefined>,
): StockOverviewQuery {
  const query: StockOverviewQuery = {};
  const search = firstOf(raw["q"])?.trim().slice(0, MAX_SEARCH_LENGTH);
  if (search) query.search = search;
  const kind = firstOf(raw["tip"]);
  if (kind && (KINDS as readonly string[]).includes(kind)) query.kind = kind as StockRowKind;
  const state = firstOf(raw["stare"]);
  if (state && (STATES as readonly string[]).includes(state))
    query.state = state as VisibleStockState;
  if (firstOf(raw["mic"]) === "1") query.lowStockOnly = true;
  const page = firstOf(raw["pagina"]);
  if (page && /^[1-9][0-9]{0,6}$/.test(page)) query.page = Number.parseInt(page, 10);
  return query;
}

export class StockOverviewService {
  private readonly maxRows: number;

  constructor(private readonly deps: StockOverviewServiceDeps) {
    this.maxRows = deps.maxRows ?? DEFAULT_MAX_ROWS;
  }

  private async resolveWarehouse(warehouseId: string | undefined): Promise<StockWarehouseRef> {
    const warehouse = warehouseId
      ? await this.deps.store.warehouse(warehouseId)
      : await this.deps.store.defaultWarehouse();
    if (!warehouse) {
      throw new StockError("STOCK_NO_WAREHOUSE", "Depozitul nu există", {
        ...(warehouseId && { warehouseId }),
      });
    }
    return warehouse;
  }

  private async freshnessOf(
    warehouseId: string,
    settings: StockOverviewServiceSettings,
  ): Promise<WarehouseFreshness | null> {
    const all = await this.deps.maintenance.getSnapshotFreshness({
      staleHours: settings.snapshotStaleHours,
    });
    return all.find((entry) => entry.warehouseId === warehouseId) ?? null;
  }

  /** Lista variantelor cu stocul lor în depozit. Cere `inventory.read`. */
  async list(
    subject: PermissionSubject | null,
    query: StockOverviewQuery,
  ): Promise<StockOverviewPage> {
    assertCan(subject, "inventory.read");
    const settings = await this.deps.readSettings();
    const warehouse = await this.resolveWarehouse(query.warehouseId);
    const sources = await this.deps.store.loadSources({
      warehouseId: warehouse.id,
      ...(query.search && { search: query.search.slice(0, MAX_SEARCH_LENGTH) }),
      limit: this.maxRows + 1,
    });
    const truncated = sources.length > this.maxRows;
    const rowSettings = {
      defaultLowStockSteps: settings.lowStockSteps,
      defaultLeadTimeDays: settings.defaultLeadTimeDays,
    };
    const all = sources
      .slice(0, this.maxRows)
      .map((source) => buildStockOverviewRow(source, rowSettings));
    const filtered = all.filter(
      (row) =>
        (!query.kind || row.kind === query.kind) &&
        (!query.state || row.state === query.state) &&
        (!query.lowStockOnly || row.lowStock),
    );

    const pageSize = clamp(query.pageSize ?? STOCK_LIST_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const pageCount = Math.max(1, ceilDiv(filtered.length, pageSize));
    const page = clamp(query.page ?? 1, 1, pageCount);
    const rows = filtered.slice((page - 1) * pageSize, page * pageSize);

    // totalul unui produs se calculează pe toate variantele lui găsite de căutare, nu doar pe cele de pe pagină
    const full = new Map(groupStockRows(all).map((group) => [group.productId, group]));
    const groups = groupStockRows(rows).map((group) => {
      const whole = full.get(group.productId);
      return whole ? { ...group, total: whole.total, totalProblem: whole.totalProblem } : group;
    });

    return {
      warehouse,
      freshness: await this.freshnessOf(warehouse.id, settings),
      groups,
      rows,
      total: filtered.length,
      page,
      pageSize,
      pageCount,
      truncated,
      settings,
    };
  }

  /** O variantă, cu depozitul și prospețimea pozei. `null` dacă nu există (sau e în coșul de gunoi). Cere `inventory.read`. */
  async variant(
    subject: PermissionSubject | null,
    variantId: string,
    options: { warehouseId?: string } = {},
  ): Promise<StockVariantDetail | null> {
    assertCan(subject, "inventory.read");
    const settings = await this.deps.readSettings();
    const warehouse = await this.resolveWarehouse(options.warehouseId);
    const source = await this.deps.store.getSource(variantId, warehouse.id);
    if (!source) return null;
    return {
      row: buildStockOverviewRow(source, {
        defaultLowStockSteps: settings.lowStockSteps,
        defaultLeadTimeDays: settings.defaultLeadTimeDays,
      }),
      warehouse,
      freshness: await this.freshnessOf(warehouse.id, settings),
      settings,
    };
  }

  /** Istoricul mișcărilor unei variante într-un depozit, cele mai noi primele. Cere `inventory.read`. */
  async movements(
    subject: PermissionSubject | null,
    variantId: string,
    options: { page?: number; pageSize?: number; warehouseId?: string },
  ): Promise<StockMovementsPage> {
    assertCan(subject, "inventory.read");
    const warehouse = await this.resolveWarehouse(options.warehouseId);
    const pageSize = clamp(options.pageSize ?? STOCK_MOVEMENTS_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const first = await this.deps.store.listMovements({
      variantId,
      warehouseId: warehouse.id,
      limit: pageSize,
      offset: 0,
    });
    const pageCount = Math.max(1, ceilDiv(first.total, pageSize));
    const page = clamp(options.page ?? 1, 1, pageCount);
    const current =
      page === 1
        ? first
        : await this.deps.store.listMovements({
            variantId,
            warehouseId: warehouse.id,
            limit: pageSize,
            offset: (page - 1) * pageSize,
          });
    return { warehouse, rows: current.rows, total: first.total, page, pageSize, pageCount };
  }
}
