import { createHash } from "node:crypto";
import { ValidationError } from "@ecom/shared";
import { foldText } from "../import-fields";
import type { ParsedTable } from "../import-file";
import {
  ImportMappingError,
  type ExistingVariant,
  type ImportCounts,
  type ImportMessage,
  type ImportPlan,
  type PlannedRow,
  type RowOutcome,
} from "../import-plan";
import { sanitizeDescription, summarizeDescriptionLosses } from "../../rich-text/description";
import { stripWpShortcodes } from "./html-to-text";
import { detectWooColumns, looksLikeWooExport, type WooRole } from "./woo-columns";
import { zeroStats, type WooSnapshot } from "./woo-plan";
import type { WooDescriptionInfo, WooOptions, WooUpdateOp } from "./woo-types";

/**
 * Planificarea modului «doar descrieri» al importului WooCommerce (15c, pasul 8): aceeași idee ca `planWoo` (funcție PURĂ,
 * aceeași pentru verificare și pentru aplicare), dar singurul lucru care se poate schimba este `Product.description`.
 *
 *  - produsul trebuie să EXISTE deja (după ID-ul din magazinul vechi, apoi după SKU); nu se creează produse, categorii,
 *    branduri sau atribute, nu se citesc prețuri, titluri, imagini;
 *  - celula goală nu șterge niciodată o descriere;
 *  - o descriere editată manual după ultimul import se păstrează, în afară de cazul în care se cere suprascrierea;
 *  - HTML-ul trece prin același sanitizator ca la importul obișnuit; peste limită, rândul se ignoră (nu se taie).
 */

type RowKind = "simple" | "variable" | "variation" | "other";

interface RowInfo {
  row: number;
  cells: readonly string[];
  id: string;
  kind: RowKind;
  rawType: string;
  rawSku: string;
  /** SKU-ul de căutare: cel din fișier sau `WC-<ID>` (la produsele simple). */
  sku: string;
}

const shortValue = (raw: string): string => (raw.length > 30 ? `${raw.slice(0, 30)}…` : raw);

export function planWooDescriptions(
  table: ParsedTable,
  options: Pick<WooOptions, "overwriteEditedDescriptions">,
  snapshot: WooSnapshot,
): ImportPlan {
  const columns = detectWooColumns(table.headers);
  if (!looksLikeWooExport(columns)) {
    throw new ImportMappingError(
      "IMPORT_MAPPING_INVALID",
      "Fișierul nu pare un export WooCommerce de produse (lipsesc coloanele ID, Tip, Nume sau Preț). " +
        "Alege profilul «Generic» sau exportă din nou din WooCommerce.",
    );
  }
  if (columns.roles.description === undefined) {
    throw new ImportMappingError(
      "IMPORT_MAPPING_INVALID",
      "Fișierul nu are coloana «Descriere»: nu e nimic de reimportat. Exportă din nou din WooCommerce, cu toate coloanele.",
    );
  }
  const extras = snapshot.woo;
  const stats = zeroStats();
  const fileWarnings: string[] = [
    ...table.warnings,
    "Mod «doar descrierile produselor existente»: se actualizează numai descrierea; produsele care nu există nu se creează, iar prețurile, titlurile, categoriile, brandurile, atributele și imaginile din fișier nu se citesc.",
  ];

  const at = (cells: readonly string[], role: WooRole): string => {
    const index = columns.roles[role];
    return index === undefined ? "" : (cells[index] ?? "").trim();
  };

  const rows: RowInfo[] = table.rows.map((cells, i) => {
    const rawType = at(cells, "type");
    const folded = foldText(rawType) || "simple";
    const kind: RowKind =
      folded === "simple" || folded === "variable" || folded === "variation" ? folded : "other";
    const id = at(cells, "id");
    const rawSku = at(cells, "sku");
    const sku = kind === "simple" ? rawSku || (id ? `WC-${id}` : "") : rawSku;
    return { row: table.rowNumbers[i] as number, cells, id, kind, rawType, rawSku, sku };
  });

  // variațiile unui produs variabil (aceeași regulă ca la `planWoo`: «Părinte» = «id:<ID>», <ID> sau SKU-ul părintelui)
  const byId = new Map<string, RowInfo>();
  const variableBySku = new Map<string, RowInfo>();
  for (const r of rows) {
    if (r.id && !byId.has(r.id)) byId.set(r.id, r);
    if (r.kind === "variable" && r.rawSku) variableBySku.set(r.rawSku.toLowerCase(), r);
  }
  const kidsOf = new Map<RowInfo, RowInfo[]>();
  for (const r of rows) {
    if (r.kind !== "variation") continue;
    const raw = at(r.cells, "parent");
    if (!raw) continue;
    const idRef = /^(?:id:)?(\d+)$/i.exec(raw);
    const parent = idRef ? byId.get(idRef[1] as string) : variableBySku.get(raw.toLowerCase());
    if (parent) kidsOf.set(parent, [...(kidsOf.get(parent) ?? []), r]);
  }
  const variationRows = rows.filter((r) => r.kind === "variation").length;
  if (variationRows > 0) {
    fileWarnings.push(
      `${variationRows} ${variationRows === 1 ? "rând de variație nu apare" : "rânduri de variații nu apar"} în listă: descrierea aparține produsului variabil (rândul lui), nu variațiilor.`,
    );
  }

  const planned: PlannedRow[] = [];
  const seenProducts = new Map<string, number>();

  function emit(
    r: RowInfo,
    display: string,
    outcome: RowOutcome,
    messages: ImportMessage[],
    op: WooUpdateOp | null = null,
  ): void {
    planned.push({
      row: r.row,
      sku: display,
      outcome,
      messages,
      changed: outcome === "updated" ? ["Descriere"] : [],
      op,
    });
  }

  const warning = (text: string): ImportMessage => ({ level: "warning", text });

  for (const r of rows) {
    if (r.kind === "variation") continue;
    const fallbackDisplay = r.sku || (r.id ? `ID ${r.id}` : "");

    if (r.kind === "other") {
      emit(r, fallbackDisplay, "skipped", [
        warning(
          `Ignorat: tipul «${shortValue(r.rawType)}» nu este acceptat (doar simple, variable și variation)`,
        ),
      ]);
      continue;
    }

    // ------ produsul din magazin: după ID-ul din magazinul vechi, apoi după SKU (la variabile, după SKU-urile variațiilor)
    const candidates = r.kind === "simple" ? [r.sku] : (kidsOf.get(r)?.map((k) => k.sku) ?? []);
    const candidateSkus = candidates.filter((s) => s !== "");
    if (candidateSkus.length === 0 && !r.id) {
      emit(r, fallbackDisplay, "skipped", [
        warning("Ignorat: SKU și ID lipsă, rândul nu se poate identifica"),
      ]);
      continue;
    }

    let productId: string | null = (r.id && extras.productIdByLegacyId.get(r.id)) || null;
    let display = candidateSkus[0] ?? fallbackDisplay;
    let existing: ExistingVariant | null = null;
    if (productId === null) {
      const matches = candidateSkus
        .map((sku) => ({ sku, variant: snapshot.variantsBySku.get(sku.toLowerCase()) }))
        .filter((m): m is { sku: string; variant: ExistingVariant } => m.variant !== undefined);
      const products = new Set(matches.map((m) => m.variant.productId));
      if (products.size > 1) {
        emit(r, fallbackDisplay, "skipped", [
          warning("Ignorat: variațiile acestui produs aparțin unor produse diferite din magazin"),
        ]);
        continue;
      }
      const first = matches[0];
      if (first) {
        productId = first.variant.productId;
        existing = first.variant;
        display = first.sku;
      }
    } else {
      existing =
        candidateSkus
          .map((sku) => snapshot.variantsBySku.get(sku.toLowerCase()))
          .find((v) => v !== undefined && v.productId === productId) ?? null;
    }
    if (productId === null) {
      stats.productsNotFound += 1;
      emit(r, fallbackDisplay, "skipped", [
        warning(
          "Ignorat: produsul nu există în magazin; modul «doar descrieri» nu creează produse (importă-l întâi cu importul obișnuit)",
        ),
      ]);
      continue;
    }

    const info: WooDescriptionInfo | undefined = extras.descriptionInfo?.get(productId);
    if (info?.deleted || existing?.product.deleted) {
      emit(r, display, "skipped", [
        warning(
          "Ignorat: produsul e în coșul de gunoi; restaurează-l ca să-i poți actualiza descrierea",
        ),
      ]);
      continue;
    }

    // ------ descrierea din fișier
    const long = at(r.cells, "description");
    if (long === "") {
      emit(r, display, "unchanged", []); // celula goală nu șterge niciodată descrierea din magazin
      continue;
    }
    const first = seenProducts.get(productId);
    if (first !== undefined) {
      emit(r, display, "skipped", [
        warning(
          `Ignorat: același produs apare și la rândul ${first} din fișier; se folosește primul`,
        ),
      ]);
      continue;
    }
    seenProducts.set(productId, r.row);

    const messages: ImportMessage[] = [];
    const stripped = stripWpShortcodes(long);
    stats.descriptionShortcodes += stripped.count;
    let next: string | null;
    try {
      const result = sanitizeDescription(stripped.text);
      stats.descriptionTables += result.stats.tables;
      stats.descriptionLinks += result.stats.links;
      stats.descriptionImages += result.stats.removedImages;
      const losses = summarizeDescriptionLosses(result.stats, stripped.count);
      if (losses) {
        stats.descriptionsSanitized += 1;
        messages.push(warning(`Descriere: HTML curățat, eliminat: ${losses}`));
      }
      next = result.html;
    } catch (error) {
      // peste limită: nu se taie (HTML tăiat ar fi stricat); descrierea din magazin rămâne
      if (!(error instanceof ValidationError)) throw error;
      stats.descriptionsOverLimit += 1;
      emit(r, display, "skipped", [
        warning(`Descriere: ${error.message}; descrierea nu a fost importată`),
      ]);
      continue;
    }
    if (next === null) {
      messages.push(
        warning("Descriere: după curățare nu a rămas nimic; descrierea din magazin rămâne"),
      );
      emit(r, display, "unchanged", messages);
      continue;
    }

    const current = info ? info.description : (existing?.product.description ?? null);
    if (next === current) {
      emit(r, display, "unchanged", messages);
      continue;
    }
    if (info?.manuallyEdited && !options.overwriteEditedDescriptions) {
      stats.descriptionsKeptEdited += 1;
      messages.push(
        warning(
          "Descriere: editată manual după import; se păstrează descrierea din magazin (bifează suprascrierea ca s-o înlocuiești)",
        ),
      );
      emit(r, display, "skipped", messages);
      continue;
    }
    if (info?.noHistory && !options.overwriteEditedDescriptions) {
      stats.descriptionsKeptNoHistory += 1;
      messages.push(
        warning(
          "Descriere: fără istoric, protejat; nu se știe cine a scris descrierea din magazin, deci se păstrează (bifează suprascrierea ca s-o înlocuiești)",
        ),
      );
      emit(r, display, "skipped", messages);
      continue;
    }
    emit(r, display, "updated", messages, {
      kind: "woo-update",
      productId,
      variantId: null,
      productPatch: { description: next },
      variantPatch: null,
      legacyProduct: null,
      legacyVariant: null,
      attributeValues: [],
      relations: [],
    });
  }

  const ordered = planned.sort((a, b) => a.row - b.row);
  const counts: ImportCounts = {
    new: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    errors: 0,
    warnings: 0,
  };
  for (const row of ordered) {
    if (row.outcome === "updated") counts.updated++;
    else if (row.outcome === "unchanged") counts.unchanged++;
    else if (row.outcome === "skipped") counts.skipped++;
    counts.warnings += row.messages.filter((m) => m.level === "warning").length;
  }

  const rowTypes: Record<string, number> = {};
  for (const r of rows) {
    const label = r.kind === "other" ? foldText(r.rawType) || "(necunoscut)" : r.kind;
    rowTypes[label] = (rowTypes[label] ?? 0) + 1;
  }

  const fingerprint = createHash("sha256")
    .update(JSON.stringify(["descriptions", ordered.map((r) => [r.row, r.sku, r.outcome, r.op])]))
    .digest("hex");

  return {
    rows: ordered,
    counts,
    fileWarnings,
    fingerprint,
    woo: {
      images: {
        enabled: false,
        tasks: [],
        issues: [],
        stats: {
          total: 0,
          accepted: 0,
          rejected: 0,
          alreadyInLibrary: 0,
          alreadyAttached: 0,
          ignoredOnVariations: 0,
          byHost: {},
          rejectedByReason: {},
        },
      },
      creations: { categories: [], brands: [], attributes: [] },
      refs: { categoryId: {}, brandId: {}, attributeId: {} },
      stats,
      rowTypes,
      ignoredColumns: [],
      blockedColumns: [],
      descriptionsOnly: true,
    },
  };
}
