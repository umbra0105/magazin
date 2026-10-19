import { z } from "zod";
import { DomainError, getLogger } from "@ecom/shared";
import type { AuditService } from "../../audit/audit-service";
import { assertCan, type PermissionSubject } from "../../rbac/can";
import { parseProductListQuery } from "../product-list";
import { exportHeaders, productRows, type ExportRow } from "./export-rows";
import type { ExportScope, ListFilters, ProductExportStore } from "./export-store";

/**
 * Exportul de produse (CSV sau XLSX). Cere `products.export` (nu `products.read`: ar permite oricărui rol
 * cu acces la catalog, de ex. Depozit sau Editor, să scoată tot catalogul, cu ciorne și date interne).
 *
 * - Domeniu: produsele selectate, cele care respectă filtrele curente, sau tot catalogul; coșul de gunoi
 *   e exclus, în afară de cazul în care se cere explicit (sau se exportă din vederea lui).
 * - Limită de rânduri (setarea `productExport.maxRows`): peste ea exportul se REFUZĂ cu un mesaj clar,
 *   înainte să curgă vreun octet (fișierul ajunge direct în browser; un job în fundal ar cere stocare,
 *   notificare și curățare, fără câștig la mărimea unui catalog de magazin).
 * - Un singur eveniment de audit `product.export`, cu NUMERE (rânduri, produse, format, domeniu), fără
 *   valori din catalog. Se scrie la sfârșitul fluxului (succes) sau la întrerupere/eroare (`failed`).
 * - Prețul de achiziție nu se exportă, pentru nimeni: datele vin din `export-store.ts`, care nu îl selectează.
 */

export class ExportError extends DomainError {}

export const EXPORT_FORMATS = ["csv", "xlsx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const MAX_EXPORT_SELECTION = 200;

const filterKeys = z.enum(["q", "category", "brand", "status", "shipping", "stock", "view"]);

export const exportRequestSchema = z.strictObject({
  format: z.enum(EXPORT_FORMATS),
  scope: z.enum(["selection", "filters", "all"]),
  /** Doar pentru `selection`. */
  ids: z.array(z.string().min(1).max(40)).max(MAX_EXPORT_SELECTION).optional(),
  /** Parametrii listei (aceiași ca în URL); necunoscutele se ignoră. Doar pentru `filters`. */
  filters: z.partialRecord(filterKeys, z.string().max(100)).optional(),
  includeTrash: z.boolean().default(false),
});
export type ExportRequestInput = z.input<typeof exportRequestSchema>;

export interface ProductExportSettings {
  maxRows: number;
}

export interface ProductExportDeps {
  store: ProductExportStore;
  audit: AuditService;
  getSettings: () => Promise<ProductExportSettings>;
  /** Fusul orar al magazinului (setarea `regional.timezone`). */
  getTimezone: () => Promise<string>;
  now?: () => Date;
  logger?: Pick<ReturnType<typeof getLogger>, "error">;
}

/** Un export pregătit: verificat și numărat, gata să curgă. */
export interface PreparedExport {
  format: ExportFormat;
  fileName: string;
  headers: string[];
  /** Rândurile de date, pe măsură ce se citesc din bază. Auditul se scrie la sfârșitul iterării. */
  rows: AsyncGenerator<ExportRow>;
  counts: { rows: number; products: number; withoutVariants: number };
  /** Descrierea exportului, pentru foaia «Despre export» a XLSX-ului. */
  about: ExportAbout;
}

export interface ExportAbout {
  exportedAt: string;
  scope: string;
  filters: string[];
  trash: string;
  rows: number;
  products: number;
  withoutVariants: number;
}

const BATCH_SIZE = 200;

const SCOPE_LABELS = {
  selection: "Produsele selectate",
  filters: "Produsele care respectă filtrele curente",
  all: "Tot catalogul",
} as const;

const STATUS_LABELS: Record<string, string> = {
  draft: "Ciornă",
  active: "Activ",
  archived: "Arhivat",
};
const SHIPPING_LABELS: Record<string, string> = {
  standard: "Standard",
  oversized: "Supradimensionat",
  pallet: "Paletizat",
};
const STOCK_LABELS: Record<string, string> = {
  instock: "În stoc",
  outofstock: "Stoc epuizat",
  onbackorder: "La comandă",
};

/** Un export din istoric (citit din evenimentele de audit `product.export`; doar numere, fără valori din catalog). */
export interface ExportHistoryItem {
  id: string;
  at: Date;
  actorLabel: string | null;
  /** `downloaded` = exportul a curs până la capăt; `interrupted` = întrerupt sau eșuat; `refused` = refuzat. */
  state: "downloaded" | "interrupted" | "refused";
  format: string | null;
  scope: string | null;
  rows: number | null;
  products: number | null;
  includeTrash: boolean;
  filtered: boolean;
  /** Motivul unui refuz sau al unei întreruperi (cod scurt, nu valori). */
  reason: string | null;
}

export class ProductExportService {
  constructor(private readonly deps: ProductExportDeps) {}

  /** Ultimele exporturi (cele mai noi întâi), din jurnalul de audit. Cere `products.export`. */
  async history(subject: PermissionSubject | null, limit = 100): Promise<ExportHistoryItem[]> {
    assertCan(subject, "products.export");
    const rows = await this.deps.audit.list({ entity: "product_export", limit });
    return rows
      .filter((row) => row.action === "product.export")
      .map((row): ExportHistoryItem => {
        const after = (row.after ?? {}) as Record<string, unknown>;
        const text = (key: string): string | null =>
          typeof after[key] === "string" ? (after[key] as string) : null;
        const num = (key: string): number | null =>
          typeof after[key] === "number" ? (after[key] as number) : null;
        return {
          id: row.id,
          at: row.createdAt,
          actorLabel: row.actorLabel,
          state:
            row.outcome === "success"
              ? "downloaded"
              : row.outcome === "denied"
                ? "refused"
                : "interrupted",
          format: text("format"),
          scope: text("scope"),
          rows: num("rows"),
          products: num("products"),
          includeTrash: after["includeTrash"] === true,
          filtered: after["filtered"] === true,
          reason: text("reason"),
        };
      });
  }

  /**
   * Verifică permisiunea și cererea, numără rândurile, refuză exporturile goale sau peste limită, apoi
   * întoarce exportul gata să curgă. Aruncă `ExportError` (cod stabil + mesaj în română) sau erorile de
   * autorizare ale `assertCan`.
   */
  async prepare(subject: PermissionSubject | null, input: unknown): Promise<PreparedExport> {
    assertCan(subject, "products.export");
    const parsed = exportRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new ExportError("EXPORT_INVALID", "Cererea de export nu este validă");
    }
    const request = parsed.data;
    const { scope, filters } = this.resolveScope(request);
    const settings = await this.deps.getSettings();
    const counts = await this.deps.store.count(scope);

    if (counts.variants === 0) {
      throw new ExportError(
        "EXPORT_EMPTY",
        "Nu există produse de exportat cu aceste criterii. Schimbă selecția sau filtrele.",
      );
    }
    if (counts.variants > settings.maxRows) {
      throw new ExportError(
        "EXPORT_TOO_MANY_ROWS",
        `Exportul ar avea ${counts.variants} de rânduri, iar limita este ${settings.maxRows}. ` +
          "Restrânge-l cu filtre (categorie, brand, stare) sau exportă selecția pe părți.",
        { rows: counts.variants, max: settings.maxRows },
      );
    }

    const timezone = await this.deps.getTimezone();
    const format = (date: Date): string => formatTimestamp(date, timezone);
    const now = (this.deps.now ?? (() => new Date()))();
    const trashIncluded = scope.kind !== "selection" && this.includesTrash(scope);
    const about: ExportAbout = {
      exportedAt: format(now),
      scope: SCOPE_LABELS[scope.kind],
      filters: filters ? await this.describeFilters(filters) : [],
      trash:
        scope.kind === "selection"
          ? "Produsele alese, oricare ar fi starea lor"
          : scope.kind === "filters" && scope.query.view === "deleted"
            ? "Doar coșul de gunoi"
            : trashIncluded
              ? "Inclus"
              : "Exclus",
      rows: counts.variants,
      products: counts.products,
      withoutVariants: 0,
    };

    const summary = {
      format: request.format,
      scope: scope.kind,
      includeTrash: trashIncluded,
      filtered: Boolean(filters && Object.keys(filters).length > 0),
    };
    const stamp = now.toISOString().slice(0, 10);
    const base = `export-produse-${stamp}`;
    const fileName = request.format === "csv" ? `${base}.csv` : `${base}.xlsx`;

    const prepared: PreparedExport = {
      format: request.format,
      fileName,
      headers: exportHeaders(),
      counts: { rows: counts.variants, products: counts.products, withoutVariants: 0 },
      about,
      rows: this.stream(subject as PermissionSubject, scope, format, summary, (stats) => {
        // produsele fără nicio variantă n-au SKU și n-au rânduri: se numără, pentru foaia «Despre export»
        prepared.counts.withoutVariants = stats.withoutVariants;
        about.withoutVariants = stats.withoutVariants;
      }),
    };
    return prepared;
  }

  private resolveScope(request: z.output<typeof exportRequestSchema>): {
    scope: ExportScope;
    filters: Record<string, string> | null;
  } {
    if (request.scope === "selection") {
      const ids = [...new Set(request.ids ?? [])];
      if (ids.length === 0) {
        throw new ExportError("EXPORT_EMPTY", "Nu ai selectat niciun produs");
      }
      return { scope: { kind: "selection", ids }, filters: null };
    }
    if (request.scope === "all") {
      return { scope: { kind: "all", includeTrash: request.includeTrash }, filters: null };
    }
    const raw = request.filters ?? {};
    return {
      scope: { kind: "filters", query: listFilters(raw), includeTrash: request.includeTrash },
      filters: raw,
    };
  }

  private includesTrash(scope: Exclude<ExportScope, { kind: "selection" }>): boolean {
    return scope.kind === "filters" && scope.query.view === "deleted" ? true : scope.includeTrash;
  }

  private async describeFilters(raw: Record<string, string>): Promise<string[]> {
    const query = listFilters(raw);
    const labels = await this.deps.store.filterLabels(query);
    const lines: string[] = [];
    if (query.q) lines.push(`Căutare: ${query.q}`);
    if (query.categoryId) {
      lines.push(`Categorie: ${labels.category ?? "(necunoscută)"} (și subcategoriile ei)`);
    }
    if (query.brandId) lines.push(`Brand: ${labels.brand ?? "(necunoscut)"}`);
    if (query.status) lines.push(`Stare: ${STATUS_LABELS[query.status] ?? query.status}`);
    if (query.shippingClass) {
      lines.push(
        `Clasă de livrare: ${SHIPPING_LABELS[query.shippingClass] ?? query.shippingClass}`,
      );
    }
    if (query.stock) lines.push(`Stoc: ${STOCK_LABELS[query.stock] ?? query.stock}`);
    return lines;
  }

  /**
   * Fluxul de rânduri. La sfârșitul normal scrie auditul `success`; dacă consumatorul se oprește înainte
   * (clientul a închis descărcarea) sau citirea eșuează, scrie `failed` cu numărul de rânduri trimise.
   */
  private async *stream(
    subject: PermissionSubject,
    scope: ExportScope,
    format: (date: Date) => string,
    summary: Record<string, unknown>,
    onFinish: (stats: { withoutVariants: number }) => void,
  ): AsyncGenerator<ExportRow> {
    let rows = 0;
    let products = 0;
    let withoutVariants = 0;
    let completed = false;
    try {
      for await (const batch of this.deps.store.batches(scope, BATCH_SIZE)) {
        for (const product of batch) {
          products += 1;
          const produced = productRows(product, format);
          if (produced.length === 0) withoutVariants += 1;
          for (const row of produced) {
            rows += 1;
            yield row;
          }
        }
      }
      completed = true;
    } finally {
      onFinish({ withoutVariants });
      await this.record(subject, completed, { ...summary, rows, products, withoutVariants });
    }
  }

  private async record(
    subject: PermissionSubject,
    completed: boolean,
    after: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "product.export",
        entity: "product_export",
        entityId: null,
        outcome: completed ? "success" : "failed",
        after: completed ? after : { ...after, reason: "interrupted" },
      });
    } catch (error) {
      (this.deps.logger ?? getLogger()).error({ err: error }, "auditul exportului a eșuat");
    }
  }
}

/** Filtrele listei din parametrii ei brute (valorile nevalide se ignoră, ca în listă). */
function listFilters(raw: Record<string, string>): ListFilters {
  const query = parseProductListQuery(raw);
  return {
    q: query.q,
    categoryId: query.categoryId,
    brandId: query.brandId,
    status: query.status,
    shippingClass: query.shippingClass,
    stock: query.stock,
    view: query.view,
  };
}

/** «2026-10-17 14:35:07» în fusul magazinului. */
export function formatTimestamp(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return parts;
}
